'use strict';

/**
 * 「自己装新版」这条路的守卫。
 *
 * 这是整条自更新链里**唯一会改盘**的一步：在 profile 里跑一句它自己的包管理器。判错的后
 * 果不是「更新没生效」，是「装坏了别人的 DSH」——所以每一条判定都要有测试盯着：
 *
 *   · **退出码 0 不算数**：盘上的版本号真变了才算装上（市场那份代码吃过这个亏：报成功、
 *     代码没换）。这条专门有一条用例，把「只看退出码」的写法钉死。
 *   · **找不到包管理器就如实失败**，不许猜、不许假装装好了：桌面端由 GUI 拉起时 PATH 很
 *     干净，pnpm 常常不在里面。
 *   · **只有注册表来源才装**：`link:` / `file:` / `workspace:` 都是有人明确安排的装法
 *     （开发机就这么跑），装一次 npm 版会把那个指向换掉、本地改动从此不生效。这道门排在
 *     挑包管理器之前 —— 「这台不该装」与「这台装不了」是两件事，不能混成同一条失败。
 *   · **只有 force / auto 才跳过「新发布先晾一会儿」**：手动点的那一下是用户明说「装吧」，
 *     auto 是「一检测到新版就立刻装」，两者一开始就带开关；其余调用（平时装机、没标 auto
 *     的那条）仍然要按供应链那点等待走，撞上策略才重试一次。
 *   · **自动那一轮照样要有新版才装**（自动这条跳过了「有对话在跑」那道闸）：不因为带上了
 *     发布时长开关就变成每 2 分钟把同一个版本重装一遍。
 *
 * 假包管理器是**真的可执行文件**（临时目录里的 sh 脚本 + 真 spawn），所以 cwd、参数、
 * 环境变量、退出码全是被测对象，不是打桩过的函数调用。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PLUGIN = 'dsh-mobile-plugin';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-install-'));

const { installLatest, installLatestIfNeeded, declaredSource, toolSearchDirs, normalizeInvocation, runningAgentIds, profileRegistry, DEFAULT_NAME } = require('../lib/update-install.cjs');

/** 造一个假 profile：`<tmp>/profiles/desktop/node_modules/<插件>` 里放一个版本号。 */
function makeProfile(label, version) {
  const profileDir = path.join(TMP, label);
  const nodeModules = path.join(profileDir, 'node_modules');
  const pkgDir = path.join(nodeModules, PLUGIN);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PLUGIN, version }));
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', private: true, dependencies: { [PLUGIN]: '^0.1.60' } }));
  return { profileDir, nodeModules };
}

/**
 * 假的 pnpm：一个真的可执行 sh 脚本，行为由环境变量决定。
 * `ok` 按 FAKE_PNPM_VERSION 写出一份新的 package.json；`noop` 什么都不做；`fail` 非零退出。
 */
