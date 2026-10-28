'use strict';

/**
 * 连接自检：防火墙只读探测的三平台解析、五档结论的判据，以及缓存。
 *
 * 这里钉的是「哪一档话能说、哪一档不许瞎说」——
 *
 *  1. **读不到就是读不到**：`supported / enabled / allowsApp` 为 `null` 时结论只能是
 *     `unknown`。把「不知道」写成「正常」，正是这次要治的那个「用户只能自己猜」。
 *  2. **手机来过就排在防火墙前面**：人家正用着的时候弹一句「防火墙挡着」比不弹更糟。
 *  3. **Windows 的规则按网络类别生效**：只放行「专用」的老规则遇到被判成「公用」的
 *     新 WiFi 就不再生效 —— 这就是「出去一趟就连不上」的真身，这条顺序不许挪。
 *  4. **缓存只管省进程**：同一份结果给面板弹窗与后台巡检共用，「重新自检」能强制穿过去。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseDarwinState,
  parseDarwinAppAllowed,
  parseWindowsReport,
  windowsRuleApplies,
  decideWindowsAllows,
  probeFirewall,
  readFirewall,
  resetFirewallCache,
} = require('../lib/relay/firewall-probe.js');
const { MOBILE_RECENT_MS, verdictOf, createConnectionCheck } = require('../lib/relay/connection-check.js');

/** 假执行器：按命令行回预置的 stdout，并记下被调了几次。 */
function fakeExec(answers) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...(args || [])].join(' '));
    const key = command;
    const answer = answers[key];
    if (!answer) return { code: 1, stdout: '', stderr: '', error: 'NO_COMMAND' };
    if (answer instanceof Error) throw answer;
    return { code: 0, stdout: answer, stderr: '', error: null };
  };
  return { exec, calls };
}

const SOCKETFILTER = '/usr/libexec/ApplicationFirewall/socketfilterfw';

test('macOS：State = 0 是关，1 与 2 都是开', () => {
  assert.equal(parseDarwinState('Firewall is disabled. (State = 0)'), false);
  assert.equal(parseDarwinState('Firewall is enabled. (State = 1)'), true);
  // 2 = 拦全部非必要入站连接，也是开，只是更狠。
  assert.equal(parseDarwinState('Firewall is set to block all non-essential incoming connections. (State = 2)'), true);
  // 认不出就回 null：别把一句看不懂的话当成「没问题」。
  assert.equal(parseDarwinState('usage: socketfilterfw ...'), null);
  assert.equal(parseDarwinState(''), null);
});

test('macOS：permitted / blocked 两种回答，第三句不算答案', () => {
  assert.equal(parseDarwinAppAllowed('Incoming connection to /opt/homebrew/bin/node is permitted.'), true);
  assert.equal(parseDarwinAppAllowed('Incoming connection to /usr/local/bin/node is blocked.'), false);
  assert.equal(parseDarwinAppAllowed('Incoming connection to /usr/local/bin/node is not allowed.'), false);
  assert.equal(parseDarwinAppAllowed('No such file or directory'), null);
});

test('macOS 探测：防火墙开着并且挡着这个程序', async () => {
  const { exec, calls } = fakeExec({
    [SOCKETFILTER]: 'Firewall is enabled. (State = 1)',
  });
  // 同一个可执行文件要问两条，所以按参数分流。
  const smartExec = async (command, args, options) => {
    const joined = `${command} ${(args || []).join(' ')}`;
    calls.push(joined);
    if (command !== SOCKETFILTER) return { code: 1, stdout: '', stderr: '', error: 'NO_COMMAND' };
    if ((args || [])[0] === '--getglobalstate') {
      return { code: 0, stdout: 'Firewall is enabled. (State = 1)', stderr: '', error: null };
    }
    return { code: 0, stdout: 'Incoming connection to /opt/homebrew/bin/node is blocked.', stderr: '', error: null };
  };
  void exec;
  const result = await probeFirewall({ platform: 'darwin', execPath: '/opt/homebrew/bin/node', exec: smartExec });
  assert.deepEqual(result, {
    supported: true,
    enabled: true,
    allowsApp: false,
    appPath: '/opt/homebrew/bin/node',
    reason: null,
  });
  // 查的必须是宿主进程自己那个可执行文件，不是写死的 node。
  assert.ok(calls.some((call) => call.includes('/opt/homebrew/bin/node')));
});

test('macOS 探测：命令不在（不是 macOS 的路径形态）就如实报查不到', async () => {
  const { exec } = fakeExec({});
  const result = await probeFirewall({ platform: 'darwin', execPath: '/usr/bin/node', exec });
  assert.equal(result.supported, false);
  assert.equal(result.enabled, null);
  assert.equal(result.allowsApp, null);
  assert.equal(result.reason, 'no-command');
});

