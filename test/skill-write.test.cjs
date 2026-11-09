'use strict';

/**
 * 技能写端点（/api/mobile/v1/skill/*）的契约测试。
 *
 * 直接驱动真实 handler（不是转写实现）：起一个真 http 服务，把七个 handler 按路径挂上，
 * 根目录与回收站指向临时目录。覆盖：
 *  · 列表要同时看到工作区与全局两个根，并带 scope；
 *  · 读全文回 sha256 revision；
 *  · 新建 / 保存成功换新 revision；保存撞 baseRevision 回 409 且带 base/current/submitted 三份；
 *  · 删除进回收站、回收站能列出、能还原（含记下的原始技能根）；
 *  · 名字非法 / 重名 / 不存在的错误码；
 *  · 路径安全：新建名必须 kebab，定位已有技能只挡路径穿越；
 *  · frontmatter name 必须 kebab，新建时正文 name 对齐目录名；
 *  · 正文超限在写侧是 413，请求体读不出来是 invalid-body；
 *  · 符号链接目录 / SKILL.md 一律拒；
 *  · 同名同时在工作区与全局时按 scope 精确定位。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSkillWriteHandlers, SKILL_MAX_BYTES } = require('../lib/mobile/skill-write.js');

const SKILL = (name, description = '一句话说明') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n正文内容。\n`;

/** 造一段正好 `bytes` 字节的合法技能正文。 */
function skillOfBytes(name, bytes) {
  const head = SKILL(name);
  const pad = bytes - Buffer.byteLength(head, 'utf8');
  return head + 'a'.repeat(pad);
}

/**
 * 造一套临时根 + 挂全部 handler 的真 http 服务。
 * `resolveRoots` 可注入：默认两个根都在；需要「没有会话就没有工作区」时自己传。
 */
function makeHarness(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-write-'));
  const wsRoot = path.join(base, 'workspace', '.dsh', 'skills');
  const userRoot = path.join(base, 'home', 'skills');
  const trashDir = path.join(base, 'trash');
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });

  const resolveRoots = typeof options.resolveRoots === 'function'
    ? options.resolveRoots
    : async () => ({ workspace: wsRoot, user: userRoot });

  const handlers = createSkillWriteHandlers({
    resolveRoots,
    trashDir,
  });
  const routes = {
    '/skill/list': handlers.handleSkillList,
    '/skill/content': handlers.handleSkillContent,
    '/skill/create': handlers.handleSkillCreate,
    '/skill/save': handlers.handleSkillSave,
    '/skill/delete': handlers.handleSkillDelete,
    '/skill/trash': handlers.handleSkillTrash,
    '/skill/trash/restore': handlers.handleSkillTrashRestore,
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const handler = routes[pathname];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
      return;
    }
    Promise.resolve(handler({}, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error && error.message) } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        wsRoot,
        userRoot,
        trashDir,
        base,
        url: (p, q = '') => `http://127.0.0.1:${port}${p}${q}`,
        post: (p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
          method: 'POST',
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function writeSkill(root, name, content) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), content, 'utf8');
}

test('列表：工作区 + 全局两个根都列出来，各带 scope', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'order-coffee', SKILL('order-coffee', '点咖啡'));
    writeSkill(h.userRoot, 'apple-design', SKILL('apple-design', '设计规范'));
    const res = await fetch(h.url('/skill/list', '?sessionId=s1'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.roots, { workspace: true, user: true });
    const byName = Object.fromEntries(body.skills.map((s) => [s.name, s]));
    assert.equal(byName['order-coffee'].scope, 'workspace');
    assert.equal(byName['apple-design'].scope, 'user');
    assert.equal(byName['order-coffee'].description, '点咖啡');
  } finally {
    await h.close();
  }
});

test('读全文：回 sha256 revision 且内容原样', async () => {
  const h = await makeHarness();
  try {
    const content = SKILL('order-coffee');
    writeSkill(h.wsRoot, 'order-coffee', content);
    const res = await fetch(h.url('/skill/content', '?sessionId=s1&name=order-coffee'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content, content);
    assert.match(body.revision, /^[0-9a-f]{64}$/);
    assert.equal(body.scope, 'workspace');
  } finally {
    await h.close();
  }
});

test('读全文：名字非法 400、不存在 404', async () => {
  const h = await makeHarness();
  try {
    let res = await fetch(h.url('/skill/content', '?sessionId=s1&name=../etc/passwd'));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid-name');
    res = await fetch(h.url('/skill/content', '?sessionId=s1&name=nope'));
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not-found');
  } finally {
    await h.close();
  }
});

test('新建：写入指定根；重名 409；名字非法 400', async () => {
  const h = await makeHarness();
  try {
    let res = await h.post('/skill/create', { sessionId: 's1', name: 'new-skill', content: SKILL('new-skill') });
    assert.equal(res.status, 200);
    const ok = await res.json();
    assert.match(ok.revision, /^[0-9a-f]{64}$/);
    assert.equal(ok.scope, 'workspace');
    assert.ok(fs.existsSync(path.join(h.wsRoot, 'new-skill', 'SKILL.md')));

    res = await h.post('/skill/create', { sessionId: 's1', name: 'new-skill', content: SKILL('new-skill') });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'name-taken');

    res = await h.post('/skill/create', { sessionId: 's1', name: 'Bad Name', content: SKILL('x') });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid-name');
  } finally {
    await h.close();
  }
});

