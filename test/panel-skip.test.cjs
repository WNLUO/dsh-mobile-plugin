'use strict';

// 2026-11-25：引导页「跳过」出口的守卫——不配服务商也能进控制台，且点了就落 onboarded。
/**
 * 引导页是小白必经之路，但不能把「不想接服务商、自己有线路」的人也锁在外面。
 * 这里钉三件事：
 *   1. 未就绪时多出一颗「跳过」按钮，且它不被 anyReady 挡着；
 *   2. 点它先把 onboarded 落盘，再进门 —— 否则下次开 /panel 又弹回引导；
 *   3. 十门语言的文案键都在，别让海外用户看到漏字。
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const page = read('React', 'src', 'Onboarding.tsx');
const messages = read('React', 'src', 'lib', 'i18n', 'messages', 'onboarding.ts');

test('引导页未就绪时给「跳过」按钮，且它不受 anyReady 门禁', () => {
  const row = page.slice(page.indexOf('<div className="flex flex-wrap items-center justify-end gap-2 px-4 py-4">'));
  const block = row.slice(0, row.indexOf('</div>'));
  assert.match(block, /!anyReady \? \(/, '没接好服务商时才显示跳过，接好了主按钮已经能进');
  const skipAt = block.indexOf('t(\'panel.onboarding.skipSetup\')');
  assert.notEqual(skipAt, -1, '跳过按钮要有文案键');
  const skip = block.slice(Math.max(0, skipAt - 260), skipAt + 60);
  assert.match(skip, /onClick=\{\(\) => void skipSetup\(\)\}/, '跳过按钮要接到 skipSetup');
  assert.doesNotMatch(skip, /disabled=/, '跳过按钮不许被 anyReady 或别的门禁禁用');
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