function makeFakePnpm(label) {
  const binDir = path.join(TMP, `bin-${label}`);
  fs.mkdirSync(binDir, { recursive: true });
  const log = path.join(binDir, 'calls.log');
  const file = path.join(binDir, 'pnpm');
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      // 探针：`<pm> --version` 只回一句版本号，别在这儿顺手改盘上的东西。
      'if [ "$1" = "--version" ]; then echo "11.7.0"; exit 0; fi',
      'case "$FAKE_PNPM_MODE" in',
      '  ok)',
      `    mkdir -p node_modules/${PLUGIN}`,
      `    printf '{"name":"${PLUGIN}","version":"%s"}\\n' "$FAKE_PNPM_VERSION" > node_modules/${PLUGIN}/package.json`,
      '    ;;',
      '  noop) : ;;',
      '  fail) echo "boom: 装不了" >&2; exit 7 ;;',
      // pnpm 10.4 及以前在 workspace 根上跑 add 就是这么拒的（profile 自己带 pnpm-workspace.yaml）。
      '  rootfail)',
      '    case "$*" in',
      '      *ignore-workspace-root-check=true*)',
      `        mkdir -p node_modules/${PLUGIN}`,
      `        printf '{"name":"${PLUGIN}","version":"%s"}\\n' "$FAKE_PNPM_VERSION" > node_modules/${PLUGIN}/package.json`,
      '        ;;',
      '      *)',
      '        echo "ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root, which might not be what you want" >&2',
      '        exit 1',
      '        ;;',
      '    esac',
      '    ;;',
      '  agefail)',
      '    case "$*" in',
      '      *minimum-release-age=0*)',
      `        mkdir -p node_modules/${PLUGIN}`,
      `        printf '{"name":"${PLUGIN}","version":"%s"}\\n' "$FAKE_PNPM_VERSION" > node_modules/${PLUGIN}/package.json`,
      '        ;;',
      '      *)',
      '        echo "[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:" >&2',
      '        echo "  billion-context@0.1.192 was published at 2026-10-10T15:32:29.720Z, within the minimumReleaseAge cutoff" >&2',
      '        exit 1',
      '        ;;',
      '    esac',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(file, 0o755);
  return { binDir, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

/**
 * 一个「只会记一笔、什么都不装」的假 pnpm：用来证明某条路上**没**用到 PATH 上那个。
 */
function makeMarkerPnpm(label) {
  const binDir = path.join(TMP, `marker-${label}`);
  fs.mkdirSync(binDir, { recursive: true });
  const log = path.join(binDir, 'marker.log');
  const file = path.join(binDir, 'pnpm');
  fs.writeFileSync(file, ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "10.33.2"; exit 0; fi', `echo "$@" >> "${log}"`, 'exit 0', ''].join('\n'));
  fs.chmodSync(file, 0o755);
  return { binDir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

/** 一个「宿主发布的」包管理器调用：真的能装（宿主那个 pnpm 的角色）。 */
function hostInvocation(binDir) {
  return { command: path.join(binDir, 'pnpm'), args: [], env: { FAKE_PNPM_FROM_HOST: '1' } };
}

/** 只让假 pnpm 被找到：给一组只含它的目录 + 空 PATH。 */
function isolatedEnv(binDir, extra = {}) {
  return { PATH: '', HOME: TMP, FAKE_PNPM_MODE: 'ok', FAKE_PNPM_VERSION: '0.2.0', ...extra };
}

/** 一个只回答 `/<name>/latest` 的假注册表。 */
async function startRegistry(version) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: PLUGIN, version }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** 用假注册表跑一段：DSHM_NPM_REGISTRY 是模块级读的，用完必须还原。 */
async function withRegistry(version, body) {
  const registry = await startRegistry(version);
  const previous = process.env.DSHM_NPM_REGISTRY;
  process.env.DSHM_NPM_REGISTRY = registry.base;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.DSHM_NPM_REGISTRY;
    else process.env.DSHM_NPM_REGISTRY = previous;
    await registry.close();
  }
}

test('装成功：盘上版本真的变了才算装上，命令里带包名与版本', async () => {
  const profile = makeProfile('ok', '0.1.60');
  const fake = makeFakePnpm('ok');
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir),
  });
  assert.equal(result.installed, true);
  assert.equal(result.beforeVersion, '0.1.60');
  assert.equal(result.installedVersion, '0.2.0');
  assert.equal(result.failure, null);
  assert.match(result.command, /^pnpm add dsh-mobile-plugin@0\.2\.0/);
  assert.equal(result.source, 'npm');
  assert.equal(fake.calls().length, 1, '只该跑一次');
});

test('装之前先给外壳一次机会把正在跑的那一代备份走（包管理器一跑旧目录就没了）', async () => {
  const profile = makeProfile('before', '0.1.60');
  const fake = makeFakePnpm('before');
  const seen = [];
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir),
    beforeInstall: () => { seen.push({ calls: fake.calls().length, beforeVersion: 'unknown' }); },
  });
  assert.equal(result.installed, true);
  assert.equal(seen.length, 1, '备份只该问一次');
  assert.equal(seen[0].calls, 0, '必须排在包管理器之前：它一跑，盘上那份旧代码就没了');
});

test('备份那一步自己炸了也不许挡住更新', async () => {
  const profile = makeProfile('before-throw', '0.1.60');
  const fake = makeFakePnpm('before-throw');
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir),
    beforeInstall: () => { throw new Error('盘满了') },
  });
  assert.equal(result.installed, true, '备份是多一层保险，不该变成更新的前置条件');
});

test('没有新版时不去备份（每个 tick 都抄一遍等于白耗盘）', async () => {
  const profile = makeProfile('before-latest', '0.1.60');
  let called = 0;
  await withRegistry('0.1.60', async () => {
    const result = await installLatestIfNeeded({
      profileNodeModules: profile.nodeModules,
      dirs: [path.join(TMP, 'nope')],
      env: { PATH: '', HOME: TMP },
      beforeInstall: () => { called += 1; },
    });
    assert.equal(result.skipped, true);
  });
  assert.equal(called, 0);
});

test('退出码 0 但盘上没变：不算装上（只看退出码是最贵的那个 bug）', async () => {
  const profile = makeProfile('noop', '0.1.60');
  const fake = makeFakePnpm('noop');
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir, { FAKE_PNPM_MODE: 'noop' }),
  });
  assert.equal(result.installed, false);
  assert.equal(result.installedVersion, '0.1.60');
  assert.equal(result.failure.code, 'VERSION_UNCHANGED');
});