test('新建：没 frontmatter 的正文被拒', async () => {
  const h = await makeHarness();
  try {
    const res = await h.post('/skill/create', { sessionId: 's1', name: 'bad', content: '# 只有正文，没有 frontmatter\n' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'missing-frontmatter');
  } finally {
    await h.close();
  }
});

test('新建：frontmatter 的 name 必须是 kebab，否则 400 bad-frontmatter-name', async () => {
  const h = await makeHarness();
  try {
    const res = await h.post('/skill/create', { sessionId: 's1', name: 'wechat-test', content: SKILL('My Skill') });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'bad-frontmatter-name');
    assert.match(body.error.message, /小写字母、数字和连字符/);
    assert.ok(!fs.existsSync(path.join(h.wsRoot, 'wechat-test')), '被拒时不该留下目录');
  } finally {
    await h.close();
  }
});

test('新建：正文 frontmatter 的 name 被对齐成目录名', async () => {
  const h = await makeHarness();
  try {
    // 正文写的是另一个（合法）名字：落盘必须把 frontmatter 改成目录名，否则菜单显示
    // other-name、目录却叫 dir-name，再建一个就互相覆盖。
    const res = await h.post('/skill/create', {
      sessionId: 's1',
      name: 'dir-name',
      content: SKILL('other-name'),
    });
    assert.equal(res.status, 200);
    const written = fs.readFileSync(path.join(h.wsRoot, 'dir-name', 'SKILL.md'), 'utf8');
    assert.match(written, /^---\nname: dir-name\n/);
    // 只动 frontmatter，不重写正文：`# other-name` 那行是用户自己写的内容，改写它属于
    // 越权编辑，而且不影响宿主认技能（宿主只读 frontmatter 的 name）。
    assert.match(written, /\n# other-name\n/, '正文不该被改写');
    const head = written.slice(0, written.indexOf('\n---', 4));
    assert.ok(!head.includes('other-name'), 'frontmatter 里的旧 name 应已被替换');

    const listed = await (await fetch(h.url('/skill/list', '?sessionId=s1'))).json();
    const found = listed.skills.find((s) => s.name === 'dir-name');
    assert.equal(found.nameMatchesDir, true, '菜单显示的标题应与目录名一致');
  } finally {
    await h.close();
  }
});

test('新建：保存（save）不强制改名字', async () => {
  const h = await makeHarness();
  try {
    const original = SKILL('order-coffee');
    writeSkill(h.wsRoot, 'order-coffee', original);
    const got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=order-coffee'))).json();
    const next = SKILL('coffee-order');
    const res = await h.post('/skill/save', {
      sessionId: 's1',
      name: 'order-coffee',
      content: next,
      baseRevision: got.revision,
    });
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(path.join(h.wsRoot, 'order-coffee', 'SKILL.md'), 'utf8'), next);
  } finally {
    await h.close();
  }
});

test('保存：frontmatter 的 name 非 kebab → 400 bad-frontmatter-name', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'order-coffee', SKILL('order-coffee'));
    const got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=order-coffee'))).json();
    const res = await h.post('/skill/save', {
      sessionId: 's1',
      name: 'order-coffee',
      content: SKILL('Order_Coffee'),
      baseRevision: got.revision,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'bad-frontmatter-name');
  } finally {
    await h.close();
  }
});

