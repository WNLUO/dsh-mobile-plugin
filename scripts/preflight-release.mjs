#!/usr/bin/env node
/**
 * 发版预检：打 tag 之前必须全绿。
 *
 * ## 为什么需要这条命令
 *
 * 公开仓库那条流水线只认 tag，推分支不跑任何东西；本地也没有 pre-push 钩子。而它在
 * 打 tag 之后才跑的那几步有两个盲区：单独检出里跨仓对账会自己跳过（它要读主仓的
 * `app/`），面板产物只查「在不在包里」、不查新旧。热重载更不算测过 —— 它只是把**当前
 * 工作区**装进 profile 跑一遍，不跑测试、不打包，也碰不到任何跨版本组合。
 *
 * 所以把「发版前该做的」收成一条命令，顺序固定、任何一步红就停：
 *
 *   1. 在哪个检出里跑：必须有主仓的 `app/`，否则跨仓对账这一层查不了
 *   2. 版本号与 tag：三段都在 `0..999`、这个 tag 没打过、不比上一版低
 *   3. 工作区干净：发出去的必须是提交里的那一份，不能是测完又改过的工作区
 *   4. 面板产物跟得上源码：改了 `React/src` 却没重建提交，就停在这一步
 *   5. 整套测试（在主仓里跑才包含跨仓对账）
 *   6. 真打一次包：关键产物在不在、有没有把源码和测试带出去、版本号对不对
 *
 * 跑完打印接下来那三步。README 的发版流程第一步就是它。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const REPO = path.resolve(PLUGIN, '..');
const APP_PATHS = path.join(REPO, 'app', 'src', 'services', 'viewmodels', 'apiPaths.ts');
const PANEL_SOURCE = 'React/src';
const PANEL_ARTIFACT = 'lib/panel/index.html';
const REQUIRED_FILES = [
  'package.json',
  'host.js',
  'lib/index.js',
  'lib/panel/index.html',
  'dsh-mobile-credentials/lib/credentials.js',
];
/** 包内不该出现的东西：源码、测试、脚本、依赖树。 */
const FORBIDDEN_PREFIXES = ['React/', 'test/', 'scripts/', 'node_modules/'];

const TOTAL = 6;

class Stop extends Error {
  constructor(reason, hint) {
    super(reason);
    this.hint = hint;
  }
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Stop(`跑不起 ${command}：${result.error.message}`, null);
  return result;
}

function step(label) {
  process.stdout.write(`\n[${label}]\n`);
}

function ok(text) {
  process.stdout.write(`  ✔ ${text}\n`);
}