test('安装失败：如实带出退出码与输出，版本保持不变', async () => {
  const profile = makeProfile('fail', '0.1.60');
  const fake = makeFakePnpm('fail');
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir, { FAKE_PNPM_MODE: 'fail' }),
  });
  assert.equal(result.installed, false);
  assert.equal(result.installedVersion, '0.1.60');
  assert.equal(result.failure.code, 'INSTALL_FAILED');
  assert.match(result.failure.message, /7/, '退出码要说出来');
  assert.match(result.failure.message, /boom: 装不了/, '包管理器自己那句话要跟着结论一起出来：面板、手机与日志只显示这一句');
  assert.match(result.output, /boom/, '命令输出要能带出来给人看');
});

test('失败结论里挑的是 ERR_PNPM / ERROR 那几行，不是进度条', async () => {
  const profile = makeProfile('reason', '0.1.60');
  const binDir = path.join(TMP, 'bin-reason');
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'pnpm');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "9.15.9"; exit 0; fi',
    'echo "Progress: resolved 31, reused 30, downloaded 0, added 0" >&2',
    'echo "ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root" >&2',
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [binDir],
    env: isolatedEnv(binDir),
  });
  assert.equal(result.failure.code, 'INSTALL_FAILED');
  assert.match(result.failure.message, /ERR_PNPM_ADDING_TO_ROOT/);
  assert.doesNotMatch(result.failure.message, /Progress:/, '进度条那种噪声不该进结论：手机上只有这一句');
});

test('找不到包管理器：如实失败，绝不假装装好了', async () => {
  const profile = makeProfile('missing', '0.1.60');
  const empty = path.join(TMP, 'empty-bin');
  fs.mkdirSync(empty, { recursive: true });
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [empty],
    env: { PATH: '', HOME: TMP },
  });
  assert.equal(result.installed, false);
  assert.equal(result.failure.code, 'PACKAGE_MANAGER_MISSING');
  assert.equal(result.command, null, '没跑起来就不该有一个装成过的命令');
});

test('非 npm 来源一律不碰：link: / file: / workspace: 都是有人明确安排的装法', async () => {
  const cases = [
    ['linked', 'link:/tmp/some-checkout'],
    ['file', 'file:./dsh-mobile-plugin-0.1.93.tgz'],
    ['workspace', 'workspace:*'],
  ];
  for (const [label, spec] of cases) {
    const profile = makeProfile(`gate-${label}`, '0.1.60');
    fs.writeFileSync(
      path.join(profile.profileDir, 'package.json'),
      JSON.stringify({ name: 'p', dependencies: { [PLUGIN]: spec } }),
    );
    const fake = makeFakePnpm(`gate-${label}`);
    const result = await installLatest({
      profileNodeModules: profile.nodeModules,
      version: '0.2.0',
      dirs: [fake.binDir],
      env: isolatedEnv(fake.binDir),
    });
    assert.equal(result.installed, false, `${label} 不该装上`);
    assert.equal(result.failure.code, 'LOCAL_SOURCE', `${label} 要回 LOCAL_SOURCE`);
    assert.deepEqual(fake.calls(), [], `${label} 连包管理器都不该探一次`);
  }
});

test('来源那道门排在挑包管理器之前：没有包管理器的本机也要先说清「这台不该装」', async () => {
  const profile = makeProfile('gate-order', '0.1.60');
  fs.writeFileSync(
    path.join(profile.profileDir, 'package.json'),
    JSON.stringify({ name: 'p', dependencies: { [PLUGIN]: 'file:./x.tgz' } }),
  );
  const empty = path.join(TMP, 'gate-order-empty-bin');
  fs.mkdirSync(empty, { recursive: true });
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [empty],
    env: { PATH: '', HOME: TMP },
  });
  assert.equal(result.failure.code, 'LOCAL_SOURCE', '「不该装」必须排在「装不了」前面');
});

test('所有安装都带齐那几个开关：命令行与环境变量各带一份', async () => {
  const profile = makeProfile('quiet', '0.1.60');
  const fake = makeFakePnpm('quiet');
  await installLatest({ profileNodeModules: profile.nodeModules, version: '0.2.0', dirs: [fake.binDir], env: isolatedEnv(fake.binDir) });
  assert.match(fake.calls()[0], /auto-install-peers=false/, 'peer 里有一串 npm 上根本没有的 @deepseek-ai/*，必须显式关掉');
  assert.match(fake.calls()[0], /--config\.minimum-release-age=0/, '不再分哪一档才跳过晾置期：手动那一档同样要即时');
  assert.match(fake.calls()[0], /--config\.ignore-workspace-root-check=true/, 'profile 自己是 workspace 根，老 pnpm 拿 ERR_PNPM_ADDING_TO_ROOT 拒掉这一句 add');
  assert.equal(fake.calls().length, 1, '开关一开始就带上，不许先失败一次再靠重试绕过去');
});

