'use strict';

/**
 * 守卫：面板上的「已绑定的设备」卡、「允许新设备绑定」开关。
 *
 * 这三条约定各自都有一次「看着没问题、实际在骗人」的失败模式，而且都**不在渲染结果里
 * 一眼看得出来**，所以按源码写法钉住：
 *
 *  1. **没有设备时整卡消失**：摆一张空卡等于告诉用户「这里本来该有东西」，与「这台机器
 *     还没放任何手机进来」不是一句话。判据必须是 `devices.length === 0` 直接返回 null，
 *     不能只把列表渲染成空的。
 *  2. **解除绑定的确认文案必须分两种**：`legacy` 为真的设备名下还有不带设备密钥的旧记录，
 *     单台吊销杀不掉那本旧通行证 —— 对它写「立即失效」就是给了一个做不到的承诺。这一条
 *     是硬要求，所以这里逐字比对两句文案，并防止两句话被合并成一句。
 *  3. **开关只有一份状态**：`允许新设备绑定` 的取值就是 `/api/relay/status` 的
 *     `pairingPolicy`，写回走 `/api/relay/config`。组件里一旦多一个 `useState` 副本，
 *     轮询回来就会和宿主的真值各说各的（点了没反应、或者关上了看着还开着）。
 *
 * 读源码而不是产物：产物是提交物、要重建才更新（见 `panel-artifact.test.cjs` 的文件头），
 * 而这三条都是**写法**上的约定，源码一变就该红。文案本身住在字典里（`lib/i18n/messages/
 * devices.ts`），所以「这句话必须这么说」那一半查字典的中文值，另一半（用在哪、按哪个
 * 字段分叉）查源码。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'React', 'src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

const devices = read('components', 'DevicesCard.tsx');
const policy = read('components', 'PairingPolicyCard.tsx');
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
  assert.equal(zh('panel.devices.encrypted'), '加密');
  assert.equal(zh('panel.devices.plain'), '明文');
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
  assert.ok(!/useState/.test(policy), '开关组件里不许有 useState 副本：取值只有宿主那一份');
  // 注释里也提到了那个 React 钩子，所以上面那条改成按 import 判：只要不真的引进来就成立。
  assert.ok(!/from 'react'/.test(policy), '开关组件不许从 react 引状态钩子');
  assert.match(policy, /onChange\(next \? 'code' : 'deny'\)/, '勾选映射到 code / deny');

  // 面板一侧：写的是同一份配置，回来的 status 顶掉旧的。
  assert.match(app, /const savePolicy = \(pairingPolicy: PairingPolicy\)/, '面板要有写 pairingPolicy 的入口');
  assert.match(app, /apiPost<StatusView>\('\/api\/relay\/config', \{ pairingPolicy \}\)/, '写回必须走 /api/relay/config');
  assert.match(app, /setStatus\(await apiPost<StatusView>\('\/api\/relay\/config', \{ pairingPolicy \}\)\)/, '写回后要用宿主回的 status 顶掉旧的');
  // 不许再存一份「允许不允许」的状态：那会和轮询回来的 pairingPolicy 各说各的。
  assert.ok(!/useState<boolean>\(.*[Aa]llow/.test(app), '面板上不许再存一份「允许新设备绑定」');
});

test('开关摆在面板上：在左栏配对卡上面，关掉时旁边那句提示在', () => {
  assert.match(app, /<PairingPolicyCard status=\{status\}/, '面板必须直接渲染这个开关（不是只在弹窗里）');
  assert.ok(
    app.indexOf('<PairingPolicyCard') < app.indexOf('<PairingCard'),
    '开关要摆在配对卡上面 —— 它决定的是「还收不收新手机」',
  );
  assert.ok(
    app.indexOf('<DevicesCard />') > app.indexOf('<PairingCard'),
    '设备卡要挂在配对卡下面',
  );
  // 关掉时旁边那一句（用户点名的原话，住在字典里）。
  assert.equal(
    zh('panel.devices.allowOffNote'),
    '关掉后这台电脑不收新设备，已绑定的手机照常用',
    '关掉时要有那句提示',
  );
  assert.match(policy, /panel\.devices\.allowOffNote/, '那句话要从字典取');
  assert.ok(
    /!allowed \? \(/.test(policy),
    '那句话只在关掉时出现：开着的时候它不成立',
  );
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
