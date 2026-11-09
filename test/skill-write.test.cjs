'use strict';

/**
 * 技能写端点（/api/mobile/v1/skill/*）的契约测试。
 *
 * 直接驱动真实 handler（不是转写实现）：起一个真 http 服务，把七个 handler 按路径挂上，
 * 根目录与回收站指向临时目录。覆盖：
 *  · 列表要同时看到工作区与全局两个根，并带 scope；
 *  · 读全文回 sha256 revision；
 *  · 新建 / 保存成功换新 revision；保存撞 baseRevision 回 409 且带 base/current/submitted 三份；
 *  · 删除进回收站、回收站能列出、能还原；
 *  · 名字非法 / 重名 / 不存在的错误码；
 *  · 路径安全：技能名必须 kebab，不接受任何路径片段。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSkillWriteHandlers } = require('../lib/mobile/skill-write.js');

const SKILL = (name, description = '一句话说明') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n正文内容。\n`;

/** 造一套临时根 + 挂全部 handler 的真 http 服务。 */
function makeHarness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-write-'));
  const wsRoot = path.join(base, 'workspace', '.dsh', 'skills');
  const userRoot = path.join(base, 'home', 'skills');
  const trashDir = path.join(base, 'trash');
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });

  const handlers = createSkillWriteHandlers({
    resolveRoots: async () => ({ workspace: wsRoot, user: userRoot }),
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
    let res = await fetch(h.url('/skill/create'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'new-skill', content: SKILL('new-skill') }),
    });
    assert.equal(res.status, 200);
    const ok = await res.json();
    assert.match(ok.revision, /^[0-9a-f]{64}$/);
    assert.equal(ok.scope, 'workspace');
    assert.ok(fs.existsSync(path.join(h.wsRoot, 'new-skill', 'SKILL.md')));

    res = await fetch(h.url('/skill/create'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'new-skill', content: SKILL('new-skill') }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'name-taken');

    res = await fetch(h.url('/skill/create'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'Bad Name', content: SKILL('x') }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid-name');
  } finally {
    await h.close();
  }
});

test('新建：没 frontmatter 的正文被拒', async () => {
  const h = await makeHarness();
  try {
    const res = await fetch(h.url('/skill/create'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'bad', content: '# 只有正文，没有 frontmatter\n' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'missing-frontmatter');
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
    const res = await fetch(h.url('/skill/save'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'order-coffee', content: next, baseRevision: got.revision, baseContent: got.content }),
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

    const res = await fetch(h.url('/skill/save'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'order-coffee', content: mine, baseRevision: got.revision, baseContent: original }),
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
    const res = await fetch(h.url('/skill/save'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'ghost', content: SKILL('ghost'), baseRevision: 'x' }),
    });
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
    const del = await (await fetch(h.url('/skill/delete'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'order-coffee' }),
    })).json();
    assert.equal(del.ok, true);
    assert.equal(del.trashed, true);
    assert.ok(!fs.existsSync(path.join(h.wsRoot, 'order-coffee')), '原目录应已移走');

    const trash = await (await fetch(h.url('/skill/trash', '?sessionId=s1'))).json();
    assert.equal(trash.items.length, 1);
    assert.equal(trash.items[0].name, 'order-coffee');
    assert.equal(trash.items[0].scope, 'workspace');

    const restore = await (await fetch(h.url('/skill/trash/restore'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', entry: trash.items[0].entry }),
    })).json();
    assert.equal(restore.restored, true);
    assert.ok(fs.existsSync(path.join(h.wsRoot, 'order-coffee', 'SKILL.md')), '应已还原出来');
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
    const res = await fetch(h.url('/skill/delete'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'order-coffee', baseRevision: got.revision }),
    });
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
    const del = await (await fetch(h.url('/skill/delete'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', name: 'dup' }),
    })).json();
    writeSkill(h.wsRoot, 'dup', SKILL('dup', '新的一份'));
    const res = await fetch(h.url('/skill/trash/restore'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', entry: del.entry }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'name-taken');
  } finally {
    await h.close();
  }
});