test('profile 是 workspace 根：老 pnpm 会被 ADDING_TO_ROOT 拒掉，带上根开关才装得上', async () => {
  const profile = makeProfile('root-check', '0.1.60');
  const fake = makeFakePnpm('root-check');
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir, { FAKE_PNPM_MODE: 'rootfail' }),
  });
  assert.equal(result.installed, true, '假 pnpm 只在拿到根开关时才装：开关掉了这条立刻红');
  assert.equal(result.failure, null);
});

test('策略开关走环境变量那一份：pnpm 12 只认它', async () => {
  const profile = makeProfile('policy-env', '0.1.60');
  const binDir = path.join(TMP, 'bin-policy-env');
  fs.mkdirSync(binDir, { recursive: true });
  const log = path.join(binDir, 'env.log');
  const file = path.join(binDir, 'pnpm');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "12.3.0"; exit 0; fi',
    `printf '%s|%s|%s\\n' "$PNPM_CONFIG_AUTO_INSTALL_PEERS" "$PNPM_CONFIG_MINIMUM_RELEASE_AGE" "$PNPM_CONFIG_IGNORE_WORKSPACE_ROOT_CHECK" >> "${log}"`,
    `mkdir -p node_modules/${PLUGIN}`,
    `printf '{"name":"${PLUGIN}","version":"0.2.0"}\\n' > node_modules/${PLUGIN}/package.json`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  const result = await installLatest({ profileNodeModules: profile.nodeModules, version: '0.2.0', dirs: [binDir], env: isolatedEnv(binDir) });
  assert.equal(result.installed, true);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'false|0|true', '几个开关都要以 PNPM_CONFIG_* 传给 pnpm');
});

test('来源判定：npm / file / link / workspace，读不到就说不知道', () => {
  const dir = path.join(TMP, 'source');
  fs.mkdirSync(dir, { recursive: true });
  const write = spec => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: spec === null ? {} : { [PLUGIN]: spec } }));
    return declaredSource(dir, PLUGIN);
  };
  assert.equal(write('^0.1.60'), 'npm');
  assert.equal(write('0.1.60'), 'npm');
  assert.equal(write('file:./x.tgz'), 'file');
  assert.equal(write('link:/tmp/x'), 'linked');
  assert.equal(write('workspace:*'), 'workspace');
  assert.equal(write(null), null);
  assert.equal(declaredSource(path.join(TMP, 'nowhere'), PLUGIN), null, 'profile 读不到就说不知道，不要瞎猜');
});

test('工具目录：PNPM_HOME 放最前、桌面端常见的几个 bin 目录要在，且不重复', () => {
  const dirs = toolSearchDirs({ platform: 'darwin', env: { PNPM_HOME: '/custom/pnpm' }, home: '/Users/x', execDir: '/node/bin' });
  assert.equal(dirs[0], '/custom/pnpm');
  for (const expected of ['/opt/homebrew/bin', '/usr/local/bin', '/Users/x/Library/pnpm', '/node/bin']) {
    assert.ok(dirs.includes(expected), `要包含 ${expected}`);
  }
  assert.equal(new Set(dirs).size, dirs.length, '不许出现重复目录');
});

test('「让我变成最新」：已经是最新就什么都不做，有新版本才装', async () => {
  const registry = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: PLUGIN, version: '0.2.0' }));
  });
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
  const previous = process.env.DSHM_NPM_REGISTRY;
  process.env.DSHM_NPM_REGISTRY = `http://127.0.0.1:${registry.address().port}`;
  try {
    // 盘上就是线上最新：不该去跑包管理器。
    const current = makeProfile('if-needed-current', '0.2.0');
    const currentFake = makeFakePnpm('if-needed-current');
    const skipped = await installLatestIfNeeded({
      profileNodeModules: current.nodeModules,
      dirs: [currentFake.binDir],
      env: isolatedEnv(currentFake.binDir),
    });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.installed, false);
    assert.equal(skipped.check.latestVersion, '0.2.0');
    assert.deepEqual(currentFake.calls(), [], '已经是最新就不该动盘');

    // 盘上旧了：装。
    const old = makeProfile('if-needed-old', '0.1.60');
    const oldFake = makeFakePnpm('if-needed-old');
    const done = await installLatestIfNeeded({
      profileNodeModules: old.nodeModules,
      dirs: [oldFake.binDir],
      env: isolatedEnv(oldFake.binDir),
    });
    assert.equal(done.installed, true);
    assert.equal(done.installedVersion, '0.2.0');
    assert.equal(done.check.updateAvailable, true);
  } finally {
    if (previous === undefined) delete process.env.DSHM_NPM_REGISTRY;
    else process.env.DSHM_NPM_REGISTRY = previous;
    await new Promise(resolve => registry.close(resolve));
  }
});

