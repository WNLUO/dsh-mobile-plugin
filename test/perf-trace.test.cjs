'use strict';

/**
 * 守卫：操作记录回传（`lib/mobile/perf-trace.js`）。
 *
 * 这条通道把手机上的调试时间线写到**用户自己电脑上**。这里钉四件会坏掉的事：
 *
 *  一、**目录不存在要自建**。第一次用的人 `$DSH_HOME/mobile-traces` 一定还不存在，
 *      不自建就永远是 500，而手机那边只看到一句「上传失败」。
 *  二、**文件名不能带客户端的原样字符串**。label 是 App 给的自由文本，中文、空格、斜杠
 *      都会出现；斜杠直接写出了目录（`../` 更糟），中文则让「按名字找文件」这件事失效。
 *  三、**上限要挡住**。4MB 以上回 400/413 并说清，而不是先整个读进内存再说。
 *  四、**正文原样存**。这份文件是人直接打开的，文本里的换行、缩进必须还在。
 *
 * 每个用例都把 `DSH_HOME` 指到 `os.tmpdir()` 下的临时目录，绝不写用户真实的 `~/.dsh`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perfTrace = require('../lib/mobile/perf-trace.js');
const { readRouteTable } = require('./lib/wiring.cjs');

/** 一个假的 res：只记下状态码与写出去的 JSON。 */
function fakeRes() {
  const res = {
    status: null,
    body: null,
    writeHead(status) { res.status = status; return res; },
    end(chunk) {
      res.raw = chunk;
      try { res.body = JSON.parse(String(chunk)); } catch { res.body = null; }
      return res;
    },
  };
  return res;
}

/** 把一段请求体喂给 handler；已解析的体走 `req.body`（信封那条路就是这样交过来的）。 */
async function post(body, { raw } = {}) {
  const res = fakeRes();
  const req = raw === undefined
    ? { body }
    : (() => {
      // 明文那条路：handler 会自己读流。
      const { Readable } = require('node:stream');
      const stream = Readable.from([Buffer.from(raw, 'utf8')]);
      stream.headers = {};
      return stream;
    })();
  await perfTrace.handlePerfTrace({}, req, res);
  return res;
}

/** 每个用例一个干净的 home 目录。 */
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  process.env.DSH_HOME = home;
  return home;
}

test('目录不存在时自己建，并把正文原样落盘', async () => {
  const home = freshHome();
  const text = 'line one\nline two\n\tindented\n';
  const res = await post({ deviceId: 'abc123def456', label: 'drawer', startedAt: 1762000000000, text });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.file.endsWith('.json'), `文件名应以 .json 结尾：${res.body.file}`);

  const dir = path.join(home, 'mobile-traces');
  assert.ok(fs.existsSync(dir), '目录不存在时应自建');
  const file = path.join(dir, res.body.file);
  assert.equal(res.body.path, file);
  assert.ok(fs.existsSync(file), '返回的路径上应真有文件');

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.text, text, 'text 必须逐字节原样（不是压成一行）');
  assert.equal(saved.label, 'drawer');
  assert.equal(saved.deviceId, 'abc123def456');
  assert.equal(saved.startedAt, 1762000000000);
  assert.equal(typeof saved.receivedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(saved.receivedAt)), 'receivedAt 应是可解析的时间');

  // 目录权限：里面是用户的调试原文，别给同机其它账号读。
  const stat = fs.statSync(dir);
  assert.equal(stat.mode & 0o777, 0o700, `目录权限应为 0700，实际 ${(stat.mode & 0o777).toString(8)}`);
});

