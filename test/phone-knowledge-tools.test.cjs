'use strict';

/**
 * 知识检索 / 按需读全文 / 站点命令 / 任务草稿 的守卫。
 *
 * 这些工具坏起来多半是「安静地少给了东西」或「读文件越界」，所以这里验：
 * - 搜索能按名字、别名、包名、域名与正文命中，且结果标了 untrusted；
 * - 读正文能读主文件与 references/ 子文档，越界、未列出的文件一律拒；
 * - skill_search / skill_read 能读到技能正文与 references/、scripts/；
 * - site-commands 的声明解析、参数校验与清单；
 * - learn 从动作序列提炼草稿、脱敏本次输入、写进待审目录而不是正式知识。
 *
 * 运行：node --test test/phone-knowledge-tools.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const knowledgeTools = require('../lib/mobile/phone/knowledge-tools.js');
const siteCommands = require('../lib/mobile/phone/site-commands.js');
const learn = require('../lib/mobile/phone/learn.js');

const { knowledgeSearch, knowledgeRead, skillSearch, skillRead, knowledgeToolDefs } = knowledgeTools;
const { draftFromTask, learnFromTask, writeDraft } = learn;

/** 临时目录，带清理。 */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ── knowledge_search ──────────────────────────────────────────────────── */

test('knowledge_search 按别名 / 包名命中 App，结果带 untrusted 与四个字段', () => {
  for (const query of ['微信', 'WeChat', 'com.tencent.mm']) {
    const result = knowledgeSearch({ query });
    assert.equal(result.untrusted, true);
    assert.ok(Array.isArray(result.matches));
    const hit = result.matches.find((m) => m.name === 'wechat');
    assert.ok(hit, `「${query}」应命中 wechat`);
    assert.deepEqual(Object.keys(hit).sort(), ['description', 'display', 'kind', 'name']);
    assert.equal(hit.kind, 'app');
  }
});

test('knowledge_search 按域名命中网站，按 kind 过滤互不串', () => {
  const site = knowledgeSearch({ query: 'bilibili', kind: 'site' });
  assert.ok(site.matches.length >= 1);
  assert.ok(site.matches.every((m) => m.kind === 'site'));
  assert.ok(site.matches.some((m) => m.name === 'bilibili.com'));

  const app = knowledgeSearch({ query: 'bilibili', kind: 'app' });
  assert.ok(app.matches.every((m) => m.kind === 'app'));
});

test('knowledge_search 能在正文里命中关键词', () => {
  const result = knowledgeSearch({ query: '公众号' });
  assert.ok(result.matches.some((m) => m.name === 'wechat'), '正文提到公众号的应命中 wechat');
});

test('knowledge_search 空查询报错，结果不超过 10 条', () => {
  assert.throws(() => knowledgeSearch({ query: '   ' }), /搜什么/);
  const result = knowledgeSearch({ query: 'app' });
  assert.ok(result.matches.length <= 10);
});

/* ── knowledge_read ────────────────────────────────────────────────────── */

test('knowledge_read 读 App 正文', () => {
  const value = knowledgeRead({ name: 'wechat' });
  assert.equal(value.kind, 'app');
  assert.equal(value.file, 'wechat.md');
  assert.ok(value.content.includes('微信'));
  assert.equal(value.untrusted, true);
  assert.ok(value.files.includes('wechat.md'));
});

test('knowledge_read 打开网站的 references/ 子文档', () => {
  const value = knowledgeRead({ name: 'github.com', file_path: 'references/repo-fields.md' });
  assert.equal(value.kind, 'site');
  assert.equal(value.file, 'references/repo-fields.md');
  assert.ok(value.content.includes('full_name'));
});

test('knowledge_read 列出网站只读命令（没有则为空或省略）', () => {
  const value = knowledgeRead({ name: 'github.com' });
  assert.ok(Array.isArray(value.files));
  // 现有站点知识还没有 commands，这里只要求形状正确、不报错。
  if (value.commands !== undefined) assert.ok(Array.isArray(value.commands));
});

test('knowledge_read 拒绝越界与未列出的文件', () => {
  assert.throws(
    () => knowledgeRead({ name: 'github.com', file_path: '../../../etc/passwd' }),
    /目录内|没有文件/,
  );
  assert.throws(
    () => knowledgeRead({ name: 'github.com', file_path: 'README.md' }),
    /没有文件/,
  );
});

