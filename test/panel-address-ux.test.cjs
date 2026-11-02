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

test('地址按检测出来的那份给标签，配对卡与「网络配置」共用同一个选择器', () => {
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
  for (const name of ['PairingCard.tsx', 'RelayConfigDialog.tsx']) {
    assert.match(read(name), /AddressPicker/, `${name} 必须用共用的地址选择器，别各写一份口径`);
  }
  // 地址只剩「网络配置」一个入口：局域网直连弹窗不再摆选择器，两处都能改迟早对不上。
  assert.ok(
    !read('LanDialog.tsx').includes('AddressPicker'),
    '局域网直连弹窗里又出现了地址选择器：地址归「网络配置」一处改',
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
  // 引导页那份自己渲染地址清单，同样要带上这一份。
  const onboarding = fs.readFileSync(path.join(__dirname, '..', 'React', 'src', 'Onboarding.tsx'), 'utf8');
  assert.match(onboarding, /IPv6 直连/, '引导页的地址清单也要把 IPv6 那份摆出来');
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

test('非 npm 来源仍隐藏安装按钮，但不显示来源提示条', () => {
  const card = read('UpdateCard.tsx');
  assert.match(card, /localSource \? null : \(/, '本地来源仍要隐藏自动更新开关');
  assert.match(card, /localSource \? null : \(\s*<Button variant="primary"/, '本地来源仍要隐藏立即更新按钮');
  assert.ok(!card.includes('这台不是从 npm 装的'), '不再显示非 npm 来源提示条');
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
  // 文案进字典后断键：「点名无头 / 源码同步」那句话现在是 `panel.update.nothingToInstall`
  // （五门语言里都写着 headless / source-synced），这里钉的是「用的就是那条键」。
  assert.match(branch, /panel\.update\.nothingToInstall/, '那句话里必须点名无头 / 源码同步这条路（那台机器上没有市场）');
  // 这一支要像正常卡片那样**报版本**（查更新不需要外壳，那台答得出「线上最新是几」），
  // 而不是铺一个警告框：把「没有故障」说成故障，用户看到的就是一个没必要的大黄框。
  assert.match(branch, /panel\.update\.latestOnline/, '要报「线上最新」，别只剩一句警告');
  assert.ok(!/Alert/.test(branch), '别把这一支铺成警告框');
  assert.ok(!/没有可换代的外壳/.test(branch), '那句「这一版没有可换代的外壳」的标题别再回来');
});

test('网络配置弹窗：两列一屏、两条清单都收进弹窗、局域网开关撤掉、配对策略是开关', () => {
  const dialog = read('RelayConfigDialog.tsx');
  // 公用中转清单从主窗搬进弹窗（入口是「中转地址」标题右侧那颗按钮）：
  // 清单以后会长，摊在主窗里会把版面撑长。
  assert.match(dialog, /onClick=\{\(\) => setRelayPickerOpen\(true\)\}/, '中转地址右侧要有「公用中转」按钮');
  assert.ok(
    dialog.indexOf('setRelayPickerOpen(true)') < dialog.indexOf('PUBLIC_RELAYS.map'),
    '公用中转的清单只能出现在弹窗里，不能又摊回主窗',
  );
  // 局域网地址同样收进弹窗：一台机器可能好几条网卡地址，条数不许影响主窗尺寸。
  assert.match(dialog, /onClick=\{\(\) => setLanPickerOpen\(true\)\}/, '局域网地址要有「选择地址」按钮');
  assert.ok(
    dialog.indexOf('setLanPickerOpen(true)') < dialog.indexOf('<AddressPicker'),
    '地址选择器只能在弹窗里，不能直接摊在主窗',
  );
  // 局域网直连开关已撤（基本能力，不该是开关）；host 那份 lanEnabled 配置不动。
  assert.ok(!/setLanEnabled|checked=\{lanEnabled\}/.test(dialog), '网络配置弹窗里又出现了「局域网直连」开关');
  // 配对策略这颗开关已经搬到「配对与二维码」的「配对策略」那行（2026-11-02）：
  // 同一份配置在两处各摆一颗，用户只会猜「改哪颗才算」。
  assert.ok(!/pairingPolicy/.test(dialog), '网络配置弹窗里又出现配对策略了：它只在配对卡那一处');
  const pairingCard = read('PairingCard.tsx');
  assert.match(pairingCard, /panel\.devices\.allowTitle/, '配对卡的「配对策略」那行要有一颗开关');
  assert.match(pairingCard, /onChangePolicy\(next \? 'code' : 'deny'\)/, '开关要接回同一份 pairingPolicy');
});

test('网络配置弹窗是一屏两列，注册密钥已下线', () => {
  const dialog = read('RelayConfigDialog.tsx');
  // 一屏两列（2026-11-01 用户要求）：宽到两列放得下，内容左右分栏，默认窗口不出滚动条。
  assert.match(dialog, /w-\[min\(1100px,92vw\)\]/, '弹窗宽度要盖掉库默认的 600px（w-150）');
  assert.match(dialog, /grid-cols-2/, '地址那几块要分两列排');
  assert.ok(!/max-h-\[70vh\]/.test(dialog), '别再留原来那圈 70vh 内滚动：正常窗口要一屏排完');
  // 注册密钥下线（用户口径：运营版中转不做了）：这扇窗里不许再有它的输入框。
  assert.ok(!/registerSecret/.test(dialog), '网络配置弹窗里又出现了注册密钥');
  const panel = fs.readFileSync(path.join(__dirname, '..', 'React', 'src', 'lib', 'i18n', 'messages', 'panel.ts'), 'utf8');
  assert.ok(!panel.includes('panel.connection.registerSecret'), '注册密钥那条文案键该跟着一起删');
  // 但它描述的那种中转还在：警告正文不能把人指向一个已经不存在的位置。
  const body = panel.match(/'panel\.connection\.relayNeedsSecretBody': '([^']*)'/);
  assert.ok(body && !body[1].includes('注册密钥 →') && !body[1].includes('Registration secret above'), '警告正文还指着已经删掉的输入框');
});
