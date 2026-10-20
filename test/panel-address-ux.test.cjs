'use strict';

/**
 * 面板上两处「用户报过一次就别再回来」的约定（2026-10-11 一张截图报的两个问题）。
 *
 *   ① 地址那一行必须按**检测出来的那一份**给标签（局域网 / 公网），而且能就地选「手机优先
 *      用哪条」—— 服务器上只有公网地址，从前一律写「局域网地址」且没有可选项；
 *   ② 宿主明说「装完没法就地换代」时，更新卡不能把用户往插件市场带 —— 无头 / 源码同步部署
 *      那台机器上根本没有市场，它的更新是「同步源码 + 重启宿主服务」。
 *
 * 这里读的是面板源码（不是产物）：产物是提交物、要重建才更新，而这两条约定是**写法**上的，
 * 源码一变就该红。真正渲染出来长什么样由 `React/scripts/ssr-smoke.mjs` 与开发服务器的
 * 演示数据（`React/dev/mock-api.ts`）负责看。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPONENTS = path.join(__dirname, '..', 'React', 'src', 'components');
const read = (name) => fs.readFileSync(path.join(COMPONENTS, name), 'utf8');

test('地址按检测出来的那份给标签，配对卡与直连弹窗共用同一个选择器', () => {
  const picker = read('AddressPicker.tsx');
  // 两份清单各自的名字：有私网就是局域网地址，一条私网都没有才是公网地址。
  assert.match(picker, /局域网地址/, '选择器必须会写「局域网地址」这一种');
  assert.match(picker, /公网地址/, '选择器必须会写「公网地址」这一种');
  // 能选的那份必须与宿主 `advertisedCandidates` 同口径（有私网就只带私网），
  // 否则会出现「选了一条二维码里根本没有的地址」。
  assert.match(
    picker,
    /book\.lan\.length > 0 \? book\.lan : book\.public/,
    '能选的那份要与宿主 advertisedCandidates 同口径',
  );
  for (const name of ['PairingCard.tsx', 'LanDialog.tsx']) {
    assert.match(read(name), /AddressPicker/, `${name} 必须用共用的地址选择器，别各写一份口径`);
  }
  assert.ok(
    !/label="局域网地址"/.test(read('PairingCard.tsx')),
    '配对卡又写死了「局域网地址」这一行标签：只有公网地址的机器上那句话是错的',
  );
});

test('IPv6 那份只摆出来、不进「手机优先用这条」那个选择', () => {
  const picker = read('AddressPicker.tsx');
  // 必须真的会画这一份（宿主 2026-10 起就会报，画不出来等于这条链路在界面上不存在）。
  assert.match(picker, /IPv6 直连/, '选择器必须会写「IPv6 直连」这一种标签');
  assert.match(picker, /book\?\.ipv6/, '第三份要从地址库的 ipv6 字段读');
  // **不能进单选**：这一份由手机侧拿它和公网中转实测比速度来择优，做成可选中等于骗人
  // （与下面那条「能选的必须与 advertisedCandidates 同口径」是同一条约定）。
  const pickable = picker.slice(picker.indexOf('export function pickableAddresses'), picker.indexOf('export function otherAddresses'));
  assert.ok(!/ipv6/.test(pickable), 'pickableAddresses 里出现了 ipv6：那一份不能被选中，宿主也不按它排序');
  // 只有 IPv6 的机器不许退成「还没取到地址」——那正是这个地址唯一有用武之地的场景。
  assert.ok(
    !/if \(pickable\.length === 0\) \{\s*if \(fallbackUrls\.length > 0\)/.test(picker),
    '可选项为空时直接退 fallbackUrls：只有 IPv6 的机器上那一条会被整段跳掉',
  );
  // 裸 IPv6 拼 URL 必须套方括号，否则产出的是 `http://240e::1:18787` 这种坏地址。
  assert.match(picker, /address\.includes\(':'\) \? `\[\$\{address\}\]`/, 'IPv6 字面量拼 URL 时必须套方括号');
  // 引导页那份自己渲染地址清单，同样要带上这一份。
  const onboarding = fs.readFileSync(path.join(__dirname, '..', 'React', 'src', 'Onboarding.tsx'), 'utf8');
  assert.match(onboarding, /IPv6 直连/, '引导页的地址清单也要把 IPv6 那份摆出来');
});

test('调试 OTA 只在本机接口可用时显示，并提供检查与安装入口', () => {
  const card = read('UpdateCard.tsx');
  const client = fs.readFileSync(path.join(__dirname, '..', 'React', 'src', 'lib', 'relayUpdate.ts'), 'utf8');
  assert.match(card, /本机调试 OTA/);
  assert.match(card, /检查紧急 OTA/);
  assert.match(card, /立即安装/);
  assert.match(card, /无待吸收的 OTA/, 'OTA 目录清理后不能显示成「未被正式版覆盖」');
  assert.match(card, /setOtaSupported\(false\)/, '仅宿主接口 404 时隐藏调试入口');
  assert.match(client, /\/api\/relay\/update\/ota\/status/);
  assert.match(client, /\/api\/relay\/update\/ota\/check/);
  assert.match(client, /\/api\/relay\/update\/ota\/apply/);
});

test('宿主说没法就地换代时，更新卡不许把用户往插件市场带', () => {
  const card = read('UpdateCard.tsx');
  // 判据是宿主回的 `available: false`（它自己说这份实现是直接被挂载的）。只认 409 那条错误码
  // 时这个分支永远进不来 —— 服务器那台面板上剩下的就是一句「去插件市场更新」（用户报的原文）。
  assert.match(
    card,
    /setNoShell\(next\.available !== true\)/,
    '宿主回 available:false 就要进「没有可换代的外壳」那一支',
  );
  const at = card.indexOf('{noShell ?');
  assert.notEqual(at, -1, '找不到 noShell 那一支');
  const branch = card.slice(at, card.indexOf('市场那条路', at) === -1 ? at + 900 : card.indexOf('市场那条路', at));
  assert.match(branch, /无头/, '那句话里必须点名无头 / 源码同步这条路（那台机器上没有市场）');
  // 这一支要像正常卡片那样**报版本**（查更新不需要外壳，那台答得出「线上最新是几」），
  // 而不是铺一个警告框：把「没有故障」说成故障，用户看到的就是一个没必要的大黄框。
  assert.match(branch, /线上最新/, '要报「线上最新」，别只剩一句警告');
  assert.ok(!/Alert/.test(branch), '别把这一支铺成警告框');
  assert.ok(!/没有可换代的外壳/.test(branch), '那句「这一版没有可换代的外壳」的标题别再回来');
});
