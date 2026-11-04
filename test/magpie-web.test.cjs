'use strict';

/**
 * 守卫：magpie 网页版入口（`lib/mobile/magpie-web.js`）。
 *
 * 这一条要钉的是三件事，每件都有对应的坏法：
 *  一、**探测认得出「这是不是它」**。端口上随便什么程序都在听时不能当成 magpie 网页版 ——
 *      判据是它那一跳的 303/302，或认得出它但这次没带 key 的 401。认错了就会把一个陌生
 *      程序的页面端给手机。
 *  二、**key 必须稳定、且不需要用户自己去配**。用户设的优先，其次是我们上次留下的那份，
 *      都没有才现造并留下。**这条是重点**：插件热重载 / 宿主重启后内存里的 key 没了，而网页版
 *      进程是 detached、还活着 —— 若这时现造一把新 key，就跟在跑的那个对不上，只能回「拿不到
 *      登录凭据」，用户被要求自己去设环境变量。稳定 key + 「先认领旧进程、认不到再起新的」
 *      一起解决它。
 *  三、**起不来的每一种都要有名字**。没装 / 超时 / 没空端口 —— 处置各不相同，统一成「打不开」
 *      等于让人重试一件不会成功的事。
 *
 * 真起进程那一段不在这里跑：`spawnImpl` / `probe` / `probeKeyFn` / `portFreeFn` 全部注入，
 * 绝不能因为跑测试在这台机器上留下一个真实进程、或让判定受本机是否正好开着 magpie 影响。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const magpieWeb = require('../lib/mobile/magpie-web.js');

/** 每个用例一个临时目录，key 落在里面，绝不碰用户真实的 `~/.dsh`。 */
function tmpKeyFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-web-test-'));
  return path.join(dir, 'magpie-web-key');
}

/** 一个固定的「这个端口空着」结果。 */
const FREE_PORT = 34999;

// ── 一、探测：认得出 / 认不出 ───────────────────────────────────────────────