/** 三段版本号 → 数字数组；不是合法形状时抛（当作「这版不能发」）。 */
function parseVersion(text, what) {
  const parts = String(text).trim().split('.');
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 999)) {
    throw new Stop(
      `${what} 版本号不是三段 0..999 的写法：${JSON.stringify(text)}`,
      '先跑 node scripts/bump-version.mjs（每段 0..999，别手改）。',
    );
  }
  return parts.map(Number);
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 某个路径最后一次被提交时的时间戳；从未提交过回 null。 */
function lastCommitAt(relPath) {
  const result = sh('git', ['log', '-1', '--format=%ct', '--', relPath], { cwd: PLUGIN });
  const value = Number(result.stdout.trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function checkCheckout() {
  step(`1/${TOTAL} 检出位置`);
  if (!fs.existsSync(APP_PATHS)) {
    throw new Stop(
      '这里是插件单独检出（找不到主仓的 app/）',
      '这条命令要在主仓里跑：跨仓对账（手机端接口常量 ↔ 插件路由表）只有主仓能查。'
      + '同步到公开仓库之前，先回主仓把预检跑绿。',
    );
  }
  ok('在主仓里，跨仓对账这一层能查');
}

function checkVersionAndTag() {
  step(`2/${TOTAL} 版本号与 tag`);
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '');
  const current = parseVersion(version, 'package.json 的');
  ok(`当前版本 ${version}`);

  const tag = `v${version}`;
  const existing = sh('git', ['tag', '-l', tag], { cwd: PLUGIN }).stdout.trim();
  if (existing) {
    throw new Stop(
      `tag ${tag} 已经存在`,
      '同一个版本号不能发第二次（npm 也拒同号覆盖）。先抬版本号再发。',
    );
  }
  ok(`tag ${tag} 还没用过`);

  const listed = sh('git', ['tag', '-l', 'v*', '--sort=-v:refname'], { cwd: PLUGIN })
    .stdout.trim().split('\n').filter(Boolean);
  const newestTag = listed[0] ?? null;
  if (newestTag) {
    const newest = parseVersion(newestTag.replace(/^v/, ''), `现存 tag ${newestTag} 的`);
    if (compareVersions(current, newest) <= 0) {
      throw new Stop(
        `当前版本 ${version} 不大于已发过的 ${newestTag}`,
        '注册表会按号比新旧、市场读到「更新会降级」。抬号再发。',
      );
    }
    ok(`比上一版 ${newestTag} 新`);
  }
  return version;
}

function checkClean() {
  step(`3/${TOTAL} 工作区干净`);
  const dirty = sh('git', ['status', '--porcelain'], { cwd: PLUGIN }).stdout.trim();
  if (!dirty) {
    ok('没有未提交的改动');
    return;
  }
  const lines = dirty.split('\n');
  const shown = lines.slice(0, 6).map((line) => `      ${line}`).join('\n');
  throw new Stop(
    `插件仓库还有 ${lines.length} 处没提交的改动：\n${shown}${lines.length > 6 ? '\n      …' : ''}`,
    '发出去的是提交里的那一份。先把这次发版该带的文件提交（逐个点名，别 git add -A 把别的'
    + '对话改到一半的东西卷进来），再跑一次这条命令。',
  );
}

function checkPanelArtifact() {
  step(`4/${TOTAL} 面板产物`);
  if (!fs.existsSync(path.join(PLUGIN, PANEL_ARTIFACT))) {
    throw new Stop(
      `包里缺 ${PANEL_ARTIFACT}`,
      '在 React 目录跑 pnpm run build 生成它，产物是提交物、要一起提交。',
    );
  }
  const sourceAt = lastCommitAt(PANEL_SOURCE);
  const artifactAt = lastCommitAt(PANEL_ARTIFACT);
  if (sourceAt !== null && (artifactAt === null || sourceAt > artifactAt)) {
    throw new Stop(
      '面板源码比产物新：改了面板却没重建并提交',
      '在 React 目录跑 pnpm run build，把重新生成的 lib/panel/index.html 一起提交。'
      + '打 tag 那条流水线只查它「在不在包里」，查不出新旧。',
    );
  }
  ok('面板产物不旧于源码');
}

function runTests() {
  step(`5/${TOTAL} 整套测试`);
  const result = spawnSync('npm', ['test'], { cwd: PLUGIN, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Stop(
      '测试没过，发版停在这里',
      '先修红。跨仓对账那几条红，通常意味着手机端路径常量和插件路由表已经对不上了。',
    );
  }
  ok('测试全绿');
}

function checkPackage(version) {
  step(`6/${TOTAL} 真打一次包`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-'));
  try {
    const packed = sh('npm', ['pack', '--json', '--pack-destination', dir], { cwd: PLUGIN });
    if (packed.status !== 0) {
      throw new Stop(`npm pack 失败：${(packed.stderr || '').trim().split('\n').pop() ?? '没有输出'}`, null);
    }
    const [info] = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')));
    const files = new Set((info.files ?? []).map((file) => file.path));
    if (String(info.version) !== version) {
      throw new Stop(`包里的版本号是 ${info.version}，package.json 是 ${version}`, null);
    }
    const missing = REQUIRED_FILES.filter((file) => !files.has(file));
    if (missing.length) {
      throw new Stop(
        `包里缺关键产物：${missing.join('、')}`,
        '看 package.json 的 files 白名单：漏一条就是装上去起不来的包。',
      );
    }
    const leaked = [...files].filter((file) => FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)));
    if (leaked.length) {
      throw new Stop(
        `包里有不该发出去的东西：${leaked.slice(0, 5).join('、')}${leaked.length > 5 ? ' 等' : ''}`,
        '源码、测试、脚本、依赖树都不进包；改 package.json 的 files。',
      );
    }
    ok(`包内 ${files.size} 个文件，关键产物齐全、没有夹带源码`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  process.stdout.write('插件发版预检\n');
  checkCheckout();
  const version = checkVersionAndTag();
  checkClean();
  checkPanelArtifact();
  runTests();
  checkPackage(version);
  process.stdout.write(
    `\n全绿：${version} 可以发。接下来三步：\n`
    + '  1. 把这次发版的提交同步到公开仓库（只带该带的文件）\n'
    + `  2. 推 tag v${version}，流水线会自动校验并发布\n`
    + '  3. 流水线末尾会核注册表版本，你也可以手动 npm view dsh-mobile-plugin version\n\n'
    + '流水线是第二道闸，不是唯一一道：它单独检出、跨仓对账会跳过，面板产物只查在不在包里。\n',
  );
}

try {
  main();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  process.stderr.write(`\n✘ 停在这一步：${error.message}\n`);
  if (error.hint) process.stderr.write(`  ${error.hint}\n`);
  process.exitCode = 1;
}
