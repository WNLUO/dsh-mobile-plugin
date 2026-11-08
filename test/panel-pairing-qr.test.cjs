'use strict';

/**
 * 配对二维码：展示尺寸与白边、主页默认隐藏，以及隧道段临期前的自动续码。
 *
 * 续码那一条是 2026-11-07 加的：宿主每取一次码就现开一个两分钟的一次性隧道窗口、并作废
 * 上一张，而用户常常是装完 App 过一阵才回来扫。不续的话屏幕上那张的隧道段早过期，App 静默
 * 丢掉它、只剩局域网与中转 —— 手机不在同一网且中转不通时就是「扫不上但码看着正常」。
 * 所以面板要在临期前重取一次；但**不能退化成轮询**（每两分钟白开一个没人扫的窗口）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'React', 'src');
const read = (name) => fs.readFileSync(path.join(src, name), 'utf8');

test('引导页二维码放大并保留白色边框', () => {
  const page = read('Onboarding.tsx');
  assert.match(page, /const qrSvg = pairing\?\.svg \?\? ''/);
  assert.match(page, /size-\[320px\] max-w-full rounded-lg bg-white p-3 \[&_svg\]:h-full \[&_svg\]:w-full/);
  assert.match(page, /dangerouslySetInnerHTML=\{\{ __html: qrSvg \}\}/);
});

test('主页二维码放大并保留白边，默认隐藏时不渲染 SVG', () => {
  const card = read('components/PairingCard.tsx');
  assert.match(card, /useState\(\{ qr: false, relay: false \}\)/);
  assert.match(card, /!shown\.qr && pairing\?\.svg \? \([\s\S]*?size-\[360px\][\s\S]*?\) : \(<div className="[^"]*bg-white p-2"/);
  // 白底与占位是同一块 360 见方的格子，里面再撑满：遮着 / 揭开两种状态卡片高度必须一致。
  // 2026-11-09 从 280 放大到 360：码密到一百多个模块时，280 摆下来一个模块只剩两像素多。
  assert.match(card, /className="flex size-\[360px\] max-w-full items-center justify-center overflow-hidden rounded-md border border-border-muted bg-white p-2"/);
  assert.match(card, /className="size-full \[&_svg\]:h-full \[&_svg\]:w-full"/);
  assert.match(card, /dangerouslySetInnerHTML=\{\{ __html: pairing\.svg \}\}/);
});

test('两处都能点开「看大图」弹窗，放大版仍是同一份 SVG 且不改默认隐藏', () => {
  const card = read('components/PairingCard.tsx');
  const page = read('Onboarding.tsx');
  // 主页：点码本身开弹窗（2026-11-02 起不再单独摆一颗「看大图」按钮），弹窗里按视口高度
  // 放大（600px 上限，2026-11-09 从 440 抬高），白底。
  assert.match(card, /const \[qrZoom, setQrZoom\] = React\.useState\(false\)/);
  assert.match(card, /onClick=\{\(\) => setQrZoom\(true\)\}[\s\S]{0,400}dangerouslySetInnerHTML=\{\{ __html: pairing\.svg \}\}/);
  assert.match(card, /<Dialog open=\{qrZoom\} onOpenChange=\{setQrZoom\}>/);
  assert.match(card, /size-\[min\(72vh,600px\)\] \[&_svg\]:h-full \[&_svg\]:w-full/);
  // 那颗按钮撤了：码本身就够点，遮着的时候也不该有一处点了只看见空白的地方。
  // 现在 `panel.pairing.qrZoom` 只剩码自己那个 `aria-label` 一处。
  assert.equal(
    (card.match(/panel\.pairing\.qrZoom/g) ?? []).length,
    1,
    '主页那颗「看大图」按钮已经删了，别再加回来',
  );
  // 引导页同一份弹窗：码还没有的时候不给放大（那时弹窗里只是一片白）。
  assert.match(page, /const \[qrZoomOpen, setQrZoomOpen\] = useState\(false\)/);
  assert.match(page, /<Dialog open=\{qrZoomOpen\} onOpenChange=\{setQrZoomOpen\}>/);
  assert.match(page, /\{qrSvg \? \([\s\S]{0,200}panel\.pairing\.qrZoom/);
  assert.match(page, /onClick=\{\(\) => setQrZoomOpen\(true\)\}[\s\S]{0,400}dangerouslySetInnerHTML=\{\{ __html: qrSvg \}\}/);
});

test('引导页与主页都在隧道段临期前续一次码，且排的是下一拍而不是轮询', () => {
  const page = read('Onboarding.tsx');
  const app = read('App.tsx');
  // 两处同一套写法：读这一版码的 `expiresAt`，排一个定时器，到点重取一次。
  for (const [name, text] of [['Onboarding.tsx', page], ['App.tsx', app]]) {
    assert.match(text, /const wait = pairingRenewIn\(pairing\)/, `${name} 要按这一版码的隧道段排下一拍`);
    assert.match(
      text,
      /window\.setTimeout\(\(\) =>[\s\S]{0,120}(load|renew)Pairing\(\)[\s\S]{0,200}window\.clearTimeout\(timer\)/,
      `${name} 到点只重取一次，卸载时要把定时器撤掉`,
    );
    // 挂在 `pairing` 上：每拿到一版新码就按它的新 `expiresAt` 重排，而不是一秒一轮去问宿主。
    assert.match(text, /\}, \[pairing/);
    assert.ok(
      !/window\.setInterval\([\s\S]{0,200}(load|renew)Pairing/.test(text),
      `${name} 不许把续码做成轮询：每两分钟开一个没人扫的配对窗口，助手那边是实打实的开销`,
    );
  }
  // 主页只在远程控制开着时续：关着的时候宿主对这条路由回 409。
  assert.match(app, /if \(!status\?\.enabled\) return[\s\S]{0,120}pairingRenewIn\(pairing\)/);
  // 续码失败要留着屏幕上那张：`loadPairing` 失败会把码清掉换成一句报错，而背景续码时
  // 屏幕上那张的局域网与中转两段仍然能扫，换成报错只会让人以为码坏了。
  assert.match(
    app,
    /const renewPairing = useCallback\(async \(\) => \{[\s\S]{0,200}catch \{[\s\S]{0,120}\}[\s\S]{0,40}\}, \[\]\)/,
    '主页的续码要走一份不清码的取法',
  );
});

test('续码间隔按隧道段的 expiresAt 算，没有隧道段就不排', async () => {
  const { pairingRenewIn, PAIRING_RENEW_LEAD_MS } = await import(
    path.join(src, 'lib', 'api.ts')
  );
  const now = 1_700_000_000_000;
  const at = (seconds) => ({ ok: true, tailcat: { address: 'a', port: 1, expiresAt: seconds } });

  // 两分钟的窗口取到码，正常节奏是九十秒后再续一次（留 30 秒给人扫码）。
  assert.equal(pairingRenewIn(at(now / 1000 + 120), now), 120_000 - PAIRING_RENEW_LEAD_MS);
  // 只剩最后几秒：一秒后再取，别当场连着发。
  assert.equal(pairingRenewIn(at(now / 1000 + 2), now), 1_000);
  // 没有隧道段：助手不可用 / 出错 / 老宿主没有这个字段 —— 不排下一拍。
  assert.equal(pairingRenewIn({ ok: true }, now), null);
  assert.equal(pairingRenewIn({ ok: true, tailcat: null }, now), null);
  assert.equal(pairingRenewIn(null, now), null);
  // 拿到手就已经过期：这一页的钟和宿主对不上（远程打开面板时常见），倒计时算不出来就不排，
  // 否则定时器会退化成每秒重取一次、每次都白开一个配对窗口。
  assert.equal(pairingRenewIn(at(now / 1000 - 60), now), null, '过期的隧道段不排下一拍');
});

