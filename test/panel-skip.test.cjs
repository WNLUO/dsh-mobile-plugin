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
  const skipAt = step2.indexOf('void skipSetup()');
  assert.notEqual(skipAt, -1, '第二页要有跳过按钮');
  const skip = step2.slice(skipAt - 120, skipAt + 120);
  assert.match(skip, /t\('panel\.onboarding\.skipSetup'\)/, '跳过按钮要有文案键');
  assert.doesNotMatch(skip, /disabled=/, '跳过按钮不许被 anyReady 或别的门禁禁用');

  const step3 = page.slice(page.indexOf('{step === 3 ? ('), page.indexOf('{/* 服务商面板'));
  assert.ok(!step3.includes('skipSetup'), '第三页不再放跳过：走到扫码这一步就该连上');
});

test('第二页服务商一家一行：接好就不给「去配置」，跳过与下一步并排靠右', () => {
  const step2 = page.slice(page.indexOf('{step === 2 ? ('), page.indexOf('{step === 3 ? ('));
  // 一行一家，不铺两列大卡、也不摆每家那段说明 —— 服务商以后会越来越多。
  assert.match(step2, /<div className="flex flex-col gap-2">/, '服务商竖着排，一家一行');
  assert.doesNotMatch(step2, /sm:grid-cols-2/, '不再两列大卡');
  assert.doesNotMatch(step2, /look\.hint/, '卡片上不再写服务商说明');
  // 接好之后这一行只剩状态。
  assert.match(step2, /\{ready \? null : \(/, '已就绪就不再给「去配置」');
  // 两个按钮都靠右，跳过在下一步左边；没配好时下一步点不动。
  const footer = step2.slice(step2.indexOf('justify-end gap-2 px-4 pb-4'));
  assert.ok(footer.indexOf('skipSetup') !== -1 && footer.indexOf('skipSetup') < footer.indexOf('setStep(3)'), '跳过在下一步左边');
  assert.match(step2, /disabled=\{!anyReady\} onClick=\{\(\) => setStep\(3\)\}/, '没配好时下一步是禁用的');
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

test('第三页先自检再出码：检查中、一条都不通时都不摆二维码', () => {
  const step3 = page.slice(page.indexOf('{step === 3 ? ('), page.indexOf('{/* 服务商面板'))
  assert.match(page, /\/api\/relay\/pairing-check/, '自检打宿主那条只读路由');
  assert.match(page, /const qrBlocked = checkRunning \|\| checkSummary\?\.allFailed === true/, '检查中或全失败都不出码');
  assert.match(step3, /qrReady && !qrBlocked \? \(/, '二维码要等自检通过才画');
  assert.match(step3, /checkRunning \? \([\s\S]{0,160}<Spinner \/>/, '检查中给的是转圈');
  assert.match(step3, /checkSummary\?\.allFailed \? \(/, '全失败要在原地说明');
  // 进第三页就查一次；回第二页换服务商再进来会重查（码里的地址变了）。
  assert.match(page, /if \(step !== 3 \|\| !status\?\.enabled\) return/, '第三页才查');
});

test('自检结论分两档：只有本机回环通时不许说成「局域网正常」', () => {
  assert.match(page, /checkSummary\?\.remoteOk \? \(/, '外部线路通了才说可以扫码');
  assert.match(page, /checkSummary && !checkSummary\.remoteOk && checkSummary\.localOk/, '只剩回环时另说一句');
  assert.match(page, /panel\.onboarding\.check\.loopbackOnly/, '回环那一句走自己的文案键');
  assert.match(page, /first\.local \?/, '行里也要标出这条是本机回环');
});
