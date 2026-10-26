'use strict';

/**
 * 守卫：面板上的「已绑定的设备」卡、「允许新设备绑定」开关。
 *
 * 三条约定各有一次「看着没问题、实际在骗人」的失败模式，而且都**不在渲染结果里一眼看得
 * 出来**，所以按源码写法钉住：
 *
 *  1. **没有设备时整卡消失**：摆一张空卡等于告诉用户「这里本来该有东西」。判据必须是
 *     `devices.length === 0` 直接返回 null，不能只把列表渲染成空的。
 *  2. **解除绑定的确认文案必须分两种**：`legacy` 为真的设备名下还有不带设备密钥的旧记录，
 *     单台吊销杀不掉那本旧通行证 —— 对它写「立即失效」就是给了一个做不到的承诺。所以这里
 *     逐字比对两句文案，并防止两句话被合并成一句。
 *  3. **开关只有一份状态**：取值就是 `/api/relay/status` 的 `pairingPolicy`，写回走
 *     `/api/relay/config`。组件里一旦多一个 `useState` 副本，轮询回来就会和宿主的真值各说
 *     各的（点了没反应、或者关上了看着还开着）。
 *
 * 读源码而不是产物（产物是提交物、要重建才更新）：这三条都是**写法**上的约定。文案本身住在
 * 字典里（`lib/i18n/messages/devices.ts`），所以「这句话必须这么说」那一半查字典的中文值，
 * 另一半（用在哪、按哪个字段分叉）查源码。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'React', 'src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

const devices = read('components', 'DevicesCard.tsx');
// 准入开关住在「连接状态」卡里（摆在远程控制上方），不再是单独一张卡 —— 所以这条守卫读的是
// ConnectionCard。
const policy = read('components', 'ConnectionCard.tsx');
const app = read('App.tsx');
const api = read('lib', 'api.ts');
const dict = read('lib', 'i18n', 'messages', 'devices.ts');

/** 取字典里 zh-Hans 那一块的一条值（文案回退的源语言就是它）。 */
function zh(key) {
  const block = dict.slice(dict.indexOf("'zh-Hans': {"));
  const hit = block.match(new RegExp(`'${key.replace(/\./g, '\\.')}': '((?:[^'\\\\]|\\\\.)*)'`));
  return hit ? hit[1].replace(/\\'/g, "'") : null;
}

test('设备卡：没有设备时整卡消失，不是渲染成空列表', () => {
  assert.match(devices, /if \(devices\.length === 0\) return null/, '没有设备时必须整卡返回 null');
  // 判据不能写成「列表为空但卡片还在」：那样用户会看到一张只有标题的空卡。
  assert.ok(
    devices.indexOf('if (devices.length === 0) return null') < devices.indexOf('<Card'),
    '整卡隐藏的判断要在渲染卡片之前',
  );
});

test('设备卡：3 秒一轮，跟页面那份状态同一个节奏', () => {
  assert.match(devices, /window\.setInterval\(tick, 3000\)/, '设备清单要 3 秒轮询一次');
  assert.match(devices, /document\.hidden/, '页面切到后台就别再问宿主');
  assert.match(devices, /\/api\/relay\/devices'/, '设备清单只从这条路由读');
  // 吊销成功后必须立刻重拉，不能等下一轮 3 秒。
  const revoke = devices.slice(devices.indexOf('async function revoke'), devices.indexOf('if (devices.length === 0)'));
  assert.match(revoke, /await load\(\)/, '吊销成功后要立刻重拉设备清单');
  assert.match(revoke, /\/api\/relay\/devices\/revoke'/, '吊销要走那条专用路由');
});

test('设备卡：行的字段与「相对时间」口径', () => {
  assert.match(devices, /serverNow/, '相对时间要拿宿主给的 serverNow 当基准，不能拿浏览器时钟');
  assert.match(devices, /panel\.devices\.unknown/, '名字为空要显示「未知设备」（走字典）');
  assert.equal(zh('panel.devices.unknown'), '未知设备', '字典里「未知设备」这句要还在');
  // 标记是 JSX 文本（不带引号），所以查键 + 字典值。
  assert.match(devices, /device\.legacy \?/, '「旧式」标记要按设备的 legacy 位出现');
  assert.match(devices, /panel\.devices\.legacy/, '「旧式」那个标签要走字典');
  assert.equal(zh('panel.devices.legacy'), '旧式', '字典里「旧式」这个词要还在');
  assert.match(devices, /panel\.devices\.noRecord/, 'lastSeenAt 为 0 要如实说「无记录」');
  assert.equal(zh('panel.devices.noRecord'), '无记录');
  assert.match(devices, /panel\.devices\.online/, '5 分钟内有来过的要显示「在线」');
  assert.equal(zh('panel.devices.online'), '在线');
  assert.match(devices, /5 \* 60 \* 1000/, '「在线」的窗口是 5 分钟');
  // 通道与加密：relay = 经中转、lan = 局域网；encrypted 真 = 加密、假 = 明文。
  assert.match(devices, /channel === 'relay'\) return t\('panel\.devices\.channelRelay'\)/, 'relay 要写「经中转」');
  assert.match(devices, /channel === 'lan'\) return t\('panel\.devices\.channelLan'\)/, 'lan 要写「局域网」');
  assert.equal(zh('panel.devices.channelRelay'), '经中转');
  assert.equal(zh('panel.devices.channelLan'), '局域网');
  assert.match(devices, /encrypted \? t\('panel\.devices\.encrypted'\) : t\('panel\.devices\.plain'\)/, '加密 / 明文按 encrypted 分叉');
  // 2026-10-26 改口：「加密」标的是**这条链路**有没有设备密钥，跟 App 新不新无关 ——
  // 原来写两个字，摆在版本号旁边会被读成「已是最新」。
  assert.equal(zh('panel.devices.encrypted'), '链路已加密');
  assert.equal(zh('panel.devices.plain'), '链路未加密');
  assert.match(devices, /panel\.devices\.boundAt/, '要显示绑定时间');
  // 相对时间只有这四档，别退化成「0 秒前」这种读数。
  assert.equal(zh('panel.devices.justNow'), '刚刚', '一分钟以内写「刚刚」');
  assert.match(zh('panel.devices.minutesAgo'), /\{count\} 分钟前/, '分钟档');
  assert.match(zh('panel.devices.hoursAgo'), /\{count\} 小时前/, '小时档');
  assert.match(zh('panel.devices.daysAgo'), /\{count\} 天前/, '天档');
  assert.match(devices, /panel\.devices\.justNow/, '「刚刚」要走字典');
});

test('解除绑定：legacy 与非 legacy 的确认文案是两句，legacy 不许写「立即失效」', () => {
  // 非 legacy：凭据带设备身份，下一次请求就过不去。
  assert.equal(zh('panel.devices.effectIdentity'), '下次请求起失效。', '非 legacy 的设备要写「下次请求起失效」');
  // legacy：本机这份被吊销了，但旧通行证在到期前仍可用 —— 必须指向「吊销全部」。
  assert.equal(
    zh('panel.devices.effectLegacy'),
    '只吊销凭据，旧的通行证仍可能在到期前可用；要立即失效请用『吊销全部』。',
    'legacy 的确认文案必须逐字说清「旧通行证仍可能在到期前可用」并指向吊销全部',
  );
  // 两句是字典里两个键，按 legacy 分支选，不能被合并成同一句。
  assert.notEqual('panel.devices.effectIdentity', 'panel.devices.effectLegacy');
  assert.match(
    devices,
    /t\(pending\?\.legacy \? 'panel\.devices\.effectLegacy' : 'panel\.devices\.effectIdentity'\)/,
    '文案要按 legacy 分叉到两个不同的键',
  );
  // 防合并：非 legacy 那句里不许出现「立即失效」——那一句说的是「下次请求起」。
  assert.ok(!zh('panel.devices.effectIdentity').includes('立即失效'), '非 legacy 的文案里不该出现「立即失效」');
  // 别的语言也得说清这件事，不能只翻成一句「立即失效」。
  const legacyRows = dict.split('panel.devices.effectLegacy').length - 1;
  assert.ok(legacyRows >= 5, `effectLegacy 只在 ${legacyRows} 门语言里出现，五门都得有`);
});

test('「允许新设备绑定」开关：读 status.pairingPolicy，写 /api/relay/config，没有第二份状态', () => {
  assert.match(policy, /status\.pairingPolicy === 'code'/, '开关取值直接来自 status.pairingPolicy');
  // 取值只有宿主那一份：这颗开关不许自己存一份「允许不允许」。
  assert.ok(!/useState<boolean>\(/.test(policy), '开关里不许有 useState 副本：取值只有宿主那一份');
  assert.match(policy, /onChangePolicy\(next \? 'code' : 'deny'\)/, '勾选映射到 code / deny');

  // 面板一侧：写的是同一份配置，回来的 status 顶掉旧的。
  assert.match(app, /const savePolicy = \(pairingPolicy: PairingPolicy\)/, '面板要有写 pairingPolicy 的入口');
  assert.match(app, /apiPost<StatusView>\('\/api\/relay\/config', \{ pairingPolicy \}\)/, '写回必须走 /api/relay/config');
  assert.match(app, /setStatus\(await apiPost<StatusView>\('\/api\/relay\/config', \{ pairingPolicy \}\)\)/, '写回后要用宿主回的 status 顶掉旧的');
  // 不许再存一份「允许不允许」的状态：那会和轮询回来的 pairingPolicy 各说各的。
  assert.ok(!/useState<boolean>\(.*[Aa]llow/.test(app), '面板上不许再存一份「允许新设备绑定」');
});

test('开关摆在「连接状态」卡里、远程控制上面，且只有一行标签 + 一颗开关', () => {
  // 从「配对卡上面那张独立的卡」搬进右栏「连接状态」，摆在远程控制上方，样式与远程控制那颗
  // 一致 —— 去掉「已允许」徽标，也去掉那两句说明。
  const aside = app.slice(app.indexOf('<aside'), app.indexOf('</aside>'));
  assert.ok(aside.includes('<ConnectionCard'), '连接状态卡必须在右栏里');
  assert.ok(aside.includes('<InboxCard />'), '收件文件卡要挂在连接状态下面（同一栏）');
  assert.ok(
    aside.indexOf('<ConnectionCard') < aside.indexOf('<InboxCard />'),
    '收件文件要排在连接状态下面',
  );
  // 右栏两块不跟随滚动（`lg:sticky` 会让翻页时它们一直钉在视口里）。
  assert.ok(!/sticky/.test(aside), '右栏两块不跟随滚动：aside 上不许挂 sticky');
  assert.ok(!/PairingPolicyCard/.test(app), '那张独立的准入卡已经删了，别再加回来');

  // 左栏顺序：配对 → 插件更新 → 已绑定的设备。
  const order = ['<PairingCard', '<UpdateCard', '<DevicesCard />'].map((tag) => app.indexOf(tag));
  assert.ok(order.every((at) => at > 0), '左栏三块都得渲染出来');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '左栏顺序必须是 配对 → 更新 → 设备');

  // 卡里：准入那颗在远程控制那颗**前面**。
  const allowAt = policy.indexOf('panel.devices.allowTitle');
  const remoteAt = policy.indexOf('panel.connection.remoteControl');
  assert.ok(allowAt > 0 && remoteAt > 0, '两颗开关都要在连接状态卡里');
  assert.ok(allowAt < remoteAt, '准入开关要摆在远程控制上面');

  // 形态只有「一行标签 + 一颗开关」：不许状态徽标、不许说明句。
  for (const gone of [
    'panel.devices.allowOn',
    'panel.devices.allowOff',
    'panel.devices.allowOnHint',
    'panel.devices.allowOffHint',
    'panel.devices.allowOffNote',
  ]) {
    assert.ok(!policy.includes(gone), `${gone} 已经删了：那颗开关就是一行标签 + 一颗开关`);
    assert.equal(zh(gone), null, `字典里也不该再有 ${gone}`);
  }
  const allowRow = policy.slice(
    policy.indexOf('panel.devices.allowTitle') - 300,
    policy.indexOf('panel.connection.remoteControl'),
  );
  assert.ok(!/<Badge/.test(allowRow), '准入那一行不许挂 Badge');

  // 「中转配置」弹窗里那对单选项留着（写同一份配置），别顺手删掉。
  const dialog = read('components', 'RelayConfigDialog.tsx');
  assert.match(dialog, /pairingPolicy/, '中转配置弹窗里的配对策略还在，写的是同一份配置');
});

test('设备类型与接口路径跟宿主契约对齐', () => {
  for (const field of ['deviceId', 'name', 'platform', 'osVersion', 'appVersion', 'boundAt', 'lastSeenAt', 'lastChannel', 'legacy', 'encrypted', 'expiresAt']) {
    assert.match(api, new RegExp(`\\b${field}\\b`), `RelayDevice 少了契约字段 ${field}`);
  }
  assert.match(api, /serverNow: number/, '设备清单的回答要带 serverNow');
  assert.match(api, /revoked: number/, '吊销的回答里有 revoked');
  assert.match(api, /closed: number/, '吊销的回答里有 closed（断开几条已建立的流）');
});