test('写侧正文超限：正好 256KB 通过，多 1 字节回 413', async () => {
  const h = await makeHarness();
  try {
    const exact = skillOfBytes('edge-skill', SKILL_MAX_BYTES);
    assert.equal(Buffer.byteLength(exact, 'utf8'), SKILL_MAX_BYTES);
    let res = await h.post('/skill/create', { sessionId: 's1', name: 'edge-skill', content: exact });
    assert.equal(res.status, 200);

    const over = skillOfBytes('edge-skill', SKILL_MAX_BYTES + 1);
    assert.equal(Buffer.byteLength(over, 'utf8'), SKILL_MAX_BYTES + 1);
    res = await h.post('/skill/create', { sessionId: 's1', name: 'edge-over', content: over });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'too-large');

    // 保存路径同一口径：读出来是 256KB，改多一点去保存。
    const got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=edge-skill'))).json();
    res = await h.post('/skill/save', {
      sessionId: 's1',
      name: 'edge-skill',
      content: `${exact}a`,
      baseRevision: got.revision,
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'too-large');
  } finally {
    await h.close();
  }
});

test('请求体读不出来：回 400 invalid-body，不退化成 invalid-name', async () => {
  const h = await makeHarness();
  try {
    for (const p of ['/skill/create', '/skill/save', '/skill/delete', '/skill/trash/restore']) {
      const res = await h.post(p, '{"name": "a",');
      assert.equal(res.status, 400, `${p} 坏 JSON 应回 400`);
      assert.equal((await res.json()).error.code, 'invalid-body', `${p} 应回 invalid-body`);
    }
  } finally {
    await h.close();
  }
});

test('列表 / 读 / 删：目录名不是 kebab 的技能也照常能用', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'Wechat_Test', SKILL('Wechat_Test', '大写和下滑线当目录名'));
    const list = await (await fetch(h.url('/skill/list', '?sessionId=s1'))).json();
    assert.equal(list.skills.length, 1);
    assert.equal(list.skills[0].name, 'Wechat_Test');

    const got = await fetch(h.url('/skill/content', `?sessionId=s1&name=${encodeURIComponent('Wechat_Test')}`));
    assert.equal(got.status, 200);
    assert.equal((await got.json()).name, 'Wechat_Test');

    const del = await h.post('/skill/delete', { sessionId: 's1', name: 'Wechat_Test' });
    assert.equal(del.status, 200);
    const delBody = await del.json();
    assert.equal(delBody.trashed, true);

    const trash = await (await fetch(h.url('/skill/trash', '?sessionId=s1'))).json();
    assert.equal(trash.items.length, 1);
    assert.equal(trash.items[0].name, 'Wechat_Test');

    const restore = await h.post('/skill/trash/restore', { sessionId: 's1', entry: trash.items[0].entry });
    assert.equal(restore.status, 200);
    assert.ok(fs.existsSync(path.join(h.wsRoot, 'Wechat_Test', 'SKILL.md')));
  } finally {
    await h.close();
  }
});

test('列表：符号链接目录跟宿主同口径列出来', async () => {
  const h = await makeHarness();
  try {
    const real = path.join(h.base, 'elsewhere', 'linked-skill');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'SKILL.md'), SKILL('linked-skill'), 'utf8');
    fs.symlinkSync(real, path.join(h.wsRoot, 'linked-skill'), 'dir');

    const list = await (await fetch(h.url('/skill/list', '?sessionId=s1'))).json();
    const found = list.skills.find((s) => s.name === 'linked-skill');
    assert.ok(found, '符号链接目录里的技能也应该出现在列表里');
    assert.equal(found.scope, 'workspace');
  } finally {
    await h.close();
  }
});

test('删除：技能目录是符号链接 → 400 symlink-refused', async () => {
  const h = await makeHarness();
  try {
    const real = path.join(h.base, 'elsewhere', 'linked-skill');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'SKILL.md'), SKILL('linked-skill'), 'utf8');
    const link = path.join(h.wsRoot, 'linked-skill');
    fs.symlinkSync(real, link, 'dir');

    const res = await h.post('/skill/delete', { sessionId: 's1', name: 'linked-skill' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'symlink-refused');
    assert.ok(fs.existsSync(path.join(real, 'SKILL.md')), '链接目标不该被搬走');
    assert.ok(fs.existsSync(link), '链接本身也不该被搬走');
  } finally {
    await h.close();
  }
});

test('保存：SKILL.md 是符号链接 → 400 symlink-refused', async () => {
  const h = await makeHarness();
  try {
    const realContent = SKILL('linked-file');
    const realFile = path.join(h.base, 'elsewhere', 'real.md');
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, realContent, 'utf8');
    fs.mkdirSync(path.join(h.wsRoot, 'linked-file'), { recursive: true });
    fs.symlinkSync(realFile, path.join(h.wsRoot, 'linked-file', 'SKILL.md'));

    const got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=linked-file'))).json();
    assert.equal(got.content, realContent);

    const res = await h.post('/skill/save', {
      sessionId: 's1',
      name: 'linked-file',
      content: SKILL('linked-file', '改过'),
      baseRevision: got.revision,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'symlink-refused');
    assert.ok(fs.lstatSync(path.join(h.wsRoot, 'linked-file', 'SKILL.md')).isSymbolicLink(), '链接本身不该被换掉');
    assert.equal(fs.readFileSync(realFile, 'utf8'), realContent, '链接目标不该被写');
  } finally {
    await h.close();
  }
});

