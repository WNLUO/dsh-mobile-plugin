'use strict';

/** 配对二维码展示尺寸、白边与主页默认隐藏行为。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'React', 'src');
const read = (name) => fs.readFileSync(path.join(src, name), 'utf8');

test('引导页二维码放大并保留白色边框', () => {
  const page = read('Onboarding.tsx');
  assert.match(page, /const qrSvg = pairing\?\.svg \?\? ''/);
  assert.match(page, /size-\[280px\] rounded-lg bg-white p-3 \[&_svg\]:h-full \[&_svg\]:w-full/);
  assert.match(page, /dangerouslySetInnerHTML=\{\{ __html: qrSvg \}\}/);
});

test('主页二维码放大并保留白边，默认隐藏时不渲染 SVG', () => {
  const card = read('components/PairingCard.tsx');
  assert.match(card, /useState\(\{ qr: false, relay: false \}\)/);
  assert.match(card, /!shown\.qr && pairing\?\.svg \? \([\s\S]*?size-\[280px\][\s\S]*?\) : \(<div className="[^"]*bg-white p-2"/);
  // 白底与占位是同一块 280 见方的格子，里面再撑满：遮着 / 揭开两种状态卡片高度必须一致。
  assert.match(card, /className="flex size-\[280px\] items-center justify-center overflow-hidden rounded-md border border-border-muted bg-white p-2"/);
  assert.match(card, /className="size-full \[&_svg\]:h-full \[&_svg\]:w-full"/);
  assert.match(card, /dangerouslySetInnerHTML=\{\{ __html: pairing\.svg \}\}/);
});

test('两处都能点开「看大图」弹窗，放大版仍是同一份 SVG 且不改默认隐藏', () => {
  const card = read('components/PairingCard.tsx');
  const page = read('Onboarding.tsx');
  // 主页：点码本身开弹窗（2026-11-02 起不再单独摆一颗「看大图」按钮），弹窗里按视口高度
  // 放大（440px 上限），白底。
  assert.match(card, /const \[qrZoom, setQrZoom\] = React\.useState\(false\)/);
  assert.match(card, /onClick=\{\(\) => setQrZoom\(true\)\}[\s\S]{0,400}dangerouslySetInnerHTML=\{\{ __html: pairing\.svg \}\}/);
  assert.match(card, /<Dialog open=\{qrZoom\} onOpenChange=\{setQrZoom\}>/);
  assert.match(card, /size-\[min\(70vh,440px\)\] \[&_svg\]:h-full \[&_svg\]:w-full/);
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