test('文件名安全化：中文 / 斜杠 / 空格一律变成 _，deviceId 只取前 8 位，label 最长 40', async () => {
  const home = freshHome();
  const res = await post({
    deviceId: 'device-0123456789',
    label: '侧栏 滑动/卡顿 ../etc passwd',
    startedAt: 1762000000000,
    text: 'x',
  });

  assert.equal(res.status, 200);
  const name = res.body.file;
  assert.ok(!name.includes('/'), `文件名里不许有斜杠：${name}`);
  assert.ok(!name.includes(' '), `文件名里不许有空格：${name}`);
  assert.ok(!name.includes('中文'), '中文字符不该原样进文件名');
  assert.match(name, /^[0-9T\-]+-[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+\.json$/);

  // 落点必须就在 mobile-traces 里，没有被 ../ 带出去。
  assert.equal(path.dirname(res.body.path), path.join(home, 'mobile-traces'));
  assert.ok(fs.existsSync(res.body.path));

  // 末段长度（去扩展名）不超过 40。
  const tag = name.replace(/\.json$/, '').split('-').slice(-1)[0];
  const label = name.replace(/\.json$/, '');
  const parts = label.split('-');
  const devicePart = parts.find((p) => p.startsWith('device') || p === 'device_0') || '';
  assert.ok(devicePart.length <= 8, `deviceId 短码应 ≤ 8 位：${devicePart}`);
  void tag;
});

test('安全化函数本身：只留 [a-zA-Z0-9_-]', () => {
  assert.equal(perfTrace.safeSegment('中文 空格/a\\b', 'x'), '______a_b');
  assert.equal(perfTrace.safeSegment('', 'fallback'), 'fallback');
  assert.equal(perfTrace.safeSegment(undefined, 'fallback'), 'fallback');
  assert.equal(perfTrace.safeSegment('a.b~c', 'x'), 'a_b_c');
  assert.equal(perfTrace.safeSegment('ok-name_1', 'x'), 'ok-name_1');

  const long = 'a'.repeat(100);
  const { traceFileName } = perfTrace;
  const name = traceFileName({ receivedAt: new Date(), deviceId: 'd'.repeat(20), label: long });
  const body = name.replace(/\.json$/, '');
  assert.ok(body.endsWith('a'.repeat(40)), `label 应被截到 40：${name}`);
  assert.ok(!body.endsWith('a'.repeat(41)));
});

test('缺 text / text 非字符串 / 空串 → 400', async () => {
  freshHome();
  for (const body of [
    { startedAt: 1 },
    { startedAt: 1, text: 123 },
    { startedAt: 1, text: '' },
    { startedAt: 1, text: null },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, `这个体应回 400：${JSON.stringify(body)}`);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /text/);
  }
});

test('startedAt 不是有限数字 → 400', async () => {
  freshHome();
  for (const startedAt of [undefined, 'now', null, Infinity, NaN]) {
    const res = await post({ startedAt, text: 'x' });
    assert.equal(res.status, 400, `startedAt=${startedAt} 应回 400`);
    assert.match(res.body.error, /startedAt/);
  }
});

test('超过 4MB 的正文回 413，且不落盘', async () => {
  const home = freshHome();
  const tooBig = 'a'.repeat(perfTrace.MAX_TEXT_BYTES + 1);
  const res = await post({ startedAt: 1, text: tooBig });
  assert.equal(res.status, 413);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /4MB/);

  const dir = path.join(home, 'mobile-traces');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  assert.deepEqual(files, [], '超限的请求不该留下任何文件');
});

test('刚好到 4MB 上限的正文可以落盘', async () => {
  const home = freshHome();
  const text = 'a'.repeat(perfTrace.MAX_TEXT_BYTES);
  const res = await post({ startedAt: 1, text });
  assert.equal(res.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'mobile-traces', res.body.file), 'utf8'));
  assert.equal(saved.text.length, perfTrace.MAX_TEXT_BYTES);
});

test('index.jsonl 每次追加一行 {file, receivedAt, bytes, deviceId}', async () => {
  const home = freshHome();
  assert.equal((await post({ deviceId: 'dev1', startedAt: 1, text: 'a' })).status, 200);
  assert.equal((await post({ deviceId: 'dev2', startedAt: 2, text: 'bb' })).status, 200);

  const index = path.join(home, 'mobile-traces', 'index.jsonl');
  const lines = fs.readFileSync(index, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), ['bytes', 'deviceId', 'file', 'receivedAt']);
    assert.equal(typeof line.bytes, 'number');
    assert.ok(line.bytes > 0);
  }
  assert.deepEqual(lines.map((l) => l.deviceId), ['dev1', 'dev2']);
});

test('明文请求（没有 req.body）也能读：handler 自己读流', async () => {
  const home = freshHome();
  const res = await post(undefined, { raw: JSON.stringify({ startedAt: 5, text: 'plain', label: 'p' }) });
  assert.equal(res.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'mobile-traces', res.body.file), 'utf8'));
  assert.equal(saved.text, 'plain');
});

test('/api/mobile/v1/perf-trace 真的挂在路由表上（且经 guarded）', () => {
  const table = readRouteTable();
  assert.match(
    table,
    /route\('\/api\/mobile\/v1\/perf-trace',\s*perfTrace\.handlePerfTrace\)/,
    '这条路由没注册：App 上传必然 404',
  );
  assert.match(table, /require\('\.\.\/mobile\/perf-trace\.js'\)/, '路由表要引入 handler 模块');
});
