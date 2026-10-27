'use strict';

/** 配对二维码展示尺寸、白边与主页默认隐藏行为。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'React', 'src');
const read = (name) => fs.readFileSync(path.join(src, name), 'utf8');

test('引导页二维码放大并保留白色边框，预览码仍走同一展示', () => {
  const page = read('Onboarding.tsx');
  assert.match(page, /md:grid-cols-\[280px_1fr\]/);
  assert.match(page, /const qrSvg = showingPreview \? previewSvg : pairing\?\.svg/);
  assert.match(page, /size-\[280px\] rounded-lg bg-white p-3 \[&_svg\]:h-full \[&_svg\]:w-full/);
  assert.match(page, /dangerouslySetInnerHTML=\{\{ __html: qrSvg \}\}/);
});

test('主页二维码放大并保留白边，默认隐藏时不渲染 SVG', () => {
  const card = read('components/PairingCard.tsx');
  assert.match(card, /useState\(\{ qr: false, relay: false \}\)/);
  assert.match(card, /!shown\.qr && pairing\?\.svg \? \([\s\S]*?size-\[280px\][\s\S]*?\) : \(<div className="[^"]*bg-white p-3"/);
  assert.match(card, /size-\[256px\] \[&_svg\]:h-full \[&_svg\]:w-full/);
  assert.match(card, /dangerouslySetInnerHTML=\{\{ __html: pairing\.svg \}\}/);
});

test('两处都能点开「看大图」弹窗，放大版仍是同一份 SVG 且不改默认隐藏', () => {
  const card = read('components/PairingCard.tsx');
  const page = read('Onboarding.tsx');
  // 主页：点码本身或那颗按钮都开弹窗，弹窗里按视口高度放大（440px 上限），白底。
  assert.match(card, /const \[qrZoom, setQrZoom\] = React\.useState\(false\)/);
  assert.match(card, /onClick=\{\(\) => setQrZoom\(true\)\}[\s\S]{0,400}dangerouslySetInnerHTML=\{\{ __html: pairing\.svg \}\}/);
  assert.match(card, /<Dialog open=\{qrZoom\} onOpenChange=\{setQrZoom\}>/);
  assert.match(card, /size-\[min\(70vh,440px\)\] \[&_svg\]:h-full \[&_svg\]:w-full/);
  // 遮着的时候不摆那颗按钮：点开只会看见一片白。
  assert.match(card, /\{shown\.qr && pairing\?\.svg \? \([\s\S]{0,200}panel\.pairing\.qrZoom/);
  // 引导页同一份弹窗，码被虚线占位挡住时不给放大。
  assert.match(page, /const \[qrZoomOpen, setQrZoomOpen\] = useState\(false\)/);
  assert.match(page, /<Dialog open=\{qrZoomOpen\} onOpenChange=\{setQrZoomOpen\}>/);
  assert.match(page, /\{qrSvg && !qrBlocked \? \([\s\S]{0,200}panel\.pairing\.qrZoom/);
  assert.match(page, /onClick=\{\(\) => setQrZoomOpen\(true\)\}[\s\S]{0,400}dangerouslySetInnerHTML=\{\{ __html: qrSvg \}\}/);
});