test('同名同在工作区与全局：按 scope 精确定位', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'dup', SKILL('dup', '工作区那份'));
    writeSkill(h.userRoot, 'dup', SKILL('dup', '全局那份'));

    let got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=dup&scope=user'))).json();
    assert.equal(got.scope, 'user');
    assert.match(got.content, /全局那份/);
    got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=dup&scope=workspace'))).json();
    assert.equal(got.scope, 'workspace');
    assert.match(got.content, /工作区那份/);

    // 不带 scope 时工作区优先（与宿主 100 < 400 的优先级一致）。
    got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=dup'))).json();
    assert.equal(got.scope, 'workspace');

    const del = await h.post('/skill/delete', { sessionId: 's1', name: 'dup', scope: 'user' });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).scope, 'user');
    assert.ok(!fs.existsSync(path.join(h.userRoot, 'dup')), '全局那份应被删');
    assert.ok(fs.existsSync(path.join(h.wsRoot, 'dup', 'SKILL.md')), '工作区那份应还在');
  } finally {
    await h.close();
  }
});

test('保存：revision 对上就写盘换新 revision', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'order-coffee', SKILL('order-coffee', '旧说明'));
    const got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=order-coffee'))).json();
    const next = SKILL('order-coffee', '新说明');
    const res = await h.post('/skill/save', {
      sessionId: 's1',
      name: 'order-coffee',
      content: next,
      baseRevision: got.revision,
      baseContent: got.content,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.notEqual(body.revision, got.revision);
    assert.equal(fs.readFileSync(path.join(h.wsRoot, 'order-coffee', 'SKILL.md'), 'utf8'), next);
  } finally {
    await h.close();
  }
});

test('保存：baseRevision 不匹配 → 409，回带 base/current/submitted 三份', async () => {
  const h = await makeHarness();
  try {
    const original = SKILL('order-coffee', '原始');
    writeSkill(h.wsRoot, 'order-coffee', original);
    const got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=order-coffee'))).json();

    // 别人改了磁盘上的内容。
    const theirs = SKILL('order-coffee', '别人改的');
    fs.writeFileSync(path.join(h.wsRoot, 'order-coffee', 'SKILL.md'), theirs, 'utf8');
    const mine = SKILL('order-coffee', '我要保存的');

    const res = await h.post('/skill/save', {
      sessionId: 's1',
      name: 'order-coffee',
      content: mine,
      baseRevision: got.revision,
      baseContent: original,
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'revision-conflict');
    const d = body.error.details;
    assert.equal(d.base.content, original);
    assert.equal(d.current.content, theirs);
    assert.equal(d.submitted.content, mine);
    assert.notEqual(d.baseRevision, d.currentRevision);
    assert.equal(d.current.revision, d.currentRevision);
  } finally {
    await h.close();
  }
});

test('保存：技能不存在 404', async () => {
  const h = await makeHarness();
  try {
    const res = await h.post('/skill/save', { sessionId: 's1', name: 'ghost', content: SKILL('ghost'), baseRevision: 'x' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not-found');
  } finally {
    await h.close();
  }
});

test('删除 → 回收站列出 → 还原回原位置', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'order-coffee', SKILL('order-coffee'));
    const del = await (await h.post('/skill/delete', { sessionId: 's1', name: 'order-coffee' })).json();
    assert.equal(del.ok, true);
    assert.equal(del.trashed, true);
    assert.ok(!fs.existsSync(path.join(h.wsRoot, 'order-coffee')), '原目录应已移走');

    const trash = await (await fetch(h.url('/skill/trash', '?sessionId=s1'))).json();
    assert.equal(trash.items.length, 1);
    assert.equal(trash.items[0].name, 'order-coffee');
    assert.equal(trash.items[0].scope, 'workspace');

    const restore = await (await h.post('/skill/trash/restore', { sessionId: 's1', entry: trash.items[0].entry })).json();
    assert.equal(restore.restored, true);
    assert.ok(fs.existsSync(path.join(h.wsRoot, 'order-coffee', 'SKILL.md')), '应已还原出来');
    assert.ok(!fs.existsSync(path.join(h.wsRoot, 'order-coffee', '.dsh-skill-origin')), '回收站标记不该跟回技能目录');
  } finally {
    await h.close();
  }
});