test('外壳那条路：盘上那一代带自装模块时，自动更新走它（不再问市场）', async () => {
  // 外壳的 profile 路径是**导入时**算的，所以环境变量必须在 require 之前设好。
  const profileDir = path.join(TMP, 'shell-profile');
  const nodeModules = path.join(profileDir, 'node_modules');
  const pkgDir = path.join(nodeModules, PLUGIN);
  const marker = path.join(TMP, 'shell-hook-called');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PLUGIN, version: '0.1.60' }));
  fs.writeFileSync(path.join(pkgDir, 'lib', 'impl.js'), 'export function apply() {}\n');
  fs.writeFileSync(
    path.join(pkgDir, 'lib', 'update-install.cjs'),
    [
      "'use strict';",
      `const fs = require('node:fs');`,
      `module.exports = { installLatestIfNeeded: async (options) => {`,
      `  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ force: options.force === true, auto: options.auto === true, packageManager: options.packageManager ?? null, hasAgents: options.agents !== undefined && options.agents !== null }));`,
      `  return { installed: true, skipped: false, beforeVersion: '0.1.60', installedVersion: '0.2.0', failure: null };`,
      `} };`,
      '',
    ].join('\n'),
  );
  process.env.DSH_MOBILE_PROFILE_NODE_MODULES = nodeModules;
  process.env.DSH_HOME = path.join(TMP, 'shell-home');
  const { installIfNeeded } = await import('../lib/shell/updater.js');

  // 给一个一定连不上的「市场」：走通了就证明它根本没问市场。
  const outcome = await installIfNeeded('http://127.0.0.1:1', {
    force: true,
    packageManager: () => ({ command: '/host/pnpm', args: [] }),
    agents: () => ({ list: () => [] }),
  });
  assert.equal(outcome.installed, true);
  assert.equal(outcome.installedVersion, '0.2.0');
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.restartRequired, false, '外壳就地换代，不许照做市场的「要重启」');
  const seen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(seen.force, true, 'force 要透给实现');
  assert.equal(seen.auto, false, '手动那颗按钮不是自动那一档');
  assert.equal(seen.packageManager?.command, '/host/pnpm', '宿主发布的包管理器要透给实现（装的时候必须优先用它）');
  assert.equal(seen.hasAgents, true, 'agents 服务要透给实现（「有对话在跑就别换文件」那道闸要用）');

  // 自动那一轮：force 不带，auto 要透到实现 —— 只有实现认得出这一档，它才会不等对话。
  await installIfNeeded('http://127.0.0.1:1', { auto: true, agents: () => ({ list: () => [] }) });
  const autoSeen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(autoSeen.force, false, '自动那一轮不许借 force');
  assert.equal(autoSeen.auto, true, 'auto 要透给实现');

  // 外壳自己的定时器从 `performUpdate` 进来，中间还有一层编排：`auto` 得一路穿到底。
  const { performUpdate } = await import('../lib/shell/updater.js');
  const updateState = { lastApply: null, appliedAt: null, lastError: null };
  await performUpdate({
    runtime: { status: () => ({ version: '0.1.60', source: 'installed' }), reload: async () => ({ version: '0.2.0' }) },
    base: 'http://127.0.0.1:1',
    hostService: () => null,
    updateState,
    auto: true,
  });
  const autoApply = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(autoApply.auto, true, '自动轮询那一轮的 auto 要穿到实现（否则定时器白开）');
  assert.equal(autoApply.force, false);
});

test('宿主发布的包管理器优先：PATH 上那个不许被碰', async () => {
  const profile = makeProfile('host-first', '0.1.60');
  const fake = makeFakePnpm('host-first');
  const marker = makeMarkerPnpm('host-first');
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    packageManager: hostInvocation(fake.binDir),
    dirs: [marker.binDir],
    env: isolatedEnv(marker.binDir),
  });
  assert.equal(result.installed, true, '宿主那个真的把包装上了');
  assert.equal(result.installedVersion, '0.2.0');
  assert.equal(result.manager, 'host', '要如实说清用的是宿主那个');
  assert.deepEqual(marker.calls(), [], 'PATH 上那个 pnpm 一次都不该被调用');
});

