'use strict';

/**
 * 审批卡「事实行」折算的守卫（`lib/mobile/approval-facts.js`）。
 *
 * 纯函数：给定工具名 + 原始参数，锁定「这一行写什么、要不要高亮、按什么动作类别记」。
 * 最要紧的两条红线：
 *  - **解析不出来不出这一行**（`fact: ''`），绝不糊一句会让用户误判的话；
 *  - **高亮只在解析出的程序位命中**：`grep "git push"` 只是提到 push，不当成推送。
 * 用例直接取自设计稿，改动实现时这里一红就是行为变了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const facts = require('../lib/mobile/approval-facts.js');

const CWD = '/repo';
const derive = (calls, extra = {}) => facts.deriveApprovalFacts(calls, { cwd: CWD, ...extra });

test('改一个文件：列出文件名，不高亮', () => {
  const r = derive({ toolName: 'write', args: { file_path: '/repo/app/src/ApprovalPanel.tsx', content: 'x' } });
  assert.equal(r.fact, '改 ApprovalPanel.tsx');
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'write:app@unknown');
  assert.equal(r.rememberable, true);
});

test('改多个文件：分句合并', () => {
  const r = derive([
    { toolName: 'write', args: { path: '/repo/app/src/A.tsx', content: 'a' } },
    { toolName: 'edit', args: { path: '/repo/app/src/B.tsx', old_string: 'x', new_string: 'y' } },
  ]);
  assert.equal(r.fact, '改 A.tsx；改 B.tsx');
  assert.equal(r.highlight, false);
});

test('git commit：提交，不高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'git commit -m "补事实行"' } });
  assert.equal(r.fact, '提交：补事实行');
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'bash:git:commit@unknown');
});

test('git push：推送并高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'git push origin main' } });
  assert.equal(r.fact, '推送 → origin/main');
  assert.equal(r.highlight, true);
  assert.equal(r.classKey, 'bash:git:push@unknown');
});

test('rm：删除并高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'rm -rf build' } });
  assert.equal(r.fact, '删 build');
  assert.equal(r.highlight, true);
  assert.equal(r.classKey, 'bash:rm@unknown');
});

test('装包：装并高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'pnpm add lodash' } });
  assert.equal(r.fact, '装 lodash（pnpm）');
  assert.equal(r.highlight, true);
  assert.equal(r.classKey, 'bash:pnpm:add@unknown');
});

test('curl：连域名，不高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'curl -s https://api.example.com/v1/x' } });
  assert.equal(r.fact, '连 api.example.com');
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'bash:curl@unknown');
});

test('解析不出的壳：如实说，不高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'node -e "$(cat script.js)"' } });
  assert.equal(r.fact, '跑 node（内容无法静态解析）');
  assert.equal(r.highlight, false);
});

test('参数取不到：不出这一行（不是「未知」），不给「以后都同意」', () => {
  const r = derive({ toolName: 'bash', args: null });
  assert.equal(r.fact, '');
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'tool:bash@unknown');
  assert.equal(r.rememberable, false);
});

test('误判反例：命令里只是提到 push，不当成推送', () => {
  const r = derive({ toolName: 'bash', args: { command: 'grep -rn "git push" docs/' } });
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'bash:grep@unknown');
});

test('长清单截断：保数量、整行不超上限', () => {
  const names = Array.from({ length: 6 }, (_, i) => `averyverylongname${i + 1}`);
  const r = derive({ toolName: 'bash', args: { command: `rm ${names.join(' ')}` } });
  assert.match(r.fact, /等 6 个/);
  assert.ok(r.fact.length <= facts.FACT_MAX, r.fact);
});

/**
 * 「以后都同意」的粒度：删除 / 推送 / 装软件这三类**不给**这颗按钮。
 *
 * 现状的坏处是具体的：记住 `bash:rm` 等于把任意 `rm`（包括 `rm -rf ~`）变成静默放行 ——
 * 那不是「同类」，只是「同名」。宁可多推一张卡。
 */
test('删除 / 推送 / reset / clean / 装软件都不给「以后都同意」', () => {
  const cases = [
    ['rm -rf build', 'bz-rm'],
    ['rm -rf ~', 'bz-rm-home'],
    ['git push origin main', 'bz-push'],
    ['git reset --hard HEAD~3', 'bz-reset'],
    ['git clean -fd', 'bz-clean'],
    ['git rm -r src/old', 'bz-git-rm'],
    ['pnpm add lodash', 'bz-pnpm'],
    ['npm i -D vitest', 'bz-npm'],
    ['pip install requests', 'bz-pip'],
  ];
  for (const [command, label] of cases) {
    const r = derive({ toolName: 'bash', args: { command } });
    assert.equal(r.rememberable, false, `${label}（${command}）不该给第三颗按钮`);
  }
});