test('回收站条目记原始技能根：没有会话也能还原工作区技能', async () => {
  let noSessionRoots = false;
  const h = await makeHarness({
    resolveRoots: async (ctx, sessionId) => {
      if (noSessionRoots && !sessionId) return { workspace: null, user: path.join(h.base, 'home', 'skills') };
      return { workspace: path.join(h.base, 'workspace', '.dsh', 'skills'), user: path.join(h.base, 'home', 'skills') };
    },
  });
  try {
    writeSkill(h.wsRoot, 'order-coffee', SKILL('order-coffee'));
    const del = await (await h.post('/skill/delete', { sessionId: 's1', name: 'order-coffee' })).json();
    assert.equal(del.scope, 'workspace');
    assert.ok(fs.existsSync(path.join(h.trashDir, del.entry, '.dsh-skill-origin')), '删除时要记下原始技能根');
    const origin = JSON.parse(fs.readFileSync(path.join(h.trashDir, del.entry, '.dsh-skill-origin'), 'utf8'));
    assert.equal(origin.scope, 'workspace');
    assert.equal(origin.root, h.wsRoot);

    // 这次请求没有会话 → 按 scope 推算会拿不到工作区，只能靠记下的根还原。
    noSessionRoots = true;
    const res = await h.post('/skill/trash/restore', { entry: del.entry });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.restored, true);
    assert.equal(body.scope, 'workspace');
    assert.ok(fs.existsSync(path.join(h.wsRoot, 'order-coffee', 'SKILL.md')), '应还原回工作区技能根');
  } finally {
    await h.close();
  }
});

test('回收站撞名：时间戳往后挪，条目仍是三段格式且能还原', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'dup', SKILL('dup', '第一份'));
    const first = await (await h.post('/skill/delete', { sessionId: 's1', name: 'dup' })).json();
    writeSkill(h.wsRoot, 'dup', SKILL('dup', '第二份'));
    const second = await (await h.post('/skill/delete', { sessionId: 's1', name: 'dup' })).json();
    assert.notEqual(second.entry, first.entry);
    assert.match(second.entry, /^workspace__dup__\d+$/);

    const trash = await (await fetch(h.url('/skill/trash', '?sessionId=s1'))).json();
    assert.equal(trash.items.length, 2, '两条都要能在回收站里列出来');

    // 原位置空着，两条都应该能还原（只验证条目名能反解出来）。
    for (const item of trash.items) {
      const res = await h.post('/skill/trash/restore', { sessionId: 's1', entry: item.entry });
      assert.equal(res.status, 200, `${item.entry} 应该能还原`);
      assert.ok(fs.existsSync(path.join(h.wsRoot, 'dup', 'SKILL.md')));
      fs.rmSync(path.join(h.wsRoot, 'dup'), { recursive: true, force: true });
    }
  } finally {
    await h.close();
  }
});

test('还原：条目里记的根不可用（相对路径 / 回收站内部）→ 400 scope-unavailable', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'order-coffee', SKILL('order-coffee'));
    const del = await (await h.post('/skill/delete', { sessionId: 's1', name: 'order-coffee' })).json();
    fs.writeFileSync(
      path.join(h.trashDir, del.entry, '.dsh-skill-origin'),
      JSON.stringify({ root: 'relative/path', scope: 'workspace' }),
      'utf8',
    );
    const res = await h.post('/skill/trash/restore', { sessionId: 's1', entry: del.entry });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'scope-unavailable');
  } finally {
    await h.close();
  }
});

test('删除：baseRevision 不符 → 409 revision-conflict', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'order-coffee', SKILL('order-coffee', '原始'));
    const got = await (await fetch(h.url('/skill/content', '?sessionId=s1&name=order-coffee'))).json();
    fs.writeFileSync(path.join(h.wsRoot, 'order-coffee', 'SKILL.md'), SKILL('order-coffee', '改过'), 'utf8');
    const res = await h.post('/skill/delete', { sessionId: 's1', name: 'order-coffee', baseRevision: got.revision });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'revision-conflict');
  } finally {
    await h.close();
  }
});

test('还原：原位置已有同名 → 409 name-taken', async () => {
  const h = await makeHarness();
  try {
    writeSkill(h.wsRoot, 'dup', SKILL('dup'));
    const del = await (await h.post('/skill/delete', { sessionId: 's1', name: 'dup' })).json();
    writeSkill(h.wsRoot, 'dup', SKILL('dup', '新的一份'));
    const res = await h.post('/skill/trash/restore', { sessionId: 's1', entry: del.entry });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'name-taken');
  } finally {
    await h.close();
  }
});