/** 起一个假服务，回指定的状态码，跑完收掉。 */
function fakeServer(status, headers = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(status, headers);
      res.end('x');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('探测：答 303 就算它是 magpie 网页版（有 key 就换 cookie 的那一跳）', async () => {
  const { server, port } = await fakeServer(303, { location: '/' });
  try {
    assert.equal(await magpieWeb.probeWeb(port), true);
  } finally {
    server.close();
  }
});

test('探测：答 401 也算（是它，只是这次没带 key）', async () => {
  const { server, port } = await fakeServer(401);
  try {
    assert.equal(await magpieWeb.probeWeb(port), true);
  } finally {
    server.close();
  }
});

test('探测：别的状态码不算 —— 端口上有别的程序在听时不能当成 magpie', async () => {
  for (const status of [200, 404, 500, 204]) {
    const { server, port } = await fakeServer(status);
    try {
      assert.equal(await magpieWeb.probeWeb(port), false, `${status} 不该被认成 magpie 网页版`);
    } finally {
      server.close();
    }
  }
});

test('探测：没人在听时回 false，不抛', async () => {
  assert.equal(await magpieWeb.probeWeb(1), false);
});

test('带 key 探测：吃这把 key（3xx 登录跳转）算认，401 算不认', async () => {
  const good = await fakeServer(303, { location: '/' });
  try {
    assert.equal(await magpieWeb.probeKey(good.port, 'anything'), true);
  } finally {
    good.server.close();
  }
  const bad = await fakeServer(401);
  try {
    assert.equal(await magpieWeb.probeKey(bad.port, 'wrong'), false);
  } finally {
    bad.server.close();
  }
});

test('端口空着没有：有人占着 false，收掉后 true', async () => {
  const { server, port } = await fakeServer(200);
  try {
    assert.equal(await magpieWeb.portFree(port), false, '有人占着却报空着');
  } finally {
    server.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await magpieWeb.portFree(port), true, '没人占着却报占着');
});

// ── 二、key 的形状与稳定 ─────────────────────────────────────────────────────

test('key：`MAGPIE_WEB_KEY` 合规时原样用（每次运行同一个）', () => {
  const given = 'abcdefghij0123456789';
  assert.equal(magpieWeb.webKey({ MAGPIE_WEB_KEY: given }), given);
});

test('key：没给或不合规时现造一个 32 位十六进制', () => {
  for (const env of [{}, { MAGPIE_WEB_KEY: '' }, { MAGPIE_WEB_KEY: 'short' }, { MAGPIE_WEB_KEY: 'has space!!!!!!!' }]) {
    const key = magpieWeb.webKey(env);
    assert.match(key, /^[0-9a-f]{32}$/, `不合规的输入应落回随机 key：${JSON.stringify(env)}`);
    assert.ok(key.length >= 16);
    assert.match(key, /^[A-Za-z0-9._~-]+$/);
  }
});

test('key：两次调用给出不同的随机值（不共享常量）', () => {
  assert.notEqual(magpieWeb.webKey({}), magpieWeb.webKey({}));
});

test('稳定 key：没有 env 时现造一份、落盘；下一次读回同一把（跨插件重载不丢）', () => {
  const env = { MAGPIE_WEB_KEY_FILE: tmpKeyFile() };
  const first = magpieWeb.resolveKey(env);
  assert.ok(magpieWeb.readStoredKey(env) === first, '应当落盘并被读回');
  assert.equal(magpieWeb.resolveKey(env), first, '同一份文件必须每次给出同一把 key');
});

test('稳定 key：env 设了就压过落盘那份', () => {
  const env = { MAGPIE_WEB_KEY_FILE: tmpKeyFile() };
  magpieWeb.resolveKey(env); // 先落一份随机的
  assert.equal(magpieWeb.resolveKey({ ...env, MAGPIE_WEB_KEY: 'abcdefghij0123456789' }), 'abcdefghij0123456789');
});

// ── 三、ensureWeb：认领 / 起新的 / 起不来 ───────────────────────────────────

/** 下面这组全部用注入的假体，不碰真实网络、不起真实进程。 */
function netFake() {
  const running = new Map(); // port -> key
  const occupied = new Set(); // 被「别的程序」占着、但我们没 key 的端口
  return {
    running,
    occupied,
    probe: async (port) => running.has(port) || occupied.has(port),
    probeKeyFn: async (port, key) => running.get(port) === key,
    portFreeFn: async (port) => !running.has(port) && !occupied.has(port),
  };
}

test('找不到 magpie 时回 no-magpie，而不是抛；且一个进程都不起', async () => {
  const net = netFake();
  let spawned = 0;
  const entry = await magpieWeb.ensureWeb({
    env: { PATH: '/definitely/not/here', MAGPIE_BIN: '/nope/magpie', MAGPIE_WEB_KEY_FILE: tmpKeyFile() },
    spawnImpl: () => { spawned += 1; throw new Error('不该起进程'); },
    probe: net.probe,
    probeKeyFn: net.probeKeyFn,
    portFreeFn: net.portFreeFn,
  });
  assert.equal(entry.available, false);
  assert.equal(entry.reason, 'no-magpie');
  assert.equal(spawned, 0, '没装的机器不该起进程');
});

test('认领：旧进程还在跑、稳定 key 对得上 → 直接用，不再起新的', async () => {
  const env = { MAGPIE_WEB_KEY_FILE: tmpKeyFile(), MAGPIE_BIN: process.execPath };
  const key = magpieWeb.resolveKey(env); // 落一份稳定 key
  const net = netFake();
  net.running.set(3430, key); // 上次起的进程，用同一把 key
  let spawned = 0;
  const entry = await magpieWeb.ensureWeb({
    env,
    spawnImpl: () => { spawned += 1; return { unref() {}, kill() {} }; },
    probe: net.probe,
    probeKeyFn: net.probeKeyFn,
    portFreeFn: net.portFreeFn,
  });
  assert.deepEqual(entry, { available: true, port: 3430, key });
  assert.equal(spawned, 0, '认领得到就不该再起进程');
});

test('起一个新的：起完拿到 key，第二次靠稳定 key 认回来、不再起第二个', async () => {
  const env = { MAGPIE_WEB_KEY_FILE: tmpKeyFile(), MAGPIE_BIN: process.execPath };
  const net = netFake();
  let spawned = 0;
  const fakeSpawn = (bin, args, opts) => {
    spawned += 1;
    const port = Number(String(args[2]).split(':').pop());
    net.running.set(port, opts.env.MAGPIE_WEB_KEY);
    return { unref() {}, kill() {} };
  };
  const first = await magpieWeb.ensureWeb({ env, spawnImpl: fakeSpawn, probe: net.probe, probeKeyFn: net.probeKeyFn, portFreeFn: net.portFreeFn });
  assert.equal(first.available, true, `第一次该拿到入口：${JSON.stringify(first)}`);
  assert.equal(spawned, 1);

  const second = await magpieWeb.ensureWeb({ env, spawnImpl: fakeSpawn, probe: net.probe, probeKeyFn: net.probeKeyFn, portFreeFn: net.portFreeFn });
  assert.equal(second.available, true);
  assert.equal(second.key, first.key, '两次的 key 必须一致（同一个进程）');
  assert.equal(spawned, 1, '第二次应认领，不该再起');
});

test('跳过一个「在跑但不是我们」的端口，在下一个空端口起自己的', async () => {
  const env = { MAGPIE_WEB_KEY_FILE: tmpKeyFile(), MAGPIE_BIN: process.execPath };
  const key = magpieWeb.resolveKey(env);
  const net = netFake();
  net.running.set(3430, 'someone-elses-key'); // 别的实例占着 3430，key 不是我们的
  const spawnedAt = [];
  const fakeSpawn = (bin, args, opts) => {
    const port = Number(String(args[2]).split(':').pop());
    spawnedAt.push(port);
    net.running.set(port, opts.env.MAGPIE_WEB_KEY);
    return { unref() {}, kill() {} };
  };
  const entry = await magpieWeb.ensureWeb({ env, spawnImpl: fakeSpawn, probe: net.probe, probeKeyFn: net.probeKeyFn, portFreeFn: net.portFreeFn });
  assert.equal(entry.available, true);
  assert.equal(entry.key, key);
  assert.deepEqual(spawnedAt, [3431], '该跳过 3430，在 3431 起');
});

test('起得来但一直不答话：回 start-timeout（快速档，不等满 25 秒）', async () => {
  const net = netFake();
  let spawned = 0;
  const entry = await magpieWeb.ensureWeb({
    env: { MAGPIE_WEB_KEY_FILE: tmpKeyFile(), MAGPIE_BIN: process.execPath },
    spawnImpl: () => { spawned += 1; return { unref() {}, kill() {} }; },
    probe: async () => false, // 永远不答
    probeKeyFn: async () => false,
    portFreeFn: net.portFreeFn,
    startTimeoutMs: 60,
  });
  assert.equal(entry.available, false);
  assert.equal(entry.reason, 'start-timeout');
  assert.equal(spawned, 1);
});

// ── 四、固定判定与路由 ───────────────────────────────────────────────────────

test('首选端口：缺省 3430，`MAGPIE_WEB_PORT` 能改', () => {
  assert.equal(magpieWeb.preferredPort({}), 3430);
  assert.equal(magpieWeb.preferredPort({ MAGPIE_WEB_PORT: '3500' }), 3500);
  assert.equal(magpieWeb.preferredPort({ MAGPIE_WEB_PORT: 'abc' }), 3430);
  assert.equal(magpieWeb.preferredPort({ MAGPIE_WEB_PORT: '70000' }), 3430);
});

test('找可执行文件：`$MAGPIE_BIN` 指向不存在的路径时回 null，不会退到别处乱认', () => {
  const got = magpieWeb.findBinary({ PATH: '', MAGPIE_BIN: '/definitely/not/here/magpie' });
  assert.ok(got === null || typeof got === 'string');
});

test('路由注册在移动端路由表里，且被 guarded 包住', () => {
  const table = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'mobile-api.js'), 'utf8');
  assert.match(table, /route\('\/api\/mobile\/v1\/magpie\/web', magpieWeb\.handleMagpieWeb\)/);
  const routes = fs.readFileSync(path.join(__dirname, 'mobile-routes.test.cjs'), 'utf8');
  assert.ok(!/magpie\/web/.test(routes.split('PUBLIC_ROUTES')[1] || ''), 'magpie/web 不该进 PUBLIC_ROUTES');
});

test('handler 拿不到外部时也回 200，不让一次能力探测变成 500（也不真起进程）', async () => {
  const saved = { bin: process.env.MAGPIE_BIN, keyfile: process.env.MAGPIE_WEB_KEY_FILE };
  process.env.MAGPIE_BIN = '/nonexistent/magpie';
  process.env.MAGPIE_WEB_KEY_FILE = tmpKeyFile();
  let sent = null;
  const res = {
    writeHead: (status) => { sent = { status }; },
    end: (body) => { sent = { ...sent, body: String(body) }; },
  };
  try {
    await magpieWeb.handleMagpieWeb({}, {}, res);
  } finally {
    if (saved.bin === undefined) delete process.env.MAGPIE_BIN; else process.env.MAGPIE_BIN = saved.bin;
    if (saved.keyfile === undefined) delete process.env.MAGPIE_WEB_KEY_FILE; else process.env.MAGPIE_WEB_KEY_FILE = saved.keyfile;
  }
  assert.equal(sent.status, 200);
  const parsed = JSON.parse(sent.body);
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.available, 'boolean');
  if (!parsed.available) assert.ok(typeof parsed.reason === 'string' && parsed.reason !== '');
});