test('多段命令里藏着删除也不给「以后都同意」', () => {
  const r = derive({ toolName: 'bash', args: { command: 'cd app && rm -rf dist' } });
  assert.equal(r.rememberable, false, '组合命令的类别键是 bash:cd+rm，危险那一段不许被藏掉');
});

test('同一批调用里只要有一条不可逆，整张卡都不给「以后都同意」', () => {
  const r = derive([
    { toolName: 'write', args: { path: '/repo/app/src/A.tsx', content: 'a' } },
    { toolName: 'bash', args: { command: 'rm -rf build' } },
  ]);
  assert.equal(r.rememberable, false, '多调用取最危险那条做类别键，判定也跟着它');
});

test('只读 / 改文件 / 联网这些照旧可以记（收紧不能把整颗按钮废掉）', () => {
  assert.equal(derive({ toolName: 'write', args: { path: '/repo/app/src/A.tsx', content: 'x' } }).rememberable, true);
  assert.equal(derive({ toolName: 'bash', args: { command: 'git commit -m "x"' } }).rememberable, true);
  assert.equal(derive({ toolName: 'bash', args: { command: 'curl -s https://api.example.com/x' } }).rememberable, true);
});

test('多段命令按段合并，程序名进类别键', () => {
  const r = derive({ toolName: 'bash', args: { command: 'cd app && rm -rf dist' } });
  assert.match(r.fact, /删 dist/);
  assert.equal(r.highlight, true);
  assert.equal(r.classKey, 'bash:cd+rm@unknown');
});

/**
 * 沙箱档位进类别键：`<base>@<tier>`。
 *
 * 同一个动作在「工作区内」与「完全访问」下是**不同的键** —— 记住前者不该顺带放行后者。
 * 档位不改变可记性（两个键各自都能记），但撤销页要能看出这是哪一档。
 */
test('档位不同则类别键不同，标签带中文档位尾巴', () => {
  const call = { toolName: 'bash', args: { command: 'curl -s https://api.example.com/x' } };
  const ws = derive(call, { tier: 'workspace-write' });
  const danger = derive(call, { tier: 'danger-full-access' });
  const unknown = derive(call);
  assert.equal(ws.classKey, 'bash:curl@workspace-write');
  assert.equal(danger.classKey, 'bash:curl@danger-full-access');
  assert.equal(unknown.classKey, 'bash:curl@unknown');
  assert.notEqual(ws.classKey, danger.classKey);
  assert.equal(ws.classLabel, 'Bash · 联网请求（工作区内）');
  assert.equal(danger.classLabel, 'Bash · 联网请求（完全访问）');
  assert.equal(unknown.classLabel, 'Bash · 联网请求');
  assert.equal(ws.rememberable, true);
  assert.equal(danger.rememberable, true);
});

test('档位解析不到就是 unknown，可记性不变', () => {
  const r = derive({ toolName: 'bash', args: { command: 'pnpm add lodash' } }, { tier: 'weird' });
  assert.equal(r.classKey, 'bash:pnpm:add@unknown');
  assert.equal(r.rememberable, false);
  assert.equal(facts.labelOf('bash:rm@danger-full-access'), 'Bash · 删除文件（完全访问）');
  assert.equal(facts.labelOf('bash:rm'), 'Bash · 删除文件');
});

test('labelOf 吃得下带档位的键（撤销页要看得懂）', () => {
  assert.equal(facts.labelOf('write:app@workspace-write'), '改文件 · app（工作区内）');
  assert.equal(facts.labelOf('phone:tap@danger-full-access'), '在手机上点按（完全访问）');
  assert.equal(facts.labelOf('tool:bash@unknown'), '工具 · bash');
});

/**
 * 套壳命令：真正的动作在参数里。`sudo rm`、`env X=1 rm`、`bash -lc '…'`、`xargs rm`、
 * `find -exec rm` 都不许因为「看见的第一个程序不是 rm」就被当成无害的一类。
 */