test('宿主那个跑不起来：退回 PATH 上的 pnpm，并如实说用的是哪个', async () => {
  const profile = makeProfile('host-broken', '0.1.60');
  const fake = makeFakePnpm('host-broken');
  const brokenDir = path.join(TMP, 'bin-broken-host');
  fs.mkdirSync(brokenDir, { recursive: true });
  const broken = path.join(brokenDir, 'pnpm');
  fs.writeFileSync(broken, ['#!/bin/sh', 'echo "我用不了" >&2', 'exit 12', ''].join('\n'));
  fs.chmodSync(broken, 0o755);

  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    packageManager: { command: broken, args: [] },
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir),
  });
  assert.equal(result.installed, true, '宿主那个坏了要能退回 PATH');
  assert.equal(result.manager, 'path');
});

test('有 agent 在跑：不动盘、如实报 AGENTS_RUNNING、可说「再试」', async () => {
  await withRegistry('0.2.0', async () => {
    const profile = makeProfile('agents-busy', '0.1.60');
    const fake = makeFakePnpm('agents-busy');
    const outcome = await installLatestIfNeeded({
      profileNodeModules: profile.nodeModules,
      dirs: [fake.binDir],
      env: isolatedEnv(fake.binDir),
      agents: { list: () => [{ id: 'session-a', status: 'running' }, { id: 'session-b', status: 'idle' }] },
    });
    assert.equal(outcome.installed, false);
    assert.equal(outcome.failure.code, 'AGENTS_RUNNING');
    assert.equal(outcome.retryable, true, '这是「现在不行」，自动更新下个 tick 该再试');
    assert.deepEqual(outcome.runningAgents, ['session-a'], '只有 status 正好是 running 的算');
    assert.deepEqual(fake.calls(), [], '被挡住时不许动盘');

    // force = 用户明说「我知道，装吧」：跳过这道闸（也跳过发布时长门槛）。
    const forced = await installLatestIfNeeded({
      profileNodeModules: profile.nodeModules,
      force: true,
      dirs: [fake.binDir],
      env: isolatedEnv(fake.binDir),
      agents: { list: () => [{ id: 'session-a', status: 'running' }] },
    });
    assert.equal(forced.installed, true, 'force 要跳过那道闸');
    assert.equal(forced.installedVersion, '0.2.0');

    // auto = 宿主那一轮自动更新：同样跳过这道闸（2026-10-25 用户拍板），2026-10-26 起也
    // 一开始就带发布时长开关（一检测到新版就装）。
    const autoProfile = makeProfile('agents-auto', '0.1.60');
    const autoFake = makeFakePnpm('agents-auto');
    const automatic = await installLatestIfNeeded({
      profileNodeModules: autoProfile.nodeModules,
      auto: true,
      dirs: [autoFake.binDir],
      env: isolatedEnv(autoFake.binDir),
      agents: { list: () => [{ id: 'session-a', status: 'running' }] },
    });
    assert.equal(automatic.installed, true, '自动更新要跳过「有对话在跑」那道闸');
    assert.equal(automatic.installedVersion, '0.2.0');
    assert.match(autoFake.calls()[0], /minimum-release-age=0/, '自动那一轮也跳过发布晾置期');
  });
});

test('auto 只跳过对话那道闸：已经是最新时照样不动盘', async () => {
  await withRegistry('0.1.60', async () => {
    const profile = makeProfile('auto-current', '0.1.60');
    const fake = makeFakePnpm('auto-current');
    const outcome = await installLatestIfNeeded({
      profileNodeModules: profile.nodeModules,
      auto: true,
      dirs: [fake.binDir],
      env: isolatedEnv(fake.binDir),
      agents: { list: () => [{ id: 'session-a', status: 'running' }] },
    });
    assert.equal(outcome.installed, false);
    assert.equal(outcome.skipped, true);
    assert.equal(outcome.check.updateAvailable, false);
    assert.deepEqual(fake.calls(), [], '已经是最新时不许每一轮把同一个版本重装一遍');
  });
});

test('agents 判据：读不到 / 抛错 / 形状不对一律当「没人跑」，不许把更新锁死', () => {
  assert.deepEqual(runningAgentIds(null), []);
  assert.deepEqual(runningAgentIds({ list: () => { throw new Error('半拆的注册表'); } }), []);
  assert.deepEqual(runningAgentIds({ list: () => 'nope' }), []);
  assert.deepEqual(runningAgentIds({}), []);
  assert.deepEqual(runningAgentIds({ list: () => [null, 'x', { status: 'running' }, { id: 'a', status: 'running' }, { id: 'a', status: 'running' }] }), ['agent', 'a']);
});