test('Windows：报告解析收得下数组与单条两种形状', () => {
  const both = parseWindowsReport(JSON.stringify({
    profiles: [{ name: 'Domain', enabled: false }, { name: 'Private', enabled: true }, { name: 'Public', enabled: true }],
    apps: [{ program: 'C:\\Program Files\\nodejs\\node.exe', action: 'Allow', enabled: true, profile: 'Any' }],
    activeProfiles: ['Public'],
  }));
  assert.deepEqual(both.activeProfiles, ['Public']);
  assert.equal(both.profiles.filter((item) => item.enabled).length, 2);
  assert.equal(both.apps.length, 1);

  // 只有一条时 ConvertTo-Json 会把数组退化成一个对象，不认这个形状就会当场崩。
  const single = parseWindowsReport(JSON.stringify({
    profiles: { name: 'Public', enabled: true },
    apps: { program: 'C:\\node.exe', action: 'Block', enabled: true, profile: 'Any' },
    activeProfiles: 'Public',
  }));
  assert.equal(single.profiles.length, 1);
  assert.equal(single.apps.length, 1);
  assert.deepEqual(single.activeProfiles, ['Public']);
});

test('Windows：Any 与逗号串都按交集判，读不到当前类别时不冤枉人', () => {
  assert.equal(windowsRuleApplies('Any', ['Public']), true);
  assert.equal(windowsRuleApplies('', ['Public']), true);
  assert.equal(windowsRuleApplies('Private,Public', ['Public']), true);
  assert.equal(windowsRuleApplies('Domain,Private', ['Public']), false);
  assert.equal(windowsRuleApplies('Private', []), true, '读不到当前类别时按「管」算，宁可漏报也不误报');
});

test('Windows：默认入站全拒，没规则就是被挡；显式 Block 优先', () => {
  const off = decideWindowsAllows({
    profiles: [{ name: 'Public', enabled: false }],
    apps: [],
    activeProfiles: ['Public'],
    appPath: 'C:\\node.exe',
  });
  assert.equal(off, true, '防火墙关着就不挡');

  const noRule = decideWindowsAllows({
    profiles: [{ name: 'Public', enabled: true }],
    apps: [],
    activeProfiles: ['Public'],
    appPath: 'C:\\node.exe',
  });
  assert.equal(noRule, false, '开着却没放行规则 = 第一次弹框点了取消的样子');

  const blocked = decideWindowsAllows({
    profiles: [{ name: 'Public', enabled: true }],
    apps: [{ program: 'C:\\node.exe', action: 'Block', enabled: true, profile: 'Any' }],
    activeProfiles: ['Public'],
    appPath: 'C:\\node.exe',
  });
  assert.equal(blocked, false);
});

test('Windows：放行规则只覆盖「专用网络」时，接到公用网络上就不生效', () => {
  const report = (active, profile) => decideWindowsAllows({
    profiles: [{ name: 'Private', enabled: true }, { name: 'Public', enabled: true }],
    apps: [{ program: 'C:\\Program Files\\nodejs\\node.exe', action: 'Allow', enabled: true, profile }],
    activeProfiles: [active],
    appPath: 'c:\\program files\\nodejs\\node.exe',
  });
  // 路径不分大小写：规则里存的和进程报的不一定同一种写法。
  assert.equal(report('Private', 'Private'), true);
  assert.equal(report('Public', 'Private'), false, '在家能用、出门不能用，就是这一条');
  assert.equal(report('Public', 'Domain,Private,Public'), true);
  assert.equal(report('Public', 'Any'), true);
});

test('Windows 探测：走 PowerShell 拿 JSON，进程路径大写小写都认', async () => {
  const payload = {
    profiles: [{ name: 'Private', enabled: true }],
    apps: [{ program: 'C:\\Program Files\\nodejs\\node.exe', action: 'Allow', enabled: true, profile: 'Any' }],
    activeProfiles: ['Private'],
  };
  const { exec } = fakeExec({ 'powershell.exe': JSON.stringify(payload) });
  const result = await probeFirewall({ platform: 'win32', execPath: 'c:\\program files\\nodejs\\node.exe', exec });
  assert.equal(result.supported, true);
  assert.equal(result.enabled, true);
  assert.equal(result.allowsApp, true);
});

test('Windows 探测：输出不是 JSON 就说解析不了，不说「正常」', async () => {
  const { exec } = fakeExec({ 'powershell.exe': 'Get-NetFirewallProfile : access denied' });
  const result = await probeFirewall({ platform: 'win32', execPath: 'C:\\node.exe', exec });
  assert.equal(result.supported, false);
  assert.equal(result.enabled, null);
  assert.equal(result.reason, 'parse-failed');
});

