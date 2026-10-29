'use strict';
// 正文里的本机图片 → 内联 data URI。
//
// 真机现象：DSH 桌面回答里写的 `![](/tmp/x.png)` 在 App 对话页显示的是一串字面 markdown。
// 原因是渲染侧只认 http(s) 远程图，而手机既没有那个文件、移动 API 也没有「按路径读文件」
// 的能力面（见 host-bridge-endpoints 守卫的 forbidden 表）。正确的修法不是加路由，而是换形状：
// 与用户自己发的图片完全一致地内联成 data URI。
//
// 这里直接驱动纯函数 inlineTextImages（不经过 HTTP），把「什么该换、什么必须原样保留」
// 钉住：本机位图才换（绝对路径，或按会话工作区解析的相对路径）；远程、data:、没给工作区
// 目录时的相对路径、非图片字节、超预算一律保持字面 markdown —— 宁可显示成字面文本，
// 也不能让一段历史或一帧 SSE 因为一张图取不到而挂掉。
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
  assert.ok(/!\[截图\]\(dsh-local-image:[a-f0-9]{16}(\?w=\d+&h=\d+)?\)/.test(out), out);
  assert.ok(out.includes('看这张图') && out.includes('后面还有话'), '图片以外的文本必须原样保留');
}));

test('尖括号包裹的目的地（CommonMark）同样能内联', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const out = await inlineTextImages(`![](<${shot}>)`);
  assert.ok(out.includes('dsh-local-image:'), out);
  assert.ok(!/dsh-local-image:<|%3C/.test(out), '尖括号不能留在编号上');
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
  assert.ok(bracketed.includes('dsh-local-image:'), bracketed.slice(0, 80));

  // 括号内的首尾空白按 mdast 的做法忽略（`![a]( /x/a.png )`）。
  const padded = await inlineTextImages(`![a]( ${plainShot} )`);
  assert.ok(padded.includes('dsh-local-image:'), padded.slice(0, 80));

  // 裸写带空格的路径连解析都不成立（会截成 `…/nested`），保持字面。
  const bare = `![a](${spacedShot})`;
  assert.equal(await inlineTextImages(bare), bare);
}));

test('file:// 形式的绝对路径能内联', () => withTempDir(async (dir) => {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, TINY_PNG);
  const out = await inlineTextImages(`![](file://${shot})`);
  assert.ok(out.includes('dsh-local-image:'), out);
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
  assert.ok(out.includes('![真图](dsh-local-image:'), '围栏外的真图仍要换成编号');
  assert.equal((out.match(/dsh-local-image:/g) || []).length, 1, '只有代码块外那一处能换成编号');
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
    '![rel](./docs/a.png)',                   // 相对路径：没有工作区目录（下面另有一条给了就内联）
    '![w](www.example.com/a.png)',            // 裸域名
    `![t](${path.join(dir, 'notes.txt')})`,   // 扩展名不是图片
    // 不存在的文件。用临时目录里的路径而不是 `/tmp/a.png`：后者在别人机器上
    // 真可能存在，那时这条会莫名其妙地红（2026-10-23 实测踩过）。
    `![bare](${path.join(dir, 'not-there.png')})`,
    '![empty](https://x.com/a.png)',          // 与第一条同形，保证多图场景不互相干扰
  ];
  for (const text of cases) {
    assert.equal(await inlineTextImages(text), text, text);
  }
  assert.ok(fs.existsSync(path.join(dir, 'shot.png')), '这些路径本身不该被创建/改写');
}));

// 桌面端画得出正文里的相对地址（它按会话工作区解析），手机端也得画得出：插件这边唯一的
// 差别就是「不拿绝对路径也得知道从哪里起算」，所以工作区目录一给，相对地址照样内联。
test('相对地址按工作区目录内联；没给目录或文件不存在时保持字面', () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'deliverables'));
  fs.writeFileSync(path.join(dir, 'deliverables', 'shot.png'), TINY_PNG);
  const text = '![日落插画](deliverables/shot.png)';

  const withCwd = createTextImageBudget();
  withCwd.cwd = dir;
  const out = await inlineTextImages(text, withCwd);
  assert.ok(out.includes('dsh-local-image:'), out.slice(0, 80));
  assert.ok(out.includes('![日落插画]('), 'alt 与文字保持原样');

  assert.equal(await inlineTextImages(text), text, '没有工作区目录时不猜');

  const missing = createTextImageBudget();
  missing.cwd = dir;
  const missText = '![缺](deliverables/none.png)';
  assert.equal(await inlineTextImages(missText, missing), missText, '盘上没有就保持字面');
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
  assert.ok(first.includes('dsh-local-image:'), first);
  // 预算按「张数」算（编号只有几十字节）：两张小图都换得了。
  assert.equal((first.match(/dsh-local-image:/g) || []).length, 2, first);
}));

test('单张超过上限的图保持字面 markdown', async () => withTempDir(async (dir) => {
  const huge = path.join(dir, 'huge.png');
  fs.writeFileSync(huge, Buffer.concat([TINY_PNG, Buffer.alloc(3 * 1024 * 1024)]));
  const text = `![big](${huge})`;
  assert.equal(await inlineTextImages(text), text, '2.5MB 以上的原图不内联');
}));

