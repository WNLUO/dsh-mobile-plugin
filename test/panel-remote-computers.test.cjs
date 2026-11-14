/** 远程电脑面板：API 接线、单次浏览器入口、租期边界及入站电脑独立撤权。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { stripTypeScriptTypes } = require('node:module');

const SRC = path.join(__dirname, '..', 'React', 'src');
const libPath = path.join(SRC, 'lib', 'remote-computers.ts');
const library = fs.readFileSync(libPath, 'utf8');
const component = fs.readFileSync(path.join(SRC, 'components', 'RemoteComputersCard.tsx'), 'utf8');
const dictionary = fs.readFileSync(path.join(SRC, 'lib', 'i18n', 'messages', 'remote-computers.ts'), 'utf8');
const load = () => import(pathToFileURL(libPath).href);

function install(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}

function browser(events, { blocked = false, protocol = 'http:' } = {}) {
  const target = {
    opener: {},
    location: { replace(url) { events.push(['navigate', url]); } },
    close() { events.push(['close']); },
  };
  const win = {
    location: { protocol, origin: protocol === 'dsh-app:' ? 'dsh-app://app' : 'http://127.0.0.1:8000', href: 'http://127.0.0.1:8000/api/relay/panel' },
    open(...args) {
      events.push(['open', ...args]);
      return blocked ? null : target;
    },
  };
  win.top = win;
  return { target, window: win };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function helpersFrom(source) {
  const code = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^import .*$/gm, '')
    .replace(/\bexport /g, '');
  const context = vm.createContext({ URL, ApiError: Error, t: (key) => key });
  return vm.runInContext(`${code}\n({remoteLease, trustedRemoteUrl})`, context);
}

test('控制台和网页面板各接一份共用卡，不改入站手机设备卡', () => {
  for (const page of ['App.tsx', 'Console.tsx']) {
    const text = fs.readFileSync(path.join(SRC, page), 'utf8');
    assert.match(text, /import \{ RemoteComputersCard \} from '\.\/components\/RemoteComputersCard\.tsx'/);
    assert.equal((text.match(/<RemoteComputersCard \/>/g) || []).length, 1);
    assert.match(text, /<DevicesCard onRevokeAll=\{revokeAll\} busy=\{busy\} \/>/);
  }
  assert.match(component, /<Card frame="solid">/);
  assert.doesNotMatch(component, /#[\da-fA-F]{3,8}|style=\{/);
  assert.doesNotMatch(component, /\/api\/relay\/devices/);
});

test('每个 API 都使用既有客户端，路径、方法与参数对齐服务端', async (t) => {
  const { remoteComputers } = await load();
  const calls = [];
  const reply = { ok: true, devices: [], authorizedComputers: [], serverNow: 1000 };
  install(t, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    return json(reply);
  });
  assert.deepEqual(await remoteComputers.list(), reply);
  await remoteComputers.invite();
  await remoteComputers.add('dshcomputer://v1?data=invite');
  await remoteComputers.open('computer-a');
  await remoteComputers.renew('computer-a');
  await remoteComputers.stop('computer-a');
  await remoteComputers.remove('computer-a');
  await remoteComputers.mode('computer-a', 'relay');
  await remoteComputers.probe('computer-a');
  await remoteComputers.revoke('visiting-b');
  const base = '/api/relay/remote-computers';
  assert.deepEqual(calls.map(({ url }) => url), [base, ...['invite', 'add', 'open', 'renew', 'stop', 'remove', 'mode', 'probe', 'revoke'].map((action) => `${base}/${action}`)]);
  assert.equal(calls[0].method, undefined);
  assert.ok(calls.slice(1).every((call) => call.method === 'POST' && call.headers['content-type'] === 'application/json'));
  assert.deepEqual(calls.slice(1).map(({ body }) => JSON.parse(body)), [
    {}, { invite: 'dshcomputer://v1?data=invite' }, { id: 'computer-a' }, { id: 'computer-a' },
    { id: 'computer-a' }, { id: 'computer-a' }, { id: 'computer-a', mode: 'relay' },
    { id: 'computer-a' }, { deviceId: 'visiting-b' },
  ]);
});

test('所有操作按钮实际接线；复制失败仍保留可手动复制的绑定信息', () => {
  for (const action of ['invite', 'add', 'renew', 'stop', 'remove', 'mode', 'probe', 'revoke']) {
    assert.match(component, new RegExp(`remoteComputers\\.${action}\\(`), `${action} 必须有真实调用`);
  }
  assert.match(component, /openRemoteComputer\(device\.id\)/);
  for (const action of ['open', 'renew', 'remove']) {
    assert.match(component, new RegExp(`onClick=\\{\\(\\) => ${action}\\(device\\)\\}`));
  }
  assert.match(component, /onClick=\{generateInvite\}/);
  assert.match(component, /navigator\.clipboard\.writeText\(invitation\.invite\)/);
  assert.match(component, /catch \{\s+setManualCopy\(true\)/);
  assert.match(component, /<Textarea[^>]*readOnly value=\{invitation\.invite\}/);
  assert.match(component, /event\.target\.select\(\)/);
  assert.match(component, /panel\.remote\.manualCopy/);
  assert.match(component, /disabled=\{disabled \|\| !invitation \|\| inviteExpired\}/);
});

test('一小时访问：临期五分钟提示，已到期与撤权状态不能续期', async () => {
  const { remoteLease, REMOTE_LEASE_WARNING_MS } = await load();
  const now = 100_000;
  assert.equal(REMOTE_LEASE_WARNING_MS, 5 * 60_000);
  assert.deepEqual(remoteLease({ state: 'connected', expiresAt: now + 3600_000 }, now), { active: true, remainingMs: 3600_000, warning: false });
  assert.equal(remoteLease({ state: 'connected', expiresAt: now + 300_000 }, now).warning, true);
  assert.equal(remoteLease({ state: 'connected', expiresAt: now + 300_001 }, now).warning, false);
  assert.deepEqual(remoteLease({ state: 'connected', expiresAt: now }, now), { active: false, remainingMs: 0, warning: false });
  assert.equal(remoteLease({ state: 'expired', expiresAt: now + 3600_000 }, now).active, false);
  assert.equal(remoteLease({ state: 'revoked', expiresAt: now + 3600_000 }, now).active, false);
  assert.equal(remoteLease({ state: 'idle', expiresAt: 0 }, now).active, false);
  assert.deepEqual(remoteLease({ state: 'idle', expiresAt: null }, now), { active: false, remainingMs: 0, warning: false });
  assert.match(component, /if \(!remoteLease\(device, Date\.now\(\) \+ clockOffset\.current\)\.active\) return/);
  assert.match(component, /\{lease\.active \? \([\s\S]*?onClick=\{\(\) => renew\(device\)\}/);
  assert.match(component, /lease\.warning \? <p role="status"/);
  assert.match(component, /expired \? 'panel\.remote\.reopen' : 'panel\.remote\.open'/);
  assert.match(component, /next\.serverNow - Date\.now\(\)/);
});

test('手动线路只来自已有候选；隐藏面板不轮询，不看浏览器在线状态', async () => {
  const { remoteModes } = await load();
  assert.deepEqual(remoteModes([{ url: 'http://a', channel: 'lan' }, { url: 'http://b', channel: 'lan' }, { url: 'https://c', channel: 'relay' }]), ['auto', 'lan', 'relay']);
  assert.deepEqual(remoteModes([]), ['auto']);
  assert.match(component, /remoteModes\(modeDevice\?\.routes \?\? \[\]\)/);
  assert.match(component, /tunnel: 'tailcat'/);
  assert.match(component, /if \(!channel\) return t\('panel\.common\.none'\)/);
  assert.match(component, /if \(!pageVisible\(\)\) return/);
  assert.match(component, /window\.setInterval\(tick, 3000\)/);
  assert.match(component, /window\.clearInterval\(timer\)/);
  assert.match(component, /removeEventListener\('visibilitychange', tick\)/);
  assert.doesNotMatch(component, /navigator\.onLine|addEventListener\(['"](?:online|offline)['"]/);
});

test('本机限制只影响远程电脑卡；来访电脑按独立设备标识撤权', () => {
  assert.match(component, /error instanceof ApiError && error\.status === 403/);
  assert.match(component, /localOnly \? <p[\s\S]*?panel\.remote\.localOnly/);
  assert.match(component, /authorizedComputers\.length > 0 \? \(/);
  assert.match(component, /remoteComputers\.revoke\(computer\.deviceId\)/);
  assert.match(component, /window\.confirm\(t\('panel\.remote\.revokeConfirm'/);
  assert.doesNotMatch(component, /updateDevicePermission|tierOfPermissions/);
});

test('只接受带端口的 HTTP 127.0.0.1 入口，保留一次性凭据', async () => {
  const { trustedRemoteUrl } = await load();
  const local = 'http://127.0.0.1:49152/#once-only';
  assert.equal(trustedRemoteUrl(local), local);
  for (const url of ['https://127.0.0.1:49152/', 'http://localhost:49152/', 'http://127.0.0.1.evil:49152/', 'http://192.168.1.2:49152/', 'http://127.0.0.1/', 'http://user:password@127.0.0.1:49152/', 'javascript:alert(1)', '/relative']) {
    assert.throws(() => trustedRemoteUrl(url), Error, url);
  }
});

test('浏览器点击同步预开，取得入口前不导航，切断 opener 后交给本机代理', async (t) => {
  const { openRemoteComputer } = await load();
  const events = [];
  const view = browser(events);
  let resolve;
  install(t, 'window', view.window);
  install(t, 'fetch', async () => {
    events.push(['request']);
    return new Promise((done) => { resolve = done; });
  });
  const pending = openRemoteComputer('computer-a');
  assert.deepEqual(events, [['open', 'about:blank', '_blank'], ['request']]);
  assert.equal(view.target.opener, null);
  resolve(json({ ok: true, url: 'http://127.0.0.1:49152/#once', expiresAt: 3600_000 }));
  await pending;
  assert.deepEqual(events.at(-1), ['navigate', 'http://127.0.0.1:49152/#once']);
});

test('打开失败或返回外部地址时关闭空白窗口；弹窗被拦不发打开请求', async (t) => {
  const { openRemoteComputer } = await load();
  const events = [];
  let calls = 0;
  const view = browser(events);
  install(t, 'window', view.window);
  install(t, 'fetch', async () => { calls++; return json({ ok: true, url: 'https://outside.example/', expiresAt: 3600_000 }); });
  await assert.rejects(openRemoteComputer('computer-a'));
  assert.deepEqual(events.at(-1), ['close']);
  assert.equal(events.some(([type]) => type === 'navigate'), false);
  globalThis.fetch = async () => { calls++; return json({ error: 'Denied' }, 403); };
  await assert.rejects(openRemoteComputer('computer-a'));
  assert.equal(events.filter(([type]) => type === 'close').length, 2);
  globalThis.window = browser(events, { blocked: true }).window;
  await assert.rejects(openRemoteComputer('computer-a'));
  assert.equal(calls, 2);
});

test('桌面壳沿用导航到系统浏览器的方式，无需 about:blank 窗口', async (t) => {
  const { openRemoteComputer } = await load();
  const events = [];
  const view = browser(events, { protocol: 'dsh-app:' });
  install(t, 'window', view.window);
  install(t, 'fetch', async () => json({ ok: true, url: 'http://127.0.0.1:49152/#once', expiresAt: 3600_000 }));
  await openRemoteComputer('computer-a');
  assert.equal(view.window.location.href, 'http://127.0.0.1:49152/#once');
  assert.deepEqual(events, []);
});

test('桌面壳内嵌控制台只导航同源顶层，跨源或不可访问顶层时明确失败', async (t) => {
  const { openRemoteComputer } = await load();
  const events = [];
  const view = browser(events, { protocol: 'dsh-app:' });
  const top = { location: { origin: 'dsh-app://app', href: 'dsh-app://app/' } };
  view.window.top = top;
  install(t, 'window', view.window);
  install(t, 'fetch', async () => json({ ok: true, url: 'http://127.0.0.1:49152/#once', expiresAt: 3600_000 }));
  await openRemoteComputer('computer-a');
  assert.equal(top.location.href, 'http://127.0.0.1:49152/#once');
  assert.equal(view.window.location.href, 'http://127.0.0.1:8000/api/relay/panel');
  view.window.top = { location: { origin: 'https://other.example', href: 'https://other.example/' } };
  await assert.rejects(openRemoteComputer('computer-a'));
  assert.equal(view.window.location.href, 'http://127.0.0.1:8000/api/relay/panel');
  Object.defineProperty(view.window, 'top', { configurable: true, get() { throw new Error('blocked top'); } });
  await assert.rejects(openRemoteComputer('computer-a'));
  assert.deepEqual(events, []);
});

test('新增文案纳入十种语言，每条状态与动态通道键可取到', async () => {
  const { MESSAGES, PANEL_LANGUAGES } = await import(pathToFileURL(path.join(SRC, 'lib', 'i18n', 'index.ts')).href);
  const keys = [...new Set([...dictionary.matchAll(/'(panel\.remote\.[\w.]+)':/g)].map((match) => match[1]))];
  for (const language of PANEL_LANGUAGES) {
    for (const key of keys) assert.ok(MESSAGES[language][key], `${language} ${key}`);
  }
  for (const state of ['idle', 'connecting', 'connected', 'offline', 'expired', 'revoked']) {
    assert.ok(MESSAGES.en[`panel.remote.state.${state}`]);
  }
});

test('远程错误按code翻译，未知与行错误不透传服务端中文', async () => {
  const { remoteErrorText } = await load();
  const { ApiError } = await import(pathToFileURL(path.join(SRC, 'lib', 'api.ts')).href);
  const { setPanelLanguagePreference } = await import(pathToFileURL(path.join(SRC, 'lib', 'i18n', 'index.ts')).href);
  setPanelLanguagePreference('en');
  for (const code of ['credentials-unavailable', 'REMOTE_AUTH', 'REMOTE_REVOKED', 'REMOTE_EXPIRED', 'REMOTE_TIMEOUT', 'REMOTE_CONNECT', 'REMOTE_INVITATION', 'remote-operation-failed']) {
    const text = remoteErrorText(new ApiError('服务端中文不透出', code, 500));
    assert.ok(text && !/[\u4e00-\u9fff]/.test(text));
    assert.doesNotMatch(text, /panel\.remote\./);
  }
  assert.equal(remoteErrorText(new Error('服务器报错')), remoteErrorText('unknown-code'));
  assert.match(component, /remoteErrorText\(device\.lastErrorCode\)/);
  assert.doesNotMatch(component, /errorText\(error\)|\{device\.lastError\}/);
});

test('变异证明：放开过期续期或外部地址会破坏边界断言', () => {
  const assertExpired = (helpers) => assert.equal(helpers.remoteLease({ state: 'connected', expiresAt: 1000 }, 1000).active, false);
  const assertLocal = (helpers) => assert.throws(() => helpers.trustedRemoteUrl('http://outside.example:49152/'));
  const original = helpersFrom(library);
  assertExpired(original);
  assertLocal(original);
  assert.throws(() => assertExpired(helpersFrom(library.replace('remainingMs > 0 && ', ''))), assert.AssertionError);
  assert.throws(() => assertLocal(helpersFrom(library.replace("url.hostname !== '127.0.0.1' || ", ''))), assert.AssertionError);
});