test('套壳命令剥到内层程序：sudo / env / time / nice / nohup / command / exec / stdbuf', () => {
  const cases = [
    ['sudo rm -rf build', 'bz-sudo'],
    ['sudo -u root -E rm -rf build', 'bz-sudo-u'],
    ['env FOO=1 rm -rf build', 'bz-env'],
    ['env -u FOO rm -rf build', 'bz-env-u'],
    ['time rm -rf build', 'bz-time'],
    ['nice -n 10 rm -rf build', 'bz-nice'],
    ['nohup rm -rf build', 'bz-nohup'],
    ['command rm -rf build', 'bz-command'],
    ['exec rm -rf build', 'bz-exec'],
    ['stdbuf -oL rm -rf build', 'bz-stdbuf'],
    ['FOO=1 rm -rf build', 'bz-assign'],
  ];
  for (const [command, label] of cases) {
    const r = derive({ toolName: 'bash', args: { command } });
    assert.equal(r.classKey, 'bash:rm@unknown', `${label}（${command}）应剥到 rm`);
    assert.equal(r.highlight, true, `${label}（${command}）应高亮`);
    assert.equal(r.rememberable, false, `${label}（${command}）不该给第三颗按钮`);
    assert.match(r.fact, /删 build/, label);
  }
});

test('bash -lc / sh -c 递归剥一层', () => {
  const r = derive({ toolName: 'bash', args: { command: "bash -lc 'git push origin main'" } });
  assert.equal(r.fact, '推送 → origin/main');
  assert.equal(r.classKey, 'bash:git:push@unknown');
  assert.equal(r.rememberable, false);

  const r2 = derive({ toolName: 'bash', args: { command: 'sh -c "rm -rf dist"' } });
  assert.equal(r2.classKey, 'bash:rm@unknown');
  assert.equal(r2.rememberable, false);
});

test('xargs / find -exec 取内层程序', () => {
  const xargs = derive({ toolName: 'bash', args: { command: 'find . -name "*.log" | xargs rm -f' } });
  assert.equal(xargs.classKey, 'bash:find+rm@unknown');
  assert.equal(xargs.highlight, true);
  assert.equal(xargs.rememberable, false);

  const findExec = derive({ toolName: 'bash', args: { command: 'find . -name "*.tmp" -exec rm {} \\;' } });
  assert.equal(findExec.classKey, 'bash:rm@unknown');
  assert.equal(findExec.rememberable, false);
});

test('git 全局选项跳过再取子命令', () => {
  for (const command of [
    'git -C /repo push origin main',
    'git -c core.pager=cat push origin main',
    'git --git-dir=/repo/.git push origin main',
    'git --work-tree=/repo push origin main',
  ]) {
    const r = derive({ toolName: 'bash', args: { command } });
    assert.equal(r.classKey, 'bash:git:push@unknown', command);
    assert.equal(r.highlight, true, command);
    assert.equal(r.rememberable, false, command);
  }
});

test('引号感知分词：带空格的路径不被切碎', () => {
  const r = derive({ toolName: 'bash', args: { command: 'rm -rf "my build dir"' } });
  assert.match(r.fact, /删 my build dir/);
  assert.equal(r.classKey, 'bash:rm@unknown');
});

/**
 * 装包类补全：`npx` / `pnpm dlx` / `npm ci` / `python3 -m pip install` / `uv` / `uvx` /
 * `brew install` 都要高亮且不可记 —— 它们都会下载并执行第三方代码。
 */
test('装包的各种写法：高亮且不给「以后都同意」', () => {
  const cases = [
    ['npx create-react-app demo', 'bash:npx'],
    ['uvx ruff check .', 'bash:uvx'],
    ['pnpm dlx shadcn add button', 'bash:pnpm:dlx'],
    ['npm ci', 'bash:npm:ci'],
    ['python3 -m pip install requests', 'bash:pip:install'],
    ['uv pip install requests', 'bash:uv:install'],
    ['uv add httpx', 'bash:uv:add'],
    ['brew install jq', 'bash:brew:install'],
  ];
  for (const [command, classKey] of cases) {
    const r = derive({ toolName: 'bash', args: { command } });
    assert.equal(r.highlight, true, `${command} 应高亮`);
    assert.equal(r.rememberable, false, `${command} 不该给第三颗按钮`);
    assert.equal(r.classKey, `${classKey}@unknown`, command);
  }
});

/**
 * 解释器 / 套壳程序：参数里才是真正的动作，类别本身没有区分度，一律不给「以后都同意」。
 */
test('解释器与套壳程序不可记', () => {
  for (const command of [
    'node script.js',
    'python3 tool.py',
    'python -c "print(1)"',
    'ruby x.rb',
    'perl x.pl',
    'bash run.sh',
    'zsh run.zsh',
    'eval "$CMD"',
    'source ./env.sh',
  ]) {
    const r = derive({ toolName: 'bash', args: { command } });
    assert.equal(r.rememberable, false, `${command} 不该给第三颗按钮`);
  }
});