test('宿主发布的调用方式形状不对就整个丢掉（半份调用等于仍然跑不起来的工具）', () => {
  assert.equal(normalizeInvocation(null), null);
  assert.equal(normalizeInvocation('pnpm'), null);
  assert.equal(normalizeInvocation({}), null);
  assert.equal(normalizeInvocation({ command: '  ', args: [] }), null);
  assert.equal(normalizeInvocation({ command: 'node', args: 'x' }), null);
  assert.equal(normalizeInvocation({ command: 'node', args: [1] }), null);
  const ok = normalizeInvocation({ command: ' node ', args: ['pnpm.cjs'], env: { A: '1', B: 2 } });
  assert.deepEqual(ok, { command: 'node', args: ['pnpm.cjs'], env: { A: '1' } }, 'env 只收字符串值');
});

test('别的失败不许乱重试（网络 / 权限 / 盘满重试一次只是把同一条错误再说一遍）', async () => {
  const profile = makeProfile('no-blind-retry', '0.1.60');
  const fake = makeFakePnpm('no-blind-retry');
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir, { FAKE_PNPM_MODE: 'fail' }),
  });
  assert.equal(result.installed, false);
  assert.equal(result.failure.code, 'INSTALL_FAILED');
  assert.equal(result.healed, null);
  assert.equal(fake.calls().length, 1, '只该跑一次');
});

