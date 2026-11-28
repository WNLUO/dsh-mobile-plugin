// 回环来源的通道标注：第三方穿透转进局域网代理时记 tunnel，不再冒充「局域网」。
'use strict';

/**
 * 反馈 1562:3883 回归（显示口径）。
 *
 * 设备列表那行「最近走的路」来自 lastChannel：请求打进局域网代理时由 channelFor 标注，
 * 结果只进展示、不参与选路。旧判据只看本机监听地址族（localFamily），于是第三方穿透
 * （节点小宝等）从 127.0.0.1 把流量转进代理时，Host 不命中手填域名、localFamily 是 IPv4，
 * 就被记成 lan —— 代码注释自己都写了「那是假话」。
 *
 * 这里从代理源码里取出**真正的 channelFor 闭包体**（不另抄一份），注入不同的
 * manualDirectHost，钉三种来源：手机同网直连（局域网 IP）仍是 lan、回环转进是 tunnel、
 * 手填直连域名命中时仍是 direct。控制面只关心「有标记」，值换白名单内字符串不影响行为。
 *
 * 运行：node --test test/lan-proxy-channel-loopback.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib/relay/lan-proxy.js'), 'utf8');

/** 从源码里取出真正的 channelFor 箭头函数体，注入 manualDirectHost 后返回可调用的函数。 */
function makeChannelFor(manualLanUrl = '') {
  const match = SOURCE.match(/const channelFor = \(req\) => \{([\s\S]*?)\n  \};/);
  assert.ok(match, 'lan-proxy 找不到 channelFor 定义');
  let manualDirectHost = '';
  try { manualDirectHost = manualLanUrl ? new URL(manualLanUrl).hostname.toLowerCase() : '' } catch { /* 非法忽略 */ }
  return new Function('manualDirectHost', 'req', match[1]).bind(null, manualDirectHost);
}

function req({ remoteAddress, localFamily = 'IPv4', host }) {
  return { headers: host ? { host } : {}, socket: { remoteAddress, localFamily } };
}

test('同 Wi-Fi 手机直连（对端是局域网 IP）仍记 lan', () => {
  const channelFor = makeChannelFor();
  assert.equal(channelFor(req({ remoteAddress: '172.16.183.32', host: '172.16.183.129:18787' })), 'lan');
});

test('第三方穿透从 IPv4 回环转进代理记 tunnel，不冒充局域网', () => {
  const channelFor = makeChannelFor();
  assert.equal(channelFor(req({ remoteAddress: '127.0.0.1', host: '172.16.183.129:18787' })), 'tunnel');
});

test('IPv6 回环与 IPv4-mapped 回环同样记 tunnel', () => {
  const channelFor = makeChannelFor();
  assert.equal(channelFor(req({ remoteAddress: '::1', localFamily: 'IPv6' })), 'tunnel');
  assert.equal(channelFor(req({ remoteAddress: '::ffff:127.0.0.1' })), 'tunnel');
});

test('手填直连域名命中时仍记 direct，不被回环判据覆盖', () => {
  const channelFor = makeChannelFor('https://dsh.example.com:8443');
  assert.equal(channelFor(req({ remoteAddress: '127.0.0.1', host: 'dsh.example.com:8443' })), 'direct');
});

test('非回环的 IPv6 对端仍记 ipv6', () => {
  const channelFor = makeChannelFor();
  assert.equal(channelFor(req({ remoteAddress: '2001:db8::5', localFamily: 'IPv6' })), 'ipv6');
});
