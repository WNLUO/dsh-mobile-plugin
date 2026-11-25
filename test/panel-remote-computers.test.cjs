// 2026-11-26 需求变更：按内置地址区分公用中转的分支已撤，线路名只认通道，守卫跟着改。
/** 远程电脑面板：既有错误展示映射真实网络与助手恢复诊断。 */
// 2026-11-25：壳熬过宽限后才崩的，清单带一次性标记；面板取到后补开浏览器，正常关窗不补。
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

// 打开方式改为桌面端优先（已确认的需求变更）：下面的浏览器断言只在桌面端不可用时才成立，
// 因此让 open-shell 统一回 SHELL_UNAVAILABLE，走得到原来的回退路径。
function browserFallbackFetch(handler) {
  return async (url, options) => {
    if (String(url).endsWith('/open-shell')) {
      return json({ ok: false, error: { code: 'SHELL_UNAVAILABLE' } }, 400);
    }
    return handler(url, options);
  };
}

function helpersFrom(source) {
  const code = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^import .*$/gm, '')
    .replace(/\bexport /g, '');
  const context = vm.createContext({ URL, ApiError: Error, t: (key) => key });
  return vm.runInContext(`${code}\n({remoteLease, trustedRemoteUrl})`, context);
}

// 2026-11-17 需求变更：远程电脑从控制台主页抽到独立页（桌面侧边栏电脑图标点开的
// `/api/relay/panel/remote`），主页不再显示这张卡。共用卡本身不动，手机设备卡也不动。
test('共用卡只在远程电脑独立页出现一次，控制台不动入站手机设备卡', () => {
  const home = fs.readFileSync(path.join(SRC, 'Console.tsx'), 'utf8');
  assert.doesNotMatch(home, /RemoteComputersCard/, '主页不再放远程电脑卡');
  // 2026-11-20：控制台不再单独往设备卡传「全部吊销」回调（吊销动作收进设备卡自身）。
  assert.match(home, /<DevicesCard busy=\{busy\} fill \/>/);
  const remote = fs.readFileSync(path.join(SRC, 'Remote.tsx'), 'utf8');
  assert.match(remote, /import \{ RemoteComputersCard \} from '\.\/components\/RemoteComputersCard\.tsx'/);
  assert.equal((remote.match(/<RemoteComputersCard \/>/g) || []).length, 1);
  assert.match(component, /<Card frame="solid"/);
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
  await remoteComputers.openShell('computer-a');
  await remoteComputers.remove('computer-a');
  await remoteComputers.mode('computer-a', 'relay');
  await remoteComputers.revoke('visiting-b');
  const base = '/api/relay/remote-computers';
  assert.deepEqual(calls.map(({ url }) => url), [base, ...['invite', 'add', 'open', 'open-shell', 'remove', 'mode', 'revoke'].map((action) => `${base}/${action}`)]);
  assert.equal(calls[0].method, undefined);
  assert.ok(calls.slice(1).every((call) => call.method === 'POST' && call.headers['content-type'] === 'application/json'));
  assert.deepEqual(calls.slice(1).map(({ body }) => JSON.parse(body)), [
    {}, { invite: 'dshcomputer://v1?data=invite' }, { id: 'computer-a' }, { id: 'computer-a' },
    { id: 'computer-a' }, { id: 'computer-a', mode: 'relay' }, { deviceId: 'visiting-b' },
  ]);
});