test('knowledge_read 名字不认识时报错；前缀可消歧', () => {
  assert.throws(() => knowledgeRead({ name: 'no-such-thing' }), /没有找到/);
  assert.throws(() => knowledgeRead({ name: '' }), /要读哪一条/);
  // bilibili App 与网站都存在，带前缀应各读各的。
  const app = knowledgeRead({ name: 'app:bilibili' });
  assert.equal(app.kind, 'app');
  const site = knowledgeRead({ name: 'site:bilibili.com' });
  assert.equal(site.kind, 'site');
});

/* ── skill_search / skill_read ─────────────────────────────────────────── */

test('skill_search 命中内置技能，skill_read 读正文与 references/scripts', () => {
  const found = skillSearch({ query: 'skill-authoring' });
  assert.ok(found.matches.some((m) => m.name === 'skill-authoring'));
  assert.equal(found.untrusted, true);

  const main = skillRead({ name: 'skill-authoring' });
  assert.equal(main.kind, 'skill');
  assert.equal(main.file, 'SKILL.md');
  assert.ok(main.content.length > 0);

  const ref = skillRead({ name: 'skill-authoring', file_path: 'references/examples.md' });
  assert.equal(ref.file, 'references/examples.md');
  assert.ok(ref.content.length >= 0);

  const script = skillRead({ name: 'skill-authoring', file_path: 'scripts/manifest.json' });
  assert.equal(script.file, 'scripts/manifest.json');
});

test('skill_read 越界被拒', () => {
  assert.throws(
    () => skillRead({ name: 'skill-authoring', file_path: '../../../../etc/passwd' }),
    /目录内|没有文件/,
  );
});

/* ── site-commands ─────────────────────────────────────────────────────── */

const VALID_COMMAND = `/* dsh-command
 * name: list_jobs
 * description: 列出当前搜索结果里的职位
 * arg: limit integer - 最多几条
 * arg: query string required - 只保留标题含这段字的
 * returns: [{title, company, salary, url}]
 */
const rows = [...document.querySelectorAll('.job')];
return rows.slice(0, args.limit || 20).map((el) => ({ title: el.innerText }));
`;

test('site-commands 解析一条合法命令', () => {
  const parsed = siteCommands.parseCommand('scripts/list_jobs.js', VALID_COMMAND);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.decl);
  assert.equal(parsed.decl.name, 'list_jobs');
  assert.equal(parsed.decl.readOnly, true);
  assert.equal(parsed.decl.args.length, 2);
  assert.equal(parsed.decl.args.find((a) => a.name === 'query').required, true);
  assert.ok(parsed.body.includes('querySelectorAll'));
});

test('site-commands 拒绝 name 与文件名不一致、缺 returns、readOnly=false', () => {
  const bad = `/* dsh-command
 * name: other
 * description: x
 * readOnly: false
 */
return 1;
`;
  const parsed = siteCommands.parseCommand('scripts/list_jobs.js', bad);
  assert.equal(parsed.decl, null);
  assert.ok(parsed.errors.some((e) => e.includes('与文件名')));
  assert.ok(parsed.errors.some((e) => e.includes('returns')));
  assert.ok(parsed.errors.some((e) => e.includes('readOnly')));
});

test('site-commands validateCommand 检查必填、类型与未声明参数', () => {
  const { decl } = siteCommands.parseCommand('scripts/list_jobs.js', VALID_COMMAND);
  assert.equal(siteCommands.validateCommand(decl, { query: '前端', limit: 10 }), null);
  assert.match(siteCommands.validateCommand(decl, {}), /需要参数 'query'/);
  assert.match(siteCommands.validateCommand(decl, { query: 1 }), /必须是 string/);
  assert.match(siteCommands.validateCommand(decl, { query: 'x', limit: 1.5 }), /必须是 integer/);
  assert.match(siteCommands.validateCommand(decl, { query: 'x', nope: 1 }), /不是 .* 的参数/);
});

