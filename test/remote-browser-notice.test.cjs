/** 网页租期提示只读、按真实期限显示，并保持 HTML 分块字节与流式输出。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { once } = require('node:events');
const { noticeScript, createNoticeTransform } = require('../lib/remote/browser-notice.cjs');

function page({ left = 3600_000, language = 'en', failed = false, embedded = false } = {}) {
  const children = [];
  const calls = [];
  const listeners = {};
  let mono = 0;
  let status = { expiresAt: 1000 + left, serverNow: 1000 };
  let unavailable = failed;
  let tick;
  const win = { addEventListener(type, fn) { listeners[type] = fn; } };
  win.top = embedded ? {} : win;
  const document = {
    hidden: false, documentElement: { lang: language },
    getElementById: () => null,
    createElement(tag) { return { tag, style: {}, setAttribute() {}, textContent: '', hidden: false }; },
    body: { appendChild(element) { children.push(element); } },
    addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener() {},
  };
  const context = vm.createContext({
    window: win, document, navigator: { language }, performance: { now: () => mono },
    setInterval(fn, ms) { tick = fn; calls.push(['interval', ms]); return 1; }, clearInterval() {},
    async fetch(url, options) {
      calls.push(['fetch', url, options]);
      if (unavailable) throw new Error('offline');
      return { ok: true, json: async () => status };
    },
  });
  vm.runInContext(noticeScript(), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    children, calls, document, settle,
    async tick() { tick(); await settle(); },
    elapse(ms) { mono += ms; },
    fail() { unavailable = true; },
    restore(next) { unavailable = false; if (next) status = next; },
  };
}

async function inject(chunks) {
  const stream = createNoticeTransform();
  const output = [];
  stream.on('data', (part) => output.push(part));
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await once(stream, 'end');
  return Buffer.concat(output);
}

test('只在提前五分钟内提示；续期来自只读状态，不发写请求', async () => {
  const p = page(); await p.settle();
  assert.equal(p.children.length, 0);
  p.elapse(55 * 60_000); await p.tick();
  assert.equal(p.children.length, 1);
  assert.match(p.children[0].textContent, /expires soon/);
  assert.ok(p.calls.filter(([kind]) => kind === 'fetch').every(([, url, options]) => url === '/__dsh_remote_status' && options.credentials === 'same-origin' && options.cache === 'no-store' && !options.method));
  assert.deepEqual(p.calls[0], ['interval', 30_000]);
  p.restore({ expiresAt: 1000 + 7200_000, serverNow: 1000 + 55 * 60_000 });
  await p.tick();
  assert.equal(p.children[0].hidden, true);
});

test('到期即使状态读取失败也显示返回重开，不把断连说成撤权', async () => {
  const p = page({ left: 300_000 }); await p.settle();
  p.fail(); await p.tick();
  assert.match(p.children[0].textContent, /could not be checked/);
  p.elapse(300_000); await p.tick();
  assert.match(p.children[0].textContent, /has expired/);
  assert.doesNotMatch(p.children[0].textContent, /revoked/);
});

test('首次读取失败提示回本机检查，无租期不显示，内嵌页面不另挂提示', async () => {
  const failed = page({ failed: true }); await failed.settle();
  assert.match(failed.children[0].textContent, /could not be checked/);
  const absent = page({ left: -1000 }); await absent.settle();
  assert.equal(absent.children.length, 0);
  const frame = page({ embedded: true }); await frame.settle();
  assert.deepEqual(frame.calls, []);
  assert.deepEqual(frame.children, []);
});

test('十语按页面语言显示；隐藏时不轮询，不向页面添加可续期控件', async () => {
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'pt', 'ru']) {
    const p = page({ left: 1000, language }); await p.settle();
    assert.equal(p.children.length, 1);
    assert.ok(p.children[0].textContent.length > 10);
    assert.equal(p.children[0].tag, 'div');
    const before = p.calls.length;
    p.document.hidden = true; await p.tick();
    assert.equal(p.calls.length, before);
  }
  assert.doesNotMatch(noticeScript(), /innerHTML|\/renew|\bcredential\b|deviceKey|location\.(?:href|replace)/);
});

test('head 分块、大小写与 UTF-8 原始字节保持，只插一次外部脚本', async () => {
  const original = Buffer.from('<!doctype html><html><HEAD data-x="a">中文</HEAD><body>正文</body></html>');
  const output = await inject([...original].map((byte) => Buffer.from([byte])));
  const tag = '<script src="/__dsh_remote_notice.js" defer></script>';
  assert.equal(output.toString().split(tag).length - 1, 1);
  assert.equal(output.toString().replace(tag, ''), original.toString());
  assert.ok(output.toString().includes(`<HEAD data-x="a">${tag}`));
});

test('找到 head 后立即流出；无 head、长前缀和空文档原样透传', async () => {
  const stream = createNoticeTransform();
  const parts = [];
  stream.on('data', (part) => parts.push(part.toString()));
  stream.write('<html><head>');
  assert.ok(parts.join('').includes('/__dsh_remote_notice.js'));
  stream.end('</head></html>'); await once(stream, 'end');
  for (const original of ['', '<html>no head 中文</html>', 'x'.repeat(5000)]) {
    assert.equal((await inject([Buffer.from(original)])).toString(), original);
  }
});