test('所有操作按钮实际接线；复制失败仍保留可手动复制的绑定信息', () => {
  for (const action of ['invite', 'add', 'remove', 'mode', 'revoke']) {
    assert.match(component, new RegExp(`remoteComputers\\.${action}\\(`), `${action} 必须有真实调用`);
  }
  // 续期已下沉到宿主后台自动完成；停止访问、检测线路不再有面板按钮（2026-11-15 需求变更）。
  for (const gone of ['renew', 'stop', 'probe']) {
    assert.doesNotMatch(component, new RegExp(`remoteComputers\\.${gone}\\(`), `${gone} 不应再有面板调用`);
  }
  assert.match(component, /openRemoteComputer\(device\.id\)/);
  assert.match(component, /onClick=\{\(\) => open\(device\)\}/);
  assert.match(component, /onClick=\{\(\) => remove\(device\)\}/);
  assert.match(component, /<DesktopIcon \/>/);
  assert.match(component, /<TrashIcon \/>/);
  assert.match(component, /onClick=\{generateInvite\}/);
  assert.match(component, /navigator\.clipboard\.writeText\(invitation\.invite\)/);
  assert.match(component, /catch \{\s+setManualCopy\(true\)/);
  assert.match(component, /<Textarea[^>]*readOnly value=\{invitation\.invite\}/);
  assert.match(component, /event\.target\.select\(\)/);
  assert.match(component, /panel\.remote\.manualCopy/);
  assert.match(component, /disabled=\{dialogBusy \|\| !invitation \|\| inviteExpired\}/);
});

test('每设备一行：窗口连着才算打开，线路位与按钮按设备各管各', () => {
  // 打开态以「桌面窗口还连着」为准：关掉后回到未打开（2026-11-15）。
  assert.match(component, /const opened = device\.attached/);
  assert.match(component, /\{opened \? \(/);
  // busy 用数组按设备键区分：一台在忙不连累别的设备，也不再整张列表一起变灰（2026-11-15）。
  assert.match(component, /const deviceBusy = \(id: string\) => busy\.some\(/);
  assert.match(component, /endsWith\(`:\$\{id\}`\)/);
  // 线路名只按通道取词，不再传地址作第二参。
  assert.match(component, /channelText\(device\.mode\)\} · \{channelText\(device\.channel\)\}/);
  assert.match(component, /aria-label=\{t\('panel\.remote\.open'\)\}/);
  assert.match(component, /aria-label=\{t\('panel\.remote\.remove'\)\}/);
  assert.match(component, /disabled=\{rowBusy/);
  assert.doesNotMatch(component, /disabled=\{disabled\}/);
});

test('租期判定：有效/到期/撤权，面板不再显示剩余时间与临期提示', async () => {
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
  // 续期改由宿主后台按窗口在用自动完成：面板不再画剩余时间、临期提示与手动续期按钮（2026-11-15）。
  assert.doesNotMatch(component, /panel\.remote\.remaining/);
  assert.doesNotMatch(component, /panel\.remote\.expiring/);
  assert.doesNotMatch(component, /lease\.warning/);
  assert.match(component, /const opened = device\.attached/);
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

test('桌面端可用时只调 open-shell，不预开窗口也不导航', async (t) => {
  const { openRemoteComputer } = await load();
  const events = [];
  const calls = [];
  const view = browser(events);
  install(t, 'window', view.window);
  install(t, 'fetch', async (url) => {
    calls.push(url);
    return json({ ok: true, url: 'http://127.0.0.1:49152/#once', expiresAt: 3600_000 });
  });
  const result = await openRemoteComputer('computer-a');
  assert.equal(result.url, 'http://127.0.0.1:49152/#once');
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]), /\/open-shell$/);
  assert.deepEqual(events, []);
});

test('清单里的壳晚崩标记只取窗口已关的那台，补开走同一条浏览器通道', async (t) => {
  const { crashedShellIds, recoverCrashedShell } = await load();
  const list = { ok: true, devices: [
    { id: 'crashed', attached: false, shellCrashed: true },
    { id: 'still-open', attached: true, shellCrashed: true },
    { id: 'normal-close', attached: false },
  ], authorizedComputers: [], serverNow: 100 };
  assert.deepEqual(crashedShellIds(list), ['crashed']);

  const events = [];
  const view = browser(events);
  install(t, 'window', view.window);
  install(t, 'fetch', async () => json({ ok: true, url: 'http://127.0.0.1:49152/#late', expiresAt: 3600_000 }));
  await recoverCrashedShell('crashed');
  assert.deepEqual(events.at(-1), ['navigate', 'http://127.0.0.1:49152/#late']);
});

test('面板轮询接到晚崩标记才补开，不碰可见样式与文案', () => {
  assert.match(component, /crashedShellIds\(next\)/);
  assert.match(component, /recoverCrashedShell\(id\)/);
  assert.match(component, /panel\.remote\.shellFellBack/, '补开沿用既有回退提示，不新增文案');
  assert.doesNotMatch(component, /#[\da-fA-F]{3,8}|style=\{/);
});

test('浏览器点击同步预开，取得入口前不导航，切断 opener 后交给本机代理', async (t) => {
  const { openRemoteComputer } = await load();
  const events = [];
  const view = browser(events);
  let resolve;
  install(t, 'window', view.window);
  install(t, 'fetch', browserFallbackFetch(async () => {
    events.push(['request']);
    return new Promise((done) => { resolve = done; });
  }));
  const pending = openRemoteComputer('computer-a');
  // 桌面端优先多了一次 open-shell 请求，等它回完不可用再观察浏览器回退路径。
  await new Promise((done) => setImmediate(done));
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
  install(t, 'fetch', browserFallbackFetch(async () => { calls++; return json({ ok: true, url: 'https://outside.example/', expiresAt: 3600_000 }); }));
  await assert.rejects(openRemoteComputer('computer-a'));
  assert.deepEqual(events.at(-1), ['close']);
  assert.equal(events.some(([type]) => type === 'navigate'), false);
  globalThis.fetch = browserFallbackFetch(async () => { calls++; return json({ error: 'Denied' }, 403); });
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
  install(t, 'fetch', browserFallbackFetch(async () => json({ ok: true, url: 'http://127.0.0.1:49152/#once', expiresAt: 3600_000 })));
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
  install(t, 'fetch', browserFallbackFetch(async () => json({ ok: true, url: 'http://127.0.0.1:49152/#once', expiresAt: 3600_000 })));
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
  for (const code of ['credentials-unavailable', 'REMOTE_AUTH', 'REMOTE_REVOKED', 'REMOTE_EXPIRED', 'REMOTE_TIMEOUT', 'REMOTE_CONNECT', 'REMOTE_PROXY', 'REMOTE_PROXY_CONFIGURED', 'REMOTE_INTERCEPTED', 'REMOTE_HELPER_RESTARTING', 'REMOTE_INVITATION', 'remote-operation-failed']) {
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
