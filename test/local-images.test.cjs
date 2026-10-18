'use strict';
// 正文里的本机图片 → 内联 data URI。
//
// 真机现象：DSH 桌面回答里写的 `![](/tmp/x.png)` 在 App 对话页显示的是一串字面 markdown。
// 原因是渲染侧只认 http(s) 远程图，而手机既没有那个文件、移动 API 也没有「按路径读文件」
// 的能力面（见 host-bridge-endpoints 守卫的 forbidden 表）。正确的修法不是加路由，而是换形状：
// 与用户自己发的图片完全一致地内联成 data URI。
//
// 这里直接驱动纯函数 inlineTextImages（不经过 HTTP），把「什么该换、什么必须原样保留」
// 钉住：只有绝对路径的本机位图才换；远程、data:、相对路径、非图片字节、超预算一律保持字面
// markdown —— 宁可显示成字面文本，也不能让一段历史或一帧 SSE 因为一张图取不到而挂掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inlineTextImages, createTextImageBudget, localImagePathOf } = require('../lib/mobile/local-images.js');
const { resolveEventAttachments } = require('../lib/mobile/attachments.js');
const { deriveMessages } = require('../lib/mobile/sessions.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TINY_PNG = Buffer.concat([PNG_MAGIC, Buffer.from('body-of-a-fake-png')]);

/** 每次跑在自己的临时目录里：真实路径检测是这条逻辑的全部意义。 */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-images-'));
  try {
    // 必须 await：临时目录要活到回调（含其中的读盘）全部跑完，否则文件会先被删掉。
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('绝对路径的本机 PNG 被换成 data URI，且保留 alt 与周围文本', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const text = `看这张图\n\n![截图](${shot})\n\n后面还有话`;
  const out = await inlineTextImages(text);
  assert.notEqual(out, text, '应当被改写');
  assert.ok(out.includes(`![截图](data:image/png;base64,${TINY_PNG.toString('base64')})`), out);
  assert.ok(out.includes('看这张图') && out.includes('后面还有话'), '图片以外的文本必须原样保留');
}));

test('尖括号包裹的目的地（CommonMark）同样能内联', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const out = await inlineTextImages(`![](<${shot}>)`);
  assert.ok(out.includes('data:image/png;base64,'), out);
  assert.ok(!out.includes('data:image/png;base64,<'), '尖括号不能留在 data URI 上');
}));

test('带空格的路径靠 `<>` 包裹也能内联，括号两侧的空白一并忽略', () => withTempDir(async (dir) => {
  const nested = path.join(dir, 'nested dir');
  fs.mkdirSync(nested);
  const spacedShot = path.join(nested, 'shot 1.png');
  const plainShot = path.join(dir, 'shot.png');
  fs.writeFileSync(spacedShot, TINY_PNG);
  fs.writeFileSync(plainShot, TINY_PNG);

  // 带空格的路径只有 `<>` 这一种合法写法，而 App 侧解析器认它 —— 两边必须一致。
  const bracketed = await inlineTextImages(`![](<${spacedShot}>)`);
  assert.ok(bracketed.includes('data:image/png;base64,'), bracketed.slice(0, 80));

  // 括号内的首尾空白按 mdast 的做法忽略（`![a]( /x/a.png )`）。
  const padded = await inlineTextImages(`![a]( ${plainShot} )`);
  assert.ok(padded.includes('data:image/png;base64,'), padded.slice(0, 80));

  // 裸写带空格的路径连解析都不成立（会截成 `…/nested`），保持字面。
  const bare = `![a](${spacedShot})`;
  assert.equal(await inlineTextImages(bare), bare);
}));

test('file:// 形式的绝对路径能内联', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const out = await inlineTextImages(`![](file://${shot})`);
  assert.ok(out.includes('data:image/png;base64,'), out);
}));

test('代码块与行内代码里的图片语法保持字面（那是写法示例，不是图）', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const text = [
    '写法和真图：',
    '',
    '```md',
    `![示例](${shot})`,
    '```',
    '',
    '~~~',
    `![波浪号围栏](${shot})`,
    '~~~',
    '',
    '````',
    '```',
    `![四反引号围栏](${shot})`,
    '```',
    '````',
    '',
    `\`![行内](${shot})\``,
    '',
    `![真图](${shot})`,
  ].join('\n');
  const out = await inlineTextImages(text);
  assert.ok(out.includes(`\`\`\`md\n![示例](${shot})\n\`\`\``), '反引号围栏必须原样保留');
  assert.ok(out.includes(`~~~\n![波浪号围栏](${shot})\n~~~`), '波浪号围栏同样原样保留');
  assert.ok(out.includes(`\`\`\`\n![四反引号围栏](${shot})\n\`\`\``), '4 个反引号的围栏不能被 3 个的闭合行提前关掉');
  assert.ok(out.includes(`\`![行内](${shot})\``), '行内代码必须原样保留');
  assert.ok(out.includes('![真图](data:image/png;base64,'), '围栏外的真图仍要内联');
  assert.equal((out.match(/data:image\/png;base64,/g) || []).length, 1, '只有代码块外那一处能变成 data URI');
}));

test('未闭合的围栏一直保护到文末', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const text = `示例：\n\n\`\`\`\n![x](${shot})\n`;
  assert.equal(await inlineTextImages(text), text);
}));

