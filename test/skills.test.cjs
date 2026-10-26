'use strict';

/**
 * 技能目录代理（GET /api/mobile/v1/skills）的透传契约。
 *
 * 桌面端敲「/」时，候选菜单里混着宿主命令与技能（`@deepseek-ai/dsh-client-ui-skill` 注册的
 * inputTriggers source）。手机端此前只有 commands.list 的命令目录，技能一个都看不到。职责
 * 很窄，但每条都容易写错：
 *
 *  1. sessionId 是必填：宿主 skill.list 的 payload 是 `{ sessionId }`，缺了会被报 invalid
 *     payload；代理应该在本地就 400，别把请求发出去；
 *  2. skills.list 的签名是 `list(request)`（**没有** signal 形参），代理必须只传一个信封
 *     参数 —— 多传 / 少传都会在真机上变成 500；
 *  3. modelInvocable 是严格布尔：宿主漏字段时按 false 处理（界面据此加「仅用户」前缀），
 *     猜真值会误导用户；
 *  4. 技能名是菜单的插入文本，必须非空且已 trim；说明超长会撑爆菜单行，要截断；
 *  5. whenToUse 对手机菜单没有用处（桌面菜单也只用 name + description），不透传。
 *
 * 本测试驱动真实的 handler（不是转写实现）：起一个只挂它的真 http 服务，用真 req/res。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleSkills, normalizeSkill } = require('../lib/mobile/skills.js');
const { readWiring } = require('./lib/wiring.cjs')

const ROUTE = '/skills';

/** 起一个只挂 handleSkills 的真 http 服务，并记下宿主收到的每一次调用与第二个参数。 */
async function serve(listImpl) {
  const calls = [];
  const signals = [];
  const ctx = {
    apiProxy: {
      skills: {
        list: async (request, signal) => {
          calls.push(request);
          signals.push(signal);
          return listImpl ? listImpl(request, signal) : okValue({ skills: [] });
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    // 复刻 lib/index.js 的 guarded()：handler 抛错就回 500 JSON。
    Promise.resolve(handleSkills(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'internal', message: String((error && error.message) || error) },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    signals,
    url: (query = '') => `http://127.0.0.1:${port}${ROUTE}${query}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

test('技能：真实形状透传，whenToUse 被丢掉', async () => {
  const host = await serve(() => okValue({
    skills: [
      {
        name: 'apple-design',
        description: 'Apple 人机界面指南与设计规范',
        whenToUse: '当用户要写 iOS/macOS 界面时',
        modelInvocable: true,
      },
      { name: 'hypit', description: 'Hypixel 相关工具', modelInvocable: true },
      { name: 'ppt-master', description: '做 PPT', modelInvocable: true },
      { name: 'swiftui-pro', description: 'SwiftUI 专家', modelInvocable: true },
    ],
  }));
  try {
    const res = await fetch(host.url('?sessionId=session-c010888b'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.skills.length, 4);
    assert.deepEqual(
      body.skills.map((s) => s.name),
      ['apple-design', 'hypit', 'ppt-master', 'swiftui-pro'],
    );
    // 行形状精确：就这三个键，多一个都会让 App 的菜单多出无用字段。
    assert.deepEqual(Object.keys(body.skills[0]).sort(), ['description', 'modelInvocable', 'name']);
    assert.equal(body.skills[0].description, 'Apple 人机界面指南与设计规范');
    assert.equal(body.skills[0].modelInvocable, true);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('whenToUse'), 'whenToUse 不该出现在响应里');
    assert.ok(!raw.includes('当用户要写'), 'whenToUse 内容不该出现在响应里');
  } finally {
    await host.close();
  }
});

test('技能：请求信封与 method 精确，且不传取消信号', async () => {
  const host = await serve(() => okValue({ skills: [] }));
  try {
    const res = await fetch(host.url('?sessionId=session-abc123'));
    assert.equal(res.status, 200);
    assert.equal(host.calls.length, 1);
    assert.deepEqual(host.calls[0], {
      rpcId: 'mobile',
      method: 'skill.list',
      payload: { sessionId: 'session-abc123' },
    });
    // 宿主 skills.list 的签名是 list(request)：第二个参数必须是 undefined。
    assert.equal(host.signals[0], undefined);
  } finally {
    await host.close();
  }
});

test('技能：缺 sessionId 直接 400，且不打扰宿主', async () => {
  const host = await serve(() => okValue({ skills: [{ name: 'x' }] }));
  try {
    for (const query of ['', '?sessionId=', '?sessionId=%20%20']) {
      const res = await fetch(host.url(query));
      assert.equal(res.status, 400, `query=${query}`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'bad-request');
      assert.equal(body.error.message, '需要 sessionId');
      assert.equal(body.skills, undefined);
    }
    assert.equal(host.calls.length, 0, '缺 sessionId 不该调用宿主');
  } finally {
    await host.close();
  }
});

test('技能：sessionId 两侧空白被 trim 后再发给宿主', async () => {
  const host = await serve(() => okValue({ skills: [] }));
  try {
    const res = await fetch(host.url('?sessionId=%20session-x%20'));
    assert.equal(res.status, 200);
    assert.equal(host.calls[0].payload.sessionId, 'session-x');
  } finally {
    await host.close();
  }
});

test('技能：modelInvocable 是严格布尔，漏字段按 false', async () => {
  const host = await serve(() => okValue({
    skills: [
      { name: 'a', description: 'A', modelInvocable: true },
      { name: 'b', description: 'B', modelInvocable: 'yes' },
      { name: 'c', description: 'C', modelInvocable: 1 },
      { name: 'd', description: 'D' },
      { name: 'e', description: 'E', modelInvocable: null },
      { name: 'f', description: 'F', modelInvocable: false },
    ],
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.deepEqual(body.skills.map((s) => s.modelInvocable), [true, false, false, false, false, false]);
  } finally {
    await host.close();
  }
});

test('技能：畸形条目被丢掉，名字 trim 后保留', async () => {
  const host = await serve(() => okValue({
    skills: [
      null,
      'nope',
      7,
      {},
      { name: '' },
      { name: '   ' },
      { name: 5 },
      { name: ['x'] },
      { name: '  keep-me  ', description: 'ok' },
    ],
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.equal(body.skills.length, 1);
    assert.equal(body.skills[0].name, 'keep-me');
    assert.equal(body.skills[0].description, 'ok');
  } finally {
    await host.close();
  }
});

test('技能：说明非字符串当空串，超长截断补省略号', async () => {
  const long = 'x'.repeat(500);
  const host = await serve(() => okValue({
    skills: [
      { name: 'a', description: long },
      { name: 'b', description: 42 },
      { name: 'c', description: null },
      { name: 'd', description: '   ' },
      { name: 'e' },
      { name: 'f', description: '  padded  ' },
    ],
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    const byName = Object.fromEntries(body.skills.map((s) => [s.name, s.description]));
    assert.equal(byName.a.length, 401, '400 字符 + 省略号');
    assert.ok(byName.a.endsWith('…'));
    assert.equal(byName.b, '');
    assert.equal(byName.c, '');
    assert.equal(byName.d, '');
    assert.equal(byName.e, '');
    assert.equal(byName.f, 'padded');
  } finally {
    await host.close();
  }
});

test('技能：超长技能名被截断到 120，条数封顶 200', async () => {
  const longName = 'n'.repeat(200);
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `skill-${i}`, description: 'd' }));
  const host = await serve(() => okValue({ skills: [{ name: longName }, ...many] }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.equal(body.skills.length, 200);
    assert.equal(body.skills[0].name.length, 120);
    assert.equal(body.skills[0].name, 'n'.repeat(120));
    assert.equal(body.skills[1].name, 'skill-0');
    assert.equal(body.skills[199].name, 'skill-198');
  } finally {
    await host.close();
  }
});

test('技能：宿主报错如实透传，不回空列表', async () => {
  const host = await serve(() => errValue({
    code: 'internal',
    message: 'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
  }));
  try {
    const res = await fetch(host.url('?sessionId=s'));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
    assert.ok(body.error.message.includes('skill registry is absent'));
    assert.equal(body.skills, undefined);
  } finally {
    await host.close();
  }
});

test('技能：宿主空响应 → 400 internal 空响应', async () => {
  const host = await serve(() => undefined);
  try {
    const res = await fetch(host.url('?sessionId=s'));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, '空响应');
  } finally {
    await host.close();
  }
});

test('技能：skills 不是数组时回空列表（不是错误）', async () => {
  for (const value of [{}, { skills: null }, { skills: 'nope' }, { skills: {} }, null]) {
    const host = await serve(() => okValue(value));
    try {
      const res = await fetch(host.url('?sessionId=s'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.skills, []);
    } finally {
      await host.close();
    }
  }
});

test('技能：normalizeSkill 是纯函数，不改动入参', () => {
  const item = { name: 'a', description: 'd', whenToUse: 'w', modelInvocable: true };
  const before = JSON.stringify(item);
  const out = normalizeSkill(item);
  assert.deepEqual(out, { name: 'a', description: 'd', modelInvocable: true });
  assert.equal(JSON.stringify(item), before, '入参不该被改动');
});

test('技能：插件把 handler 挂到 /api/mobile/v1/skills 并导出', () => {
  const root = path.join(__dirname, '..');
  const mod = fs.readFileSync(path.join(root, 'lib/mobile/skills.js'), 'utf8');
  assert.ok(mod.includes("method: 'skill.list'"), 'skills.js 应调用 skill.list');
  assert.ok(mod.includes('需要 sessionId'), 'skills.js 缺 sessionId 时应 400');
  const index = readWiring();
  assert.ok(
    index.includes("const skills = require('../mobile/skills.js')"),
    '移动端路由表应 require mobile/skills.js',
  );
  assert.ok(
    index.includes("route('/api/mobile/v1/skills', skills.handleSkills)"),
    'index.js 应注册 /api/mobile/v1/skills 路由',
  );
});