test('装成功就把这一版登记进排除清单：不留一条未满期的记录把别的安装挡住', async () => {
  const profile = makeProfile('register', '0.1.60');
  fs.writeFileSync(path.join(profile.profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - dsh-mobile-plugin@0.1.60\n');
  const fake = makeFakePnpm('register');
  const result = await installLatest({
    profileNodeModules: profile.nodeModules,
    version: '0.2.0',
    dirs: [fake.binDir],
    env: isolatedEnv(fake.binDir),
  });
  assert.equal(result.installed, true);
  assert.equal(result.releaseAgeRecorded, true);
  const yaml = fs.readFileSync(path.join(profile.profileDir, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(yaml, /^\s+- dsh-mobile-plugin@0\.1\.60 \|\| 0\.2\.0$/m, '并进已有的那一行，不新开一行（pnpm 只读第一条）');
  assert.equal((yaml.match(/dsh-mobile-plugin/g) || []).length, 1);
});

test('排除清单：没有这个键就补一段，看不懂的 flow 写法不碰', async () => {
  const profile = makeProfile('register-new', '0.1.60');
  fs.writeFileSync(path.join(profile.profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  const fake = makeFakePnpm('register-new');
  const first = await installLatest({ profileNodeModules: profile.nodeModules, version: '0.2.0', dirs: [fake.binDir], env: isolatedEnv(fake.binDir) });
  assert.equal(first.releaseAgeRecorded, true);
  const yaml = fs.readFileSync(path.join(profile.profileDir, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(yaml, /^minimumReleaseAgeExclude:\n  - dsh-mobile-plugin@0\.2\.0$/m);

  // 已经登记过同一版：不再重复追加。
  const again = await installLatest({ profileNodeModules: profile.nodeModules, version: '0.2.0', dirs: [fake.binDir], env: isolatedEnv(fake.binDir) });
  assert.equal(again.installed, false, '版本没变不算装上');
});

test('宿主 pnpm 说依赖树是旧版建的：重建一次再重试', async () => {
  const profile = makeProfile('heal-rebuild', '0.1.60');
  const binDir = path.join(TMP, 'bin-heal-rebuild');
  fs.mkdirSync(binDir, { recursive: true });
  const log = path.join(binDir, 'calls.log');
  const file = path.join(binDir, 'pnpm');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    'if [ "$1" = "--version" ]; then echo "11.28.5"; exit 0; fi',
    'if [ "$1" = "install" ]; then exit 0; fi',
    'if [ -f .rebuilt ]; then',
    `  mkdir -p node_modules/${PLUGIN}`,
    `  printf '{"name":"${PLUGIN}","version":"0.2.0"}\\n' > node_modules/${PLUGIN}/package.json`,
    '  exit 0',
    'fi',
    ': > .rebuilt',
    'echo "[ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF] The modules directory was created by a different pnpm major" >&2',
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  const result = await installLatest({ profileNodeModules: profile.nodeModules, version: '0.2.0', dirs: [binDir], env: isolatedEnv(binDir) });
  assert.equal(result.installed, true);
  assert.equal(result.healed, 'rebuild');
  assert.ok(fs.readFileSync(log, 'utf8').split('\n').some(line => /^install --no-frozen-lockfile/.test(line)), '重建那条命令要真的跑过');
});

test('宿主 pnpm 的 store 对不上：把记录里的那个写回 storeDir 再重试', async () => {
  const profile = makeProfile('heal-store', '0.1.60');
  fs.writeFileSync(path.join(profile.profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  const storeDir = path.join(TMP, 'store-heal');
  fs.mkdirSync(storeDir, { recursive: true });
  const binDir = path.join(TMP, 'bin-heal-store');
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'pnpm');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "11.28.5"; exit 0; fi',
    'need=1',
    'while IFS= read -r line; do case "$line" in storeDir:*) need=0 ;; esac; done < pnpm-workspace.yaml',
    'if [ "$need" = "0" ]; then',
    `  mkdir -p node_modules/${PLUGIN}`,
    `  printf '{"name":"${PLUGIN}","version":"0.2.0"}\\n' > node_modules/${PLUGIN}/package.json`,
    '  exit 0',
    'fi',
    `echo "[ERR_PNPM_UNEXPECTED_STORE] The dependencies at \\"${profile.nodeModules}\\" are currently linked from the store at \\"${storeDir}\\", but pnpm wants to use the store at \\"/nowhere\\"." >&2`,
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  const result = await installLatest({ profileNodeModules: profile.nodeModules, version: '0.2.0', dirs: [binDir], env: isolatedEnv(binDir) });
  assert.equal(result.installed, true);
  assert.equal(result.healed, 'store');
  assert.match(fs.readFileSync(path.join(profile.profileDir, 'pnpm-workspace.yaml'), 'utf8'), new RegExp(`^storeDir: ${storeDir}$`, 'm'));
});

test('顺序：已经是最新时，哪怕有 agent 在跑也要如实答「没东西可装」', async () => {
  await withRegistry('0.1.60', async () => {
    const profile = makeProfile('order', '0.1.60');
    const fake = makeFakePnpm('order');
    const outcome = await installLatestIfNeeded({
      profileNodeModules: profile.nodeModules,
      dirs: [fake.binDir],
      env: isolatedEnv(fake.binDir),
      agents: { list: () => [{ id: 'session-a', status: 'running' }] },
    });
    assert.equal(outcome.skipped, true, '真正的答案是「已经是最新」，不是「有对话在跑」');
    assert.equal(outcome.failure, null);
    assert.deepEqual(fake.calls(), []);
  });
});

test('注册表：问本机 pnpm 自己用的是哪个，一轮只问一次', async () => {
  const profile = makeProfile('registry', '0.1.60');
  const binDir = path.join(TMP, 'bin-registry');
  fs.mkdirSync(binDir, { recursive: true });
  const log = path.join(binDir, 'calls.log');
  const file = path.join(binDir, 'pnpm');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    'if [ "$1" = "--version" ]; then echo "11.28.5"; exit 0; fi',
    'if [ "$1" = "config" ]; then echo "https://registry.npmmirror.com/"; exit 0; fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  const cache = new Map();
  const first = await profileRegistry({ profileNodeModules: profile.nodeModules, dirs: [binDir], env: isolatedEnv(binDir), cache });
  assert.equal(first, 'https://registry.npmmirror.com', '末尾斜杠要削掉');
  const second = await profileRegistry({ profileNodeModules: profile.nodeModules, dirs: [binDir], env: isolatedEnv(binDir), cache });
  assert.equal(second, first);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length, 1, '缓存期内不许每轮都起一个进程');
});

test('查更新走本机 pnpm 的源：镜像有这一版就查得到（官方源根本没问）', async () => {
  const registryVersion = '0.3.0';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: PLUGIN, version: registryVersion }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = makeProfile('registry-check', '0.2.0');
  const binDir = path.join(TMP, 'bin-registry-check');
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'pnpm');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "11.28.5"; exit 0; fi',
    'if [ "$1" = "config" ]; then echo "$FAKE_REGISTRY"; exit 0; fi',
    `if [ "$1" = "add" ]; then mkdir -p node_modules/${PLUGIN}; printf '{"name":"${PLUGIN}","version":"0.3.0"}\\n' > node_modules/${PLUGIN}/package.json; exit 0; fi`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  try {
    const outcome = await installLatestIfNeeded({
      profileNodeModules: profile.nodeModules,
      dirs: [binDir],
      env: isolatedEnv(binDir, { FAKE_REGISTRY: base }),
      registryCache: new Map(),
    });
    assert.equal(outcome.check.latestVersion, registryVersion, '镜像源上那一版要看得到');
    assert.equal(outcome.installed, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