test('不是图片的地址一律保持字面 markdown', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const cases = [
    '![r](https://cdn.example.com/a.png)',   // 远程图：App 自己会拉
    '![d](data:image/png;base64,AAAA)',      // 已经是内联形状
    '![rel](./docs/a.png)',                   // 相对路径
    '![w](www.example.com/a.png)',            // 裸域名
    `![t](${path.join(dir, 'notes.txt')})`,   // 扩展名不是图片
    '![bare](/tmp/a.png)',                    // 不存在的文件
    '![empty](https://x.com/a.png)',          // 与第一条同形，保证多图场景不互相干扰
  ];
  for (const text of cases) {
    assert.equal(await inlineTextImages(text), text, text);
  }
  assert.ok(fs.existsSync(path.join(dir, 'shot.png')), '这些路径本身不该被创建/改写');
}));

test('扩展名像图片但字节不是图片：按魔术字节拒绝，绝不按扩展名撒谎', () => withTempDir(async (dir) => {
  const decoy = path.join(dir, 'decoy.png');
  fs.writeFileSync(decoy, Buffer.from('#!/bin/sh\necho not an image\n'));
  const text = `![x](${decoy})`;
  assert.equal(await inlineTextImages(text), text, '字节不是位图就不能内联');
}));

test('没有图片语法时返回同一个字符串（调用方据此免掉对象拷贝）', async () => {
  const text = '普通回答，只有行内 `code` 与 **强调**。';
  assert.equal(await inlineTextImages(text), text);
  assert.equal(await inlineTextImages('![a](https://x.com/a.png)'), '![a](https://x.com/a.png)');
});

test('预算用尽后剩下的图片保持字面 markdown', async () => withTempDir(async (dir) => {
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  fs.writeFileSync(a, TINY_PNG);
  fs.writeFileSync(b, TINY_PNG);
  const text = `![a](${a})\n![b](${b})`;
  const out = await inlineTextImages(text, createTextImageBudget(0));
  assert.equal(out, text, '预算为 0 时一个字都不该动');

  const first = await inlineTextImages(text);
  assert.ok(first.includes('data:image/png;base64,'), first);
  // 单次调用内的两处图片共享同一份文本级预算：小图两张都装得下。
  assert.equal((first.match(/data:image\/png;base64,/g) || []).length, 2, first);
}));

test('单张超过上限的图保持字面 markdown', async () => withTempDir(async (dir) => {
  const huge = path.join(dir, 'huge.png');
  fs.writeFileSync(huge, Buffer.concat([TINY_PNG, Buffer.alloc(3 * 1024 * 1024)]));
  const text = `![big](${huge})`;
  assert.equal(await inlineTextImages(text), text, '2.5MB 以上的原图不内联');
}));

test('localImagePathOf 只认本机绝对路径的位图', () => {
  assert.equal(localImagePathOf('/tmp/a.png'), path.normalize('/tmp/a.png'));
  assert.equal(localImagePathOf('</tmp/a.PNG>'), path.normalize('/tmp/a.PNG'));
  assert.equal(localImagePathOf(path.join(os.homedir(), 'a.png')), path.join(os.homedir(), 'a.png'));
  assert.equal(localImagePathOf('~/a.webp'), path.join(os.homedir(), 'a.webp'));
  assert.equal(localImagePathOf('file:///tmp/a.jpeg'), path.normalize('/tmp/a.jpeg'));
  assert.equal(localImagePathOf('https://x.com/a.png'), null);
  assert.equal(localImagePathOf('data:image/png;base64,AA'), null);
  assert.equal(localImagePathOf('a.png'), null);
  assert.equal(localImagePathOf('/tmp/a.txt'), null);
});

test('目录即使叫 .png 也不是图片（只有普通文件才内联）', () => withTempDir(async (dir) => {
  const decoyDir = path.join(dir, 'dir.png');
  fs.mkdirSync(decoyDir);
  const text = `![d](${decoyDir})`;
  assert.equal(await inlineTextImages(text), text);
}));

// 上面都是纯函数；这一条走真实接线：事件 → resolveEventAttachments → deriveMessages，
// 也就是 App 真正收到的那份形状（text 与 blocks[].text 必须同时带上 data URI，
// 因为 MessageBubble 有 blocks 时渲染 blocks、没有时渲染 text，两条路都得能画出来）。
test('接线：事件文本里的本机图片在派生出的消息里也是内联形状', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const event = {
    seq: 3,
    time: 1_700_000_000_000,
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: `看这张：\n\n![截图](${shot})\n\n完。` }] } },
  };
  const resolved = await resolveEventAttachments({}, 'sess-1', event);
  const items = deriveMessages([resolved]);
  const item = items[0];
  assert.ok(item.text.includes('data:image/png;base64,'), item.text.slice(0, 120));
  assert.ok(item.blocks[0].text.includes('data:image/png;base64,'), JSON.stringify(item.blocks[0]).slice(0, 120));
  assert.ok(item.text.includes('![截图]('), '文字部分仍在，只是目的地换了');

  const untouched = await resolveEventAttachments({}, 'sess-1', event, { budget: { remaining: 0 } });
  assert.ok(deriveMessages([untouched])[0].text.includes(`![截图](${shot})`), '预算用尽时保持字面 markdown');
}));