test('localImagePathOf 只认本机位图（相对地址要有工作区目录才认）', () => {
  assert.equal(localImagePathOf('/tmp/a.png'), path.normalize('/tmp/a.png'));
  assert.equal(localImagePathOf('</tmp/a.PNG>'), path.normalize('/tmp/a.PNG'));
  assert.equal(localImagePathOf(path.join(os.homedir(), 'a.png')), path.join(os.homedir(), 'a.png'));
  assert.equal(localImagePathOf('~/a.webp'), path.join(os.homedir(), 'a.webp'));
  assert.equal(localImagePathOf('file:///tmp/a.jpeg'), path.normalize('/tmp/a.jpeg'));
  assert.equal(localImagePathOf('https://x.com/a.png'), null);
  assert.equal(localImagePathOf('data:image/png;base64,AA'), null);
  assert.equal(localImagePathOf('a.png'), null);
  assert.equal(localImagePathOf('a.png', '/tmp'), path.normalize('/tmp/a.png'));
  assert.equal(localImagePathOf('./docs/a.png', '/tmp'), path.normalize('/tmp/docs/a.png'));
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
  assert.ok(item.text.includes('dsh-local-image:'), item.text.slice(0, 120));
  assert.ok(item.blocks[0].text.includes('dsh-local-image:'), JSON.stringify(item.blocks[0]).slice(0, 120));
  assert.ok(item.text.includes('![截图]('), '文字部分仍在，只是目的地换了');

  const untouched = await resolveEventAttachments({}, 'sess-1', event, { budget: { remaining: 0 } });
  assert.ok(deriveMessages([untouched])[0].text.includes(`![截图](${shot})`), '预算用尽时保持字面 markdown');
}));

// 接线（相对地址）：工作区目录取自会话列表摘要，一条响应只查一次；会话不在列表里
// （或宿主没回）就退回「相对地址保持字面」，绝不抛。
test('接线：正文里的相对地址图片按会话工作区内联', () => withTempDir(async (dir) => {
  fs.mkdirSync(path.join(dir, 'deliverables'));
  fs.writeFileSync(path.join(dir, 'deliverables', 'shot.png'), TINY_PNG);
  const event = {
    seq: 5,
    time: 1_700_000_000_002,
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '看这张：\n\n![日落](deliverables/shot.png)' }] } },
  };

  let listCalls = 0;
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => {
          listCalls += 1;
          return { result: { ok: true, value: { items: [{ sessionId: 'sess-1', cwd: dir }] } } };
        },
      },
    },
  };
  const resolved = await resolveEventAttachments(ctx, 'sess-1', event);
  const [item] = deriveMessages([resolved]);
  assert.ok(item.text.includes('dsh-local-image:'), item.text.slice(0, 120));
  assert.ok(item.blocks[0].text.includes('dsh-local-image:'), 'blocks 那条路同样要画得出来');
  assert.equal(listCalls, 1, '同一条响应只查一次会话列表');

  const noCwd = { apiProxy: { sessions: { list: async () => ({ result: { ok: true, value: { items: [] } } }) } } };
  const plain = await resolveEventAttachments(noCwd, 'sess-1', event);
  assert.ok(deriveMessages([plain])[0].text.includes('![日落](deliverables/shot.png)'), '取不到工作区目录就保持字面');

  // 一条会话列表都不该为绝对路径的图去查（那是老口径，不必多付一次 list 扫描）。
  const absolute = {
    seq: 6,
    time: 1_700_000_000_003,
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: `![绝对](${path.join(dir, 'deliverables', 'shot.png')})` }] } },
  };
  let absoluteCalls = 0;
  const counting = { apiProxy: { sessions: { list: async () => { absoluteCalls += 1; throw new Error('不该被调用'); } } } };
  const absoluteResolved = await resolveEventAttachments(counting, 'sess-1', absolute);
  assert.ok(deriveMessages([absoluteResolved])[0].text.includes('dsh-local-image:'), '绝对路径照旧换成编号');
  assert.equal(absoluteCalls, 0, '绝对路径不该触发会话列表查询');
}));

const attachmentEvent = () => ({
  seq: 4,
  time: 1_700_000_000_001,
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [
    { type: 'text', text: '图片见附件' },
    { type: 'image', mediaType: 'image/png', attachment: { attachmentId: 'missing-image', mediaType: 'image/png' }, name: 'preview.png' },
  ] } },
});

test('接线（取字节模式）：历史图片附件取回失败仍投影为可重试附件，不泄漏内部块 JSON', async () => {
  const ctx = { apiProxy: { sessions: { attachment: async () => { throw new Error('attachment unavailable'); } } } };
  const resolved = await resolveEventAttachments(ctx, 'sess-1', attachmentEvent(), { referencesOnly: false });
  const [item] = deriveMessages([resolved]);
  assert.equal(item.text, '图片见附件');
  assert.deepEqual(item.unavailableImages, [{ attachmentId: 'missing-image', mediaType: 'image/png', name: 'preview.png' }]);
  assert.equal(item.blocks.some((block) => block.text?.includes('dataUnavailable')), false);
});

// 默认（引用模式）是会话正文图片的正式契约：只下发 attachmentId、不带 data，且**一次宿主
// RPC 都不发**。这条钉的就是「探针式的取字节」不能再回来——它曾让一页 200 条带十几张
// 截图的响应接近 10MB，每次进会话都要重传一遍。
test('接线（引用模式）：图片只下发 attachmentId、不带 data，也不发附件 RPC', async () => {
  let calls = 0;
  const ctx = { apiProxy: { sessions: { attachment: async () => { calls += 1; throw new Error('不该被调用'); } } } };
  const resolved = await resolveEventAttachments(ctx, 'sess-1', attachmentEvent());
  assert.equal(calls, 0, '引用模式不该发宿主 attachment RPC');
  const [item] = deriveMessages([resolved]);
  assert.equal(item.text, '图片见附件');
  assert.deepEqual(item.images, [{ mediaType: 'image/png', name: 'preview.png', attachmentId: 'missing-image' }]);
  assert.equal(Object.hasOwn(item.images[0], 'data'), false, '引用条目不许带 data');
  assert.equal(item.unavailableImages, undefined, '引用模式下取不到字节不是「失败」，是没取');
});