test('site-commands listCommands 读站点目录下的 scripts/*.js', () => {
  const dir = tempDir('dsh-site-cmd-');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'list_jobs.js'), VALID_COMMAND, 'utf8');
  // 没有命令头的普通脚本应被忽略。
  fs.writeFileSync(path.join(dir, 'scripts', 'helper.js'), 'module.exports = 1;\n', 'utf8');

  const { commands, errors } = siteCommands.listCommands(dir);
  assert.equal(errors.length, 0);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'list_jobs');
  assert.ok(siteCommands.formatCommandLine(commands[0]).includes('list_jobs'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('site-commands 执行契约是只读/同源/禁网/打码', () => {
  assert.equal(siteCommands.EXECUTION_CONTRACT.readOnly, true);
  assert.equal(siteCommands.EXECUTION_CONTRACT.sameOrigin, true);
  assert.equal(siteCommands.EXECUTION_CONTRACT.network, false);
  assert.equal(siteCommands.EXECUTION_CONTRACT.redactPasswords, true);
});

/* ── learn ─────────────────────────────────────────────────────────────── */

const SAMPLE_TRACE = {
  sessionId: 'sess-learn-1',
  packageName: 'com.tencent.mm',
  appName: '微信',
  outcome: 'done',
  steps: [
    { action: 'app.open', args: { packageName: 'com.tencent.mm' } },
    { action: 'tap', args: { target: '搜索' } },
    { action: 'type', args: { target: '搜索框', text: '张三 13800001111' } },
    { action: 'tap', args: { target: '第一个结果' } },
    { action: 'swipe', args: { direction: 'down' } },
  ],
};

test('learn 从 App 动作序列提炼草稿：kind/status/正文事实', () => {
  const draft = draftFromTask(SAMPLE_TRACE);
  assert.equal(draft.kind, 'app');
  assert.equal(draft.name, 'com.tencent.mm');
  assert.equal(draft.status, 'draft');
  assert.ok(draft.markdown.includes('status: draft'));
  assert.ok(draft.markdown.includes('## 是什么'));
  assert.ok(draft.markdown.includes('## 界面'));
  assert.ok(draft.markdown.includes('## 功能'));
  assert.ok(draft.markdown.includes('搜索'));
});

test('learn 脱敏：输入的原文与长数字串不进草稿', () => {
  const draft = draftFromTask(SAMPLE_TRACE);
  assert.ok(!draft.markdown.includes('张三'), '输入的人名应被脱敏');
  assert.ok(!draft.markdown.includes('13800001111'), '长数字串应被脱敏');
  assert.ok(draft.markdown.includes('<参数>'));
});

test('learn 从网站轨迹提炼 kind=site', () => {
  const draft = draftFromTask({
    sessionId: 's2',
    url: 'https://github.com/owner/repo',
    siteName: 'GitHub',
    outcome: 'done',
    steps: [{ action: 'tap', args: { target: 'Issues' } }],
  });
  assert.equal(draft.kind, 'site');
  assert.equal(draft.name, 'github.com');
  assert.ok(draft.markdown.includes('kind: site'));
});

test('learn 写进待审目录，不落在正式 knowledge 里', () => {
  const dir = tempDir('dsh-drafts-');
  const previous = process.env.DSH_PHONE_KNOWLEDGE_DRAFT_DIR;
  process.env.DSH_PHONE_KNOWLEDGE_DRAFT_DIR = dir;
  try {
    assert.equal(learn.draftsDir(), dir);
    const written = learnFromTask(SAMPLE_TRACE);
    assert.equal(written.status, 'draft');
    assert.ok(fs.existsSync(written.path));
    assert.ok(written.path.startsWith(dir + path.sep));
    assert.ok(!written.path.includes(`${path.sep}knowledge${path.sep}`));
    const text = fs.readFileSync(written.path, 'utf8');
    assert.ok(text.includes('status: draft'));
  } finally {
    if (previous === undefined) delete process.env.DSH_PHONE_KNOWLEDGE_DRAFT_DIR;
    else process.env.DSH_PHONE_KNOWLEDGE_DRAFT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('learn writeDraft 拒绝把文件名带出待审目录', () => {
  const dir = tempDir('dsh-drafts-2-');
  try {
    assert.throws(
      () => writeDraft({ kind: 'app', slug: '../../evil', name: 'x', markdown: 'x' }, { dir }),
      /待审目录|逃出/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 工具定义形状 ──────────────────────────────────────────────────────── */

test('knowledgeToolDefs 给出四个工具，名字与 output.schema 齐全', () => {
  const defs = knowledgeToolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), [
    'knowledge_read',
    'knowledge_search',
    'skill_read',
    'skill_search',
  ]);
  for (const def of defs) {
    assert.equal(typeof def.execute, 'function');
    assert.equal(def.output.schema.type, 'object');
    assert.ok(def.parameters && typeof def.parameters === 'object');
  }
});
