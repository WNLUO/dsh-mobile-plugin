// 2026-11-26 需求变更：公用中转退役，网络配置不再有内置清单那一栏，守卫跟着改。
// 2026-11-24 用户要求：那一块一律不显示，异常提示也撤掉，这条守卫跟着改。
// 2026-11-24 用户要求：自动更新已够用，手动安装按钮撤掉，这条守卫跟着改。
'use strict';

/**
 * 面板上两处「报过一次就别再回来」的约定。
 *
 *   ① 地址那一行必须按**检测出来的那一份**给标签（局域网 / 公网），而且能就地选「手机优先
 *      用哪条」—— 服务器上只有公网地址，从前一律写「局域网地址」且没有可选项；
 *   ② 宿主明说「装完没法就地换代」时，更新卡不能把用户往插件市场带 —— 无头 / 源码同步部署
 *      那台机器上根本没有市场，它的更新是「同步源码 + 重启宿主服务」。
 *
 * 这里读的是面板源码（不是产物）：产物是提交物、要重建才更新，而这两条约定是**写法**上的，
 * 源码一变就该红。真正渲染出来长什么样由 `React/scripts/ssr-smoke.mjs` 与开发服务器负责看。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPONENTS = path.join(__dirname, '..', 'React', 'src', 'components');
const read = (name) => fs.readFileSync(path.join(COMPONENTS, name), 'utf8');

test('地址按检测出来的那份给标签，2026-11-23 起只在「网络配置」一处选', () => {
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
  // 2026-11-23 需求变更：配对卡上「本地识别地址」那行连同弹窗一起删了，地址只在
  // 「网络配置」这一处看和改。选择器因此只剩一份实现，不用再防两处各写一遍。
  assert.match(read('RelayConfigDialog.tsx'), /AddressPicker/, '网络配置必须用共用的地址选择器');
  // 地址只剩「网络配置」一个入口：端口弹窗只管一个数字，不许再摆选择器。
  assert.ok(
    !read('PortDialog.tsx').includes('AddressPicker'),
    '端口弹窗里又出现了地址选择器：地址归「网络配置」一处改',
  );
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
  // 引导页不再自己渲染地址清单（2026-11-07 起不让用户选地址，见 A3-38）：
  // 它只管把两条路一起打开、把二维码摆出来，选哪条由手机的自动档决定。
  const onboarding = fs.readFileSync(path.join(__dirname, '..', 'React', 'src', 'Onboarding.tsx'), 'utf8');
  assert.ok(
    !/选择地址|currentLanAddress|pickableAddresses|AddressPicker/.test(onboarding),
    '引导页又摆回地址单选了：那一块按用户要求删掉，地址只在主页「网络配置」里改',
  );
  assert.ok(
    !/IPv6 直连/.test(onboarding),
    '引导页的只读地址清单也一起删了：IPv6 候选由手机侧自己择优，不需要在这一页列给人看',
  );
});

test('调试 OTA 的前端入口已经不显示，但后端接口与客户端函数都留着', () => {
  const card = read('UpdateCard.tsx');
  const client = fs.readFileSync(path.join(__dirname, '..', 'React', 'src', 'lib', 'relayUpdate.ts'), 'utf8');
  // 前端那块「本机调试 OTA」不显示了（现在不需要 OTA 了），后端保留。所以这条断言反过来钉：
  // 卡片里一处都不许再有 OTA 的东西。
  for (const gone of [
    'panel.update.otaSection',
    'panel.update.otaCheck',
    'panel.update.otaInstall',
    'panel.update.otaVersion',
    'otaStatus',
    'otaCheck',
    'otaApply',
  ]) {
    assert.ok(!card.includes(gone), `更新卡里又出现了 ${gone}：前端那块已经按用户要求删掉了`);
  }
  // 客户端函数与三条路径必须还在：用户明说「后端不用删」。
  assert.match(client, /export const otaStatus/, '客户端函数留着（后端还在，要恢复只加回 JSX）');
  assert.match(client, /\/api\/relay\/update\/ota\/status/);
  assert.match(client, /\/api\/relay\/update\/ota\/check/);
  assert.match(client, /\/api\/relay\/update\/ota\/apply/);
});

test('手动安装入口已撤，来源提示条也不显示', () => {
  const card = read('UpdateCard.tsx');
  assert.doesNotMatch(card, /localSource/, '不再按安装来源决定按钮给不给');
  assert.doesNotMatch(card, /<Button variant="primary"/, '页面上不再给「立即更新」');
  assert.doesNotMatch(card, /forceHint/, '「强制更新」也一并撤掉');
  assert.ok(!card.includes('这台不是从 npm 装的'), '不再显示非 npm 来源提示条');
});

test('宿主说没法就地换代时，更新卡不许把用户往插件市场带', () => {
  const card = read('UpdateCard.tsx');
  // 判据仍是宿主回的 `available: false`，但按 2026-11-24 用户要求，卡片正文一律不显示。
  assert.match(
    card,
    /setNoShell\(next\.available !== true\)/,
    '宿主回 available:false 仍要记进 noShell，供顶栏按钮的显示判据使用',
  );
  assert.doesNotMatch(card, /panel\.update\.nothingToInstall/, '无头 / 源码同步那句话不再显示');
  assert.doesNotMatch(card, /panel\.update\.noMarketTitle/, '「去设置里更新」的引导不再出现');
  const body = card.slice(card.indexOf('const body = ('));
  assert.doesNotMatch(body, /panel\.update\.runningVersion/, '运行中版本不在卡片正文里');
  assert.doesNotMatch(body, /<p |<Alert|<InfoList/, '卡片正文不铺任何提示');
});

test('网络配置弹窗：两列一屏、局域网开关撤掉、配对策略是开关', () => {
  const dialog = read('RelayConfigDialog.tsx');
  // 自建中转这一栏保留原来的写法；内置清单与它那颗开关都不在界面里。
  assert.match(dialog, /t\('panel\.relay\.selfKind'\)/, '自建中转那一栏还在');
  assert.match(dialog, /patch\.relayUrl\s*=/, '自建中转仍写单条 relayUrl');
  assert.ok(!/PUBLIC_RELAYS|relayPickerOpen|publicRelayDisabled/.test(dialog), '网络配置里没有内置清单与停用开关');
  // 2026-11-22 需求变更：局域网地址直接用栏内下拉（AddressCombo）选，用户要求撤掉多余的
  // 「选择地址」按钮 —— 下拉本来就能选，那颗按钮纯占位。这里反过来钉「不再有那颗按钮」。
  assert.ok(!/panel\.onboarding\.chooseAddress/.test(dialog), '局域网那栏不再有「选择地址」按钮');
  assert.match(dialog, /id="relay-preferred-lan"/, '局域网地址仍走栏内下拉选择');
  // 局域网直连开关已撤（基本能力，不该是开关）；host 那份 lanEnabled 配置不动。
  assert.ok(!/setLanEnabled|checked=\{lanEnabled\}/.test(dialog), '网络配置弹窗里又出现了「局域网直连」开关');
  // 配对策略这颗开关已经搬到「配对与二维码」的「配对策略」那行（2026-11-02）：
  // 同一份配置在两处各摆一颗，用户只会猜「改哪颗才算」。
  assert.ok(!/pairingPolicy/.test(dialog), '网络配置弹窗里又出现配对策略了：它只在配对卡那一处');
  const pairingCard = read('PairingCard.tsx');
  assert.match(pairingCard, /panel\.devices\.allowTitle/, '配对卡的「配对策略」那行要有一颗开关');
  assert.match(pairingCard, /onChangePolicy\(next \? 'code' : 'deny'\)/, '开关要接回同一份 pairingPolicy');
});

test('网络配置弹窗是一屏两列，自建中转能填注册密钥', () => {
  const dialog = read('RelayConfigDialog.tsx');
  // 2026-11-22 需求变更：网络配置从弹窗改成独立一页，不再用固定弹窗宽度；宽够时仍分两列。
  assert.ok(!/w-\[min\(1100px,92vw\)\]/.test(dialog), '改成整页后不再用固定弹窗宽度');
  assert.match(dialog, /grid-cols-2/, '地址那几块要分两列排');
  assert.ok(!/max-h-\[70vh\]/.test(dialog), '别再留原来那圈 70vh 内滚动：正常窗口要一屏排完');
  // 2026-11-28 需求变更（用户要求）：自建中转的用户需要填注册密钥，之前「运营版中转不做了、
  // 密钥下线」的口径作废。密钥在地址框的「注册密钥」文字按钮弹窗里填，留空=不改动。
  assert.match(dialog, /panel\.relay\.registerSecret/, '自建中转那栏要有注册密钥入口');
  assert.match(dialog, /endSlot=\{[\s\S]{0,700}panel\.relay\.registerSecret/, '入口是地址框里的文字按钮');
  assert.match(dialog, /registerSecretDialogOpen/, '点按钮弹出填写密钥的弹窗');
  assert.match(dialog, /if \(registerSecretDraft !== ''\) onSave\(\{ registerSecret: registerSecretDraft \}\)/, '留空不改密钥：只有填了才落盘');
  const panel = fs.readFileSync(path.join(__dirname, '..', 'React', 'src', 'lib', 'i18n', 'messages', 'panel.ts'), 'utf8');
  assert.ok(panel.includes("'panel.relay.registerSecret':"), '注册密钥的文案键要在字典里');
  // 准入被拒的提示要把人指向那个真实存在的输入框，而不是说「面板已不再提供填写入口」。
  const body = panel.match(/'panel\.connection\.relayNeedsSecretBody': '([^']*)'/);
  assert.ok(body && body[1].includes('自建中转'), '警告正文没指向自建中转那栏的密钥输入框');
  assert.ok(!/不再提供填写入口|no longer has a field/.test(body?.[1] || ''), '警告正文还说面板没有填写入口');
});
