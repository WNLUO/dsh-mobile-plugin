'use strict';

/**
 * 守卫：`dsh-mobile-plugin-pair`（终端里打配对二维码）。
 *
 * 它存在的理由是「服务器部署没有本机屏幕」：二维码那条路由只在可信本机界面或两小时窗口
 * 里给码，而一台只有 SSH 的机器上这两样都够不到。能在那台机器的终端里敲命令的人本来就有
 * 机器权限，所以这条路不新增对外口子——守卫要钉住的是：
 *
 *   1. 打出来的码与面板那份**同一个载荷**（同一份状态文件、同一个拼装函数），不会分叉；
 *   2. 「没启用」「没地址」「这台机器上没跑过插件」都说得清是哪种，且**不替用户改盘**；
 *   3. bin 与 `files` 让它在装进来的包里真的存在（否则用户敲什么都找不到）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.join(__dirname, '..');
const CLI = path.join(PKG_DIR, 'lib', 'cli', 'pair.cjs');
const PAYLOAD_MODULE = path.join(PKG_DIR, 'lib', 'relay', 'pairing-payload.cjs');
const IMPL = path.join(PKG_DIR, 'lib', 'impl.js');
const PACKAGE_JSON = path.join(PKG_DIR, 'package.json');

function tempHome(stateFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pair-cli-'));
  if (stateFile) fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify(stateFile, null, 2));
  return dir;
}

function runCli(home, args = []) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  });
}

const ENABLED_STATE = {
  instanceId: 'a1b2c3d4',
  pairingCode: '246810',
  pairingTicket: 't'.repeat(43),
  relayUrl: 'https://relay.example.com',
  name: 'my-server',
  lanEnabled: false,
  lanPort: 18787,
  enabled: true,
};

test('有中转地址时把二维码画在终端里，配对码与地址一并说清', () => {
  const home = tempHome(ENABLED_STATE);
  const result = runCli(home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /配对码：246810/);
  assert.match(result.stdout, /https:\/\/relay\.example\.com/);
  // 终端二维码是半块字符画出来的；少了一格就扫不出来，所以整块图案必须在。
  assert.match(result.stdout, /[▄█]{8,}/);
  assert.match(result.stdout, /用 DSH App 扫这张码/);
});

test('--svg 另外存一份图片，路径来自参数', () => {
  const home = tempHome(ENABLED_STATE);
  const target = path.join(home, 'out', 'qr.svg');
  const result = runCli(home, ['--svg', target]);
  assert.equal(result.status, 0, result.stderr);
  const svg = fs.readFileSync(target, 'utf8');
  assert.match(svg, /^<svg|<\?xml/);
  assert.match(result.stdout, /二维码已存成图片/);
});

test('没启用 / 没地址 / 没跑过插件：三种现场分开说，且不替用户建状态文件', () => {
  const disabled = tempHome({ ...ENABLED_STATE, enabled: false });
  const first = runCli(disabled);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /远程控制还没启用/);
  assert.equal(first.stdout.includes('▄'), false, '没启用时不许打出一张能扫的码');

  const noAddress = tempHome({ ...ENABLED_STATE, relayUrl: '', lanEnabled: false });
  const second = runCli(noAddress);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /没有可用的中转或直连地址/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pair-cli-empty-'));
  const third = runCli(empty);
  assert.equal(third.status, 1);
  assert.match(third.stderr, /还没跑过这个插件/);
  assert.equal(fs.existsSync(path.join(empty, 'relay.json')), false, '读状态不是写状态的借口');
});

test('面板与终端共用同一份载荷，装配层不再自己拼一遍', () => {
  const payloadSource = fs.readFileSync(PAYLOAD_MODULE, 'utf8');
  const implSource = fs.readFileSync(IMPL, 'utf8');
  const cliSource = fs.readFileSync(CLI, 'utf8');
  assert.match(payloadSource, /function pairingPayload/);
  assert.match(payloadSource, /dshpair:\/\/v1\?data=/);
  assert.match(implSource, /require\('\.\/relay\/pairing-payload\.cjs'\)/, '面板读的那份要来自共用模块');
  assert.ok(!/dshpair:\/\/v1\?data=/.test(implSource), '装配层不许再拼第二份二维码原文');
  assert.match(cliSource, /require\('\.\.\/relay\/pairing-payload\.cjs'\)/);
});

test('命令随包发布：bin 注册了它，files 也带得上', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  assert.equal(pkg.bin['dsh-mobile-plugin-pair'], 'lib/cli/pair.cjs');
  assert.ok(fs.existsSync(CLI));
  // `files` 里带着 lib/**/*.cjs，这条断言是「以后有人收窄 files 时会被绊住」的那一颗。
  assert.ok(pkg.files.includes('lib/**/*.cjs'), `files 里没有 lib/**/*.cjs：${pkg.files.join(', ')}`);
});