test('run_code / 终端类工具：解析不出就如实说，不给记', () => {
  const runCode = derive({ toolName: 'run_code', args: { code: 'x' } });
  assert.equal(runCode.fact, '跑代码（内容无法静态解析）');
  assert.equal(runCode.classKey, 'tool:run_code@unknown');
  assert.equal(runCode.rememberable, false);

  const noCmd = derive({ toolName: 'terminal_send', args: {} });
  assert.equal(noCmd.fact, '在终端执行命令');
  assert.equal(noCmd.rememberable, false);

  const withCmd = derive({ toolName: 'terminal_send', args: { command: 'git push origin main' } });
  assert.equal(withCmd.classKey, 'bash:git:push@unknown');
  assert.equal(withCmd.rememberable, false);

  const pwsh = derive({ toolName: 'pwsh', args: { cmd: 'rm -rf build' } });
  assert.equal(pwsh.classKey, 'bash:rm@unknown');
  assert.equal(pwsh.rememberable, false);
});

test('str_replace_editor 按改文件处理', () => {
  const r = derive({ toolName: 'str_replace_editor', args: { path: '/repo/app/src/A.tsx', old_string: 'x', new_string: 'y' } });
  assert.equal(r.fact, '改 A.tsx');
  assert.equal(r.classKey, 'edit:app@unknown');
});

/**
 * 手机类：只有「打开某个具体应用 / 链接」够具体，可以记；其余动作太笼统，每次问。
 */
test('手机类工具：点按不可记，打开应用可记', () => {
  const tap = derive({ toolName: 'phone_tap', args: { target: '发送按钮' } });
  assert.equal(tap.fact, '在手机上点按 发送按钮');
  assert.equal(tap.classKey, 'phone:tap@unknown');
  assert.equal(tap.rememberable, false);

  assert.equal(derive({ toolName: 'phone_tap', args: {} }).fact, '在手机上点按');
  assert.equal(derive({ toolName: 'phone_set_alarm', args: {} }).fact, '设置闹钟');
  assert.equal(derive({ toolName: 'phone_set_alarm', args: {} }).rememberable, false);
  assert.equal(derive({ toolName: 'phone_scroll', args: {} }).fact, '操作手机界面');
  assert.equal(derive({ toolName: 'phone_scroll', args: {} }).rememberable, false);

  const openApp = derive({ toolName: 'phone_open_app', args: { packageName: 'com.tencent.mm' } });
  assert.equal(openApp.classKey, 'phone:open_app:com.tencent.mm@unknown');
  assert.equal(openApp.rememberable, true);

  const openLink = derive({ toolName: 'phone_open_link', args: { uri: 'https://example.com/x' } });
  assert.equal(openLink.classKey, 'phone:open_link:example.com@unknown');
  assert.equal(openLink.rememberable, true);

  // 打开但没有具体目标：退回 tool:*，不可记。
  assert.equal(derive({ toolName: 'phone_open_app', args: {} }).rememberable, false);
});

test('插件 / 定时任务 / 扩展 / mcp 类工具都有话说，且不可记', () => {
  assert.equal(derive({ toolName: 'plugin_manager', args: {} }).fact, '管理插件');
  assert.equal(derive({ toolName: 'schedule_create', args: {} }).fact, '设置定时任务');
  assert.equal(derive({ toolName: 'extension_present', args: {} }).fact, '展示扩展');
  assert.equal(derive({ toolName: 'mcp__fs__read', args: {} }).fact, '调用 mcp__fs__read');
  for (const name of ['plugin_manager', 'schedule_create', 'extension_present', 'mcp__fs__read']) {
    assert.equal(derive({ toolName: name, args: {} }).rememberable, false, name);
  }
});

/**
 * 写文件越出工作区：类别键退化成 `*:abs`，不可记 —— 「工作区外随便写」不是一类能记住的动作。
 */
test('write 越界到 abs 且不可记；相对路径先拼 cwd', () => {
  const inside = derive({ toolName: 'write', args: { path: 'app/src/A.tsx', content: 'x' } });
  assert.equal(inside.classKey, 'write:app@unknown');
  assert.equal(inside.rememberable, true);

  const outside = derive({ toolName: 'write', args: { path: '/etc/hosts', content: 'x' } });
  assert.equal(outside.classKey, 'write:abs@unknown');
  assert.equal(outside.rememberable, false);

  const relative = derive({ toolName: 'edit', args: { path: '../other/x.ts', old_string: 'a', new_string: 'b' } });
  assert.equal(relative.classKey, 'edit:abs@unknown');
  assert.equal(relative.rememberable, false);

  // 没有 cwd：一律 abs，不可记。
  const noCwd = facts.deriveApprovalFacts({ toolName: 'write', args: { path: 'app/src/A.tsx', content: 'x' } });
  assert.equal(noCwd.classKey, 'write:abs@unknown');
  assert.equal(noCwd.rememberable, false);
});

