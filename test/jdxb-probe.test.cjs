// 节点小宝本地管理口探测：Windows 先问它的虚拟回环，装没装以探测为准（面板据此给安装按钮）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const probe = require(path.join(__dirname, '..', 'lib', 'jdxb', 'probe.cjs'));

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function redirectResponse(location) {
  return { ok: true, status: 302, headers: { get: (key) => (key === 'location' ? location : null) } };
}

function noBindResponse() {
  return { ok: true, status: 200, headers: { get: () => null } };
}

test('平台候选：macOS 2080、Linux 9118、Windows 虚拟回环 2080 再退回本地回环', () => {
  assert.deepEqual(probe.endpointsFor('darwin'), [{ host: '127.0.0.1', port: 2080 }]);
  assert.deepEqual(probe.endpointsFor('linux'), [{ host: '127.0.0.1', port: 9118 }]);
  assert.deepEqual(probe.endpointsFor('win32'), [
    { host: '127.66.36.18', port: 2080 },
    { host: '127.0.0.1', port: 2080 },
  ]);
  assert.deepEqual(probe.endpointsFor('freebsd'), []);
  assert.deepEqual(probe.portsFor('win32'), [2080]);
});

test('readStatus 在 Windows 先问虚拟回环，带回 service.installed 给面板', async () => {
  const urls = [];
  const result = await probe.readStatus({
    platform: 'win32',
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === 'http://127.66.36.18:2080/detect/version') {
        return jsonResponse({ name: 'NodeBabyLinkService', peerid: 'peer-1', tun: '', workmode: '' });
      }
      if (url === 'http://127.66.36.18:2080/bind') {
        return noBindResponse();
      }
      return { ok: false, status: 500 };
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.bound, true, '判据是 /bind 不再给链接，不是 peerid 非空');
  assert.equal(result.host, '127.66.36.18');
  assert.equal(result.port, 2080);
  assert.equal(result.service.installed, true);
  assert.equal(urls.filter((url) => url.includes('/detect/version')).length, 1, '第一个口答话就不再探测第二个');
  assert.ok(urls.some((url) => url.endsWith('/bind')), '判绑定另问了一次 /bind');
});

test('端口上蹲着别的程序不算装了节点小宝', async () => {
  const result = await probe.readStatus({
    platform: 'darwin',
    fetchImpl: async () => jsonResponse({ name: 'AnotherService', peerid: '' }),
  });
  assert.equal(result.installed, false);
  assert.equal(result.service.installed, false);
  assert.match(result.error, /不是节点小宝/);
});

test('没接的平台如实报 supported=false，不让面板去点安装', async () => {
  const result = await probe.readStatus({ platform: 'freebsd' });
  assert.equal(result.supported, false);
  assert.equal(result.service.installed, false);
  assert.match(result.error, /macOS/);
});

test('只给端口时，绑定链接按平台候选主机逐个问', async () => {
  const urls = [];
  const result = await probe.readBindUrl({
    platform: 'win32',
    port: 2080,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.startsWith('http://127.66.36.18:2080/')) {
        return redirectResponse('https://example.com/bind?token=abc');
      }
      return { ok: false, status: 500 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://example.com/bind?token=abc');
  assert.equal(urls[0], 'http://127.66.36.18:2080/bind');
});

test('peerid 非空但 /bind 仍给链接时按未绑定算，面板能拿到绑定链接', async () => {
  const result = await probe.readStatus({
    platform: 'darwin',
    fetchImpl: async (url) => {
      if (url.endsWith('/detect/version')) {
        return jsonResponse({ name: 'NodeBabyLinkService', peerid: 'peer-1', tun: '', workmode: '' });
      }
      if (url.endsWith('/bind')) {
        return redirectResponse('https://example.com/bind?token=abc');
      }
      return { ok: false, status: 500 };
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.bound, false, 'peerid 有值不代表绑定，/bind 还给链接就是没绑');
});

test('/bind 答话但不给链接时按已绑定算，跟 peerid 有没有值无关', async () => {
  const result = await probe.readStatus({
    platform: 'darwin',
    fetchImpl: async (url) => {
      if (url.endsWith('/detect/version')) {
        return jsonResponse({ name: 'NodeBabyLinkService', peerid: '', tun: '', workmode: '' });
      }
      if (url.endsWith('/bind')) {
        return { ok: true, status: 404, headers: { get: () => null } };
      }
      return { ok: false, status: 500 };
    },
  });
  assert.equal(result.bound, true, '设备端答话却不给链接 = 已绑定，与 peerid 空不空无关');
});

test('/bind 超时或连不上不误判成已绑定', async () => {
  const result = await probe.readStatus({
    platform: 'darwin',
    fetchImpl: async (url) => {
      if (url.endsWith('/detect/version')) {
        return jsonResponse({ name: 'NodeBabyLinkService', peerid: 'peer-1', tun: '', workmode: '' });
      }
      if (url.endsWith('/bind')) {
        throw new Error('connect timeout');
      }
      return { ok: false, status: 500 };
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.bound, false, '超时不是「设备端明确不给链接」，按没绑定算，别把用户卡死');
});
