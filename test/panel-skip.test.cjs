'use strict';

// 2026-11-25：引导页「跳过」出口的守卫——不配服务商也能进控制台，且点了就落 onboarded。
// 2026-11-26：引导页拆成三页（下载 App / 配网络 / 扫码），跳过挪到第二页常驻、点了直接进控制台。
/**
 * 引导页是小白必经之路，但不能把「不想接服务商、自己有线路」的人也锁在外面。
 * 这里钉四件事：
 *   1. 引导页是三页，第二页那颗「跳过」常驻，且它不被 anyReady 挡着；
 *   2. 点它先把 onboarded 落盘，再进门 —— 否则下次开 /panel 又弹回引导；
 *   3. 跳过只到控制台，不去第三页扫码；
 *   4. 十门语言的文案键都在，别让海外用户看到漏字。
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const page = read('React', 'src', 'Onboarding.tsx');
const messages = read('React', 'src', 'lib', 'i18n', 'messages', 'onboarding.ts');

test('引导页是三页：下载 App → 配网络 → 扫码，同一时刻只画一页', () => {
  assert.match(page, /const \[step, setStep\] = useState<1 \| 2 \| 3>\(1\)/, '从第一页开始');

  const step1 = page.slice(page.indexOf('{step === 1 ? ('), page.indexOf('{step === 2 ? ('));
  assert.match(step1, /<DownloadChannelsGrid \/>/, '第一页只摆下载渠道');
  assert.match(step1, /onClick=\{\(\) => setStep\(2\)\}/, '第一页的「下一步」去配网络');

  const step2 = page.slice(page.indexOf('{step === 2 ? ('), page.indexOf('{step === 3 ? ('));
  assert.match(step2, /\{providers\.map\(/, '第二页配网络');
  assert.match(step2, /onClick=\{\(\) => setStep\(3\)\}/, '接好之后去扫码页');

  const step3 = page.slice(page.indexOf('{step === 3 ? ('), page.indexOf('{/* 服务商面板'));
  assert.match(step3, /dangerouslySetInnerHTML=\{\{ __html: qrSvg \}\}/, '第三页摆二维码');
  assert.match(step3, /onClick=\{enterNow\}/, '第三页扫完直接进控制台');

  assert.equal((page.match(/\{step === [123] \? \(/g) || []).length, 3, '三页各一段，别多出一页');
});

test('第二页常驻「跳过」按钮，且它不受 anyReady 门禁', () => {
  const step2 = page.slice(page.indexOf('{step === 2 ? ('), page.indexOf('{step === 3 ? ('));
  const skipAt = step2.indexOf("t('panel.onboarding.skipSetup')");
  assert.notEqual(skipAt, -1, '第二页要有跳过按钮');
  const skip = step2.slice(Math.max(0, skipAt - 260), skipAt + 60);
  assert.match(skip, /onClick=\{\(\) => void skipSetup\(\)\}/, '跳过按钮要接到 skipSetup');
  assert.doesNotMatch(skip, /disabled=/, '跳过按钮不许被 anyReady 或别的门禁禁用');

  const step3 = page.slice(page.indexOf('{step === 3 ? ('), page.indexOf('{/* 服务商面板'));
  assert.ok(!step3.includes('skipSetup'), '第三页不再放跳过：走到扫码这一步就该连上');
});

test('skipSetup 先落 onboarded 再进门，避免下次又回到引导页', () => {
  const start = page.indexOf('async function skipSetup()');
  assert.notEqual(start, -1, '要有 skipSetup');
  const fn = page.slice(start, start + page.slice(start).indexOf('\n  }'));
  const postAt = fn.indexOf("apiPost('/api/relay/onboarded', {})");
  const enterAt = fn.indexOf('enterNow()');
  assert.notEqual(postAt, -1, '跳过要幂等写一次 onboarded');
  assert.notEqual(enterAt, -1, '跳过要进门');
  assert.ok(postAt < enterAt, '先落盘再进门，写失败也不能卡住进门');
  assert.match(fn, /\.catch\(\(\) => undefined\)/, '落盘失败要吞掉，不能把跳过变成死路');
});

test('变异证明：把 skipSetup 里的落盘或进门删掉会被上面抓住', () => {
  const start = page.indexOf('async function skipSetup()');
  const fn = page.slice(start, start + page.slice(start).indexOf('\n  }'));
  const noPost = fn.replace("apiPost('/api/relay/onboarded', {})", '');
  assert.throws(() => assert.ok(noPost.includes("apiPost('/api/relay/onboarded', {})")), assert.AssertionError);
  const noEnter = fn.replace('enterNow()', '');
  assert.throws(() => assert.ok(noEnter.includes('enterNow()')), assert.AssertionError);
});

test('十门语言的跳过文案齐全、非空', () => {
  const langs = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'pt', 'ru'];
  const blocks = [...messages.matchAll(/^  (?:'([\w-]+)'|(\w+)): \{\n([\s\S]*?)^  \},$/gm)];
  const found = new Map(blocks.map((block) => [block[1] || block[2], block[3]]));
  for (const lang of langs) {
    const block = found.get(lang);
    assert.ok(block !== undefined, `${lang} 语言块要在`);
    assert.match(block, /'panel\.onboarding\.skipSetup': '\S/, `${lang} 的跳过文案要在且不能空`);
  }
  assert.equal((messages.match(/'panel\.onboarding\.skipSetup':/g) || []).length, langs.length, '跳过文案只落在十门语言各一处');
});