test('Linux：只读得到「开着没」，放行与否一律是查不到', async () => {
  const running = fakeExec({ 'firewall-cmd': 'running' });
  const one = await probeFirewall({ platform: 'linux', execPath: '/usr/bin/node', exec: running.exec });
  assert.deepEqual(one, { supported: true, enabled: true, allowsApp: null, appPath: '/usr/bin/node', reason: null });

  const stopped = fakeExec({ 'firewall-cmd': 'not running' });
  const two = await probeFirewall({ platform: 'linux', execPath: '/usr/bin/node', exec: stopped.exec });
  assert.equal(two.enabled, false);
  assert.equal(two.allowsApp, null);

  // 规则读取要 root，那条我们不碰 —— 所以 Linux 上「防火墙开着」不等于「被挡」。
  const nothing = fakeExec({});
  const three = await probeFirewall({ platform: 'linux', execPath: '/usr/bin/node', exec: nothing.exec });
  assert.equal(three.supported, false);
  assert.equal(three.reason, 'no-command');
});

test('陌生平台：直接报不支持，不猜', async () => {
  const { exec } = fakeExec({});
  const result = await probeFirewall({ platform: 'freebsd', execPath: '/usr/local/bin/node', exec });
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'unsupported');
});

test('五档结论：先看有没有在听，再看来没来过，最后才轮到防火墙', () => {
  const now = 1_000_000_000;
  const recent = now - 60_000;
  const stale = now - MOBILE_RECENT_MS - 1;

  assert.equal(verdictOf({ listeningState: 'off', firewall: null, lastMobileAt: recent, now }), 'not-listening');
  assert.equal(verdictOf({ listeningState: 'listening', firewall: { supported: true, allowsApp: false }, lastMobileAt: recent, now }), 'ok');
  assert.equal(verdictOf({ listeningState: 'listening', firewall: { supported: true, allowsApp: false }, lastMobileAt: stale, now }), 'firewall-blocked');
  assert.equal(verdictOf({ listeningState: 'listening', firewall: { supported: false, allowsApp: null }, lastMobileAt: 0, now }), 'unknown');
  assert.equal(verdictOf({ listeningState: 'listening', firewall: { supported: true, allowsApp: null }, lastMobileAt: 0, now }), 'unknown');
  assert.equal(verdictOf({ listeningState: 'listening', firewall: { supported: true, allowsApp: true }, lastMobileAt: 0, now }), 'network');
  assert.equal(verdictOf({ listeningState: 'listening', firewall: null, lastMobileAt: 0, now }), 'unknown');
});

test('自检载荷：四行数据与结论对得上，字段缺了也不抛', async () => {
  const now = 2_000_000;
  const check = createConnectionCheck({
    platform: 'darwin',
    now: () => now,
    status: () => ({
      lan: { state: 'listening', port: 18787, adjusted: true },
      tunnel: { state: 'connected' },
      relayUrl: 'https://relay.example.com',
    }),
    lanCandidates: (port) => [{ url: `http://192.168.1.5:${port}` }, { url: '' }],
    mobileActivity: () => ({ lastMobileAt: now - 5 * 60 * 1000 }),
    probeFirewall: async () => ({ supported: true, enabled: true, allowsApp: false, appPath: '/opt/homebrew/bin/node', reason: null }),
  });
  const view = await check.run();
  assert.equal(view.ok, true);
  assert.equal(view.platform, 'darwin');
  // 手机来过就压过防火墙：人家正用着，别报红字。
  assert.equal(view.verdict, 'ok');
  assert.deepEqual(view.listening, {
    state: 'listening',
    port: 18787,
    urls: ['http://192.168.1.5:18787'],
    portAdjusted: true,
  });
  assert.deepEqual(view.tunnel, { state: 'connected', relayUrl: 'https://relay.example.com' });
  assert.equal(view.mobile.idle, false);

  // 宿主状态读不到时如实报 off / 0，不抛。
  const empty = createConnectionCheck({
    platform: 'linux',
    now: () => now,
    status: () => ({}),
    lanCandidates: () => [],
    mobileActivity: () => ({}),
    probeFirewall: async () => { throw new Error('boom'); },
  });
  const bare = await empty.run();
  assert.equal(bare.verdict, 'not-listening');
  assert.equal(bare.firewall, null);
  assert.equal(bare.mobile.lastMobileAt, 0);
  assert.equal(bare.mobile.idle, true);
});

test('缓存：同一平台只探一次，「重新自检」能穿过去', async () => {
  resetFirewallCache();
  let probes = 0;
  const counting = async () => {
    probes += 1;
    return { supported: true, enabled: false, allowsApp: true, appPath: '/usr/bin/node', reason: null };
  };
  resetFirewallCache();
  await readFirewall({ platform: 'linux', exec: counting });
  await readFirewall({ platform: 'linux', exec: counting });
  assert.equal(probes, 1, '弹窗与后台巡检共用同一份结果，不各起一个进程');
  await readFirewall({ platform: 'linux', exec: counting, force: true });
  assert.equal(probes, 2);
  resetFirewallCache();
});
