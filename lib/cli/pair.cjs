#!/usr/bin/env node
'use strict';

/**
 * 在终端里把配对二维码打出来（`dsh-mobile-plugin-pair`）。
 *
 * 为什么需要它：二维码那条路由只在本机屏幕或者两小时窗口里给码，而**服务器部署**上
 * 「本机屏幕」这个概念是空的 —— 那台机器的设置页往往开不了，人也够不到它的回环地址。
 * 能在服务器终端里敲命令的人本来就有这台机器的权限，把码打给他，信任量级与「在本机屏幕
 * 上看码」相同，也不新增任何对外的口子。
 *
 * 载荷与面板同一份（`../relay/pairing-payload.cjs`），所以打出来的码一定和面板里那张能
 * 配上同一台机器；这里只负责画图与说人话，不碰配对流程。
 *
 * 用法：
 *   dsh-mobile-plugin-pair              在终端里打出二维码
 *   dsh-mobile-plugin-pair --svg qr.svg 另外存一份 SVG（终端太窄、想发给别人时用）
 */

const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const core = require('../relay/core.js');
const { pairingPayload } = require('../relay/pairing-payload.cjs');

const USAGE = `用法：
  dsh-mobile-plugin-pair               在终端里打印配对二维码
  dsh-mobile-plugin-pair --svg <路径>  同时把二维码存成 SVG 图片`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = { svg: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--svg') {
      const next = argv[index + 1];
      if (!next || next.startsWith('-')) return { error: '--svg 后面要跟一个文件路径' };
      out.svg = next;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true };
    return { error: `不认识的参数：${arg}` };
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.error) {
    fail(`${args.error}\n\n${USAGE}`);
    return;
  }

  // 状态文件是宿主与这里唯一的交接口：宿主每次换码换票据都会落盘，所以读到的那份就是
  // 跑着的宿主手上那份。文件不存在时**不替它建**（`loadState()` 会建），直接说清楚。
  if (!fs.existsSync(core.STATE_FILE)) {
    fail(`这台机器上还没跑过这个插件（找不到 ${core.STATE_FILE}）。先启动 DSH，并在移动端插件里启用远程控制。`);
    return;
  }
  const state = core.loadState();
  if (!state.enabled) {
    fail('远程控制还没启用：先在 DSH 的移动端设置页（或面板）里打开远程控制并保存配置。');
    return;
  }
  const { payload, text } = pairingPayload(state, state.lanPort);
  if (!payload.relayUrl && payload.lanUrls.length === 0) {
    fail('没有可用的中转或直连地址：先在面板上配好中转地址，或打开局域网直连，再回来打码。');
    return;
  }

  const lines = [];
  lines.push(`宿主：${payload.name}`);
  lines.push(`配对码：${payload.code}`);
  lines.push(`中转地址：${payload.relayUrl || '（没配）'}`);
  if (payload.lanUrls.length > 0) {
    lines.push(`直连地址：${payload.lanUrls.join('  ')}`);
    lines.push(`局域网端口：${state.lanPort}`);
  }
  process.stdout.write(`${lines.join('\n')}\n\n`);

  if (args.svg) {
    const target = path.resolve(args.svg);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 480 }));
    process.stdout.write(`二维码已存成图片：${target}\n如果终端太窄扫不动，把这个文件拿下来用看图软件打开再扫。\n\n`);
  }

  // small: true 让一个字符带两行模块，绝大多数终端一行装得下；扫不动就加 --svg。
  process.stdout.write(`${await QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' })}\n`);
  process.stdout.write('用 DSH App 扫这张码即可配对。它等于一次配对权限，别截图发给别人；配完可以在面板上点「重新生成配对码」。\n');
}

main(process.argv.slice(2)).catch((error) => {
  fail(`打码失败：${error && error.message ? error.message : String(error)}`);
});
