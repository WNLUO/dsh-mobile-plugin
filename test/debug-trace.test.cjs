'use strict';
// 调试轨迹的上传口（`POST /api/mobile/v1/debug/trace`）。
//
// 这条口是「让现场的日志回到维护者手上」的唯一通道：App 在开发包里录滑动过程，边录边把
// JSONL 打过来，插件落进 `<DSH_HOME>/mobile-debug/<capture>.jsonl`。
//
// 钉四层：
//  1. 写进去的东西能原样按行读回来（App 之后就是按行解析的）；
//  2. 轨迹名只能拼出这个目录里的文件名 —— 构造的 capture 不越界，也不碰别的文件；
//  3. 一份轨迹写满 8MB 之后回 `capped` 并停写（不许把盘写满）；
//  4. 目录里只留最近 10 份。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleDebugTrace,
  readCapture,
  traceDir,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURES,
} = require('../lib/mobile/debug-trace.js');

/** 假响应：把 handler 吐出来的东西收下来（同 session-local-image.test.cjs 的夹具）。 */
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    setHeader() {},
    end(text) { this.body = JSON.parse(text); },
    writeHead(code) { this.statusCode = code; },
  };
}

/** 假请求：`readJsonBody` 认 `req.body` 已经解析好的那种形状。 */
function fakeReq(body) {
  return { method: 'POST', headers: {}, body };
}

async function post(body) {
  const res = fakeRes();
  await handleDebugTrace({}, fakeReq(body), res);
  return res;
}

/** 每个用例各自一个 DSH_HOME，互不干扰；结束时还原。 */
async function withTempHome(fn) {
  const previous = process.env.DSH_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-debug-trace-'));
  process.env.DSH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('轨迹写进 <DSH_HOME>/mobile-debug/<capture>.jsonl，接着续写不覆盖', () => withTempHome(async (home) => {
  const first = await post({ capture: '20261102-101010-abc', lines: ['{"t":0,"e":"start"}'] });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.file, '20261102-101010-abc.jsonl');
  assert.equal(fs.existsSync(path.join(home, 'mobile-debug', '20261102-101010-abc.jsonl')), true);

  const second = await post({ capture: '20261102-101010-abc', lines: ['{"t":16,"e":"scroll"}', '{"t":33,"e":"scroll"}'] });
  assert.equal(second.body.ok, true);
  assert.ok(second.body.bytes > first.body.bytes, '第二段要接在后面，不是把第一段冲掉');

  const text = readCapture('20261102-101010-abc');
  const rows = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.e), ['start', 'scroll', 'scroll']);
  assert.deepEqual(rows.map((row) => row.t), [0, 16, 33]);
}));

test('轨迹名只能拼出这个目录里的文件名：路径分隔符与空名字一律 400', () => withTempHome(async (home) => {
  for (const capture of ['', '../escape', 'a/b', 'a\\b', '.hidden', 'x'.repeat(81), null, 42]) {
    const res = await post({ capture, lines: ['{"t":0}'] });
    assert.equal(res.statusCode, 400, `${String(capture)} 不该被接受`);
    assert.equal(res.body.ok, false);
  }
  assert.equal(fs.existsSync(path.join(home, 'mobile-debug')), false, '被拒的请求一个目录都不该建出来');
  assert.equal(fs.existsSync(path.join(home, 'escape.jsonl')), false);
}));

test('形状不对的批次：缺 lines 回 400，空数组照回 ok 但不建文件', () => withTempHome(async (home) => {
  const missing = await post({ capture: 'clean' });
  assert.equal(missing.statusCode, 400);
  const empty = await post({ capture: 'clean', lines: [] });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.body.ok, true);
  assert.equal(fs.existsSync(path.join(home, 'mobile-debug', 'clean.jsonl')), false);
  // 混进来的非字符串行直接丢掉，字符串照写：一次形状不干净不该让整段录不上。
  const mixed = await post({ capture: 'clean', lines: ['{"t":0,"e":"a"}', 42, null, '{"t":1,"e":"b"}'] });
  assert.equal(mixed.body.ok, true);
  assert.equal(readCapture('clean').trim().split('\n').length, 2);
}));

test('一份轨迹写满之后回 capped 并停写，绝不越过上限', () => withTempHome(async (home) => {
  fs.mkdirSync(traceDir(), { recursive: true });
  const full = path.join(home, 'mobile-debug', 'bounded.jsonl');
  const head = '{"t":-1,"e":"head"}\n';
  fs.writeFileSync(full, head);
  fs.truncateSync(full, MAX_CAPTURE_BYTES - 40);
  // 四条三十来字节的行，只有一条塞得进剩下的 40 字节。
  const lines = Array.from({ length: 4 }, (_, i) => `{"t":${i},"e":"late","pad":"xxxxxxxx"}`);
  const first = await post({ capture: 'bounded', lines });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.capped, true, '写满要如实回 capped，App 收到才停手');
  assert.equal(first.body.lines, 1, '只留能整行放下的那一条');
  assert.ok(fs.statSync(full).size <= MAX_CAPTURE_BYTES, '上限是硬的');
  assert.ok(fs.statSync(full).size > MAX_CAPTURE_BYTES - 64, '整行能塞下的还是要塞进去，别浪费到一行都不写');
  // 已经满了之后再来一批：一个字节都不加，仍然回 capped。
  const before = fs.statSync(full).size;
  const again = await post({ capture: 'bounded', lines: ['{"t":1,"e":"more"}'.padEnd(30, ' ')] });
  assert.equal(again.body.capped, true);
  assert.equal(fs.statSync(full).size, before);
  // 写满时按整行留：最后一行必须是完整 JSON，不能是半截。
  const text = fs.readFileSync(full, 'latin1');
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.split('\n').filter(Boolean).length, 2);
}));

test('目录里只留最近 MAX_CAPTURES 份，新的进来时删最旧的', () => withTempHome(async (home) => {
  const dir = path.join(home, 'mobile-debug');
  fs.mkdirSync(dir, { recursive: true });
  const total = MAX_CAPTURES + 3;
  for (let i = 0; i < total; i += 1) {
    const file = path.join(dir, `old-${i}.jsonl`);
    fs.writeFileSync(file, '{"t":0}\n');
    // mtime 拉开：清理按 mtime 排，不按名字。
    const stamp = new Date(Date.now() - (total - i) * 60_000);
    fs.utimesSync(file, stamp, stamp);
  }
  const res = await post({ capture: 'fresh', lines: ['{"t":0,"e":"start"}'] });
  assert.equal(res.body.ok, true);
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(names.length, MAX_CAPTURES);
  assert.ok(names.includes('fresh.jsonl'), '刚写的那份必须在');
  assert.equal(names.includes('old-0.jsonl'), false, '最旧的那份要被清掉');
}));

test('建不出目录 / 写不进去要如实回 500，不是假 ok', () => withTempHome(async (home) => {
  // 让轨迹目录的位置上先站一个普通文件：mkdir 必然失败。
  fs.writeFileSync(path.join(home, 'mobile-debug'), '');
  const res = await post({ capture: 'broken', lines: ['{"t":0}'] });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
}));
