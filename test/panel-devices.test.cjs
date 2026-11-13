'use strict';

/**
 * 守卫：面板上的「已绑定的设备」卡、「允许新设备绑定」开关。
 *
 * 三条约定各有一次「看着没问题、实际在骗人」的失败模式，而且都**不在渲染结果里一眼看得
 * 出来**，所以按源码写法钉住：
 *
 *  1. **没有设备时整卡消失**：摆一张空卡等于告诉用户「这里本来该有东西」。判据是
 *     `devices.length === 0 && revokedCount === 0` 才返回 null —— 只看活设备会让「踢掉最后
 *     一台手机」之后整卡消失，而那条解绑记录正是这张卡要回答的事。
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
// 准入开关住在「配对与二维码」卡的「配对策略」那一行（2026-11-02 从「连接状态」与「网络配置」
// 两处合并过来）—— 所以这条守卫读的是 PairingCard。
const policy = read('components', 'PairingCard.tsx');
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
  // 2026-11-12 决策变了：判据从「没有活设备」改成「活设备与历史同时为空」。
  // 理由是「我上周从一台陌生设备上撤过权」正需要这张卡回答，而那时活设备恰好是零台；
  // 照旧判据整张卡会消失，这个功能最核心的场景反而看不见。
  assert.match(
    devices,
    /if \(devices\.length === 0 && revokedCount === 0\) return null/,
    '活设备与历史都为空时才整卡返回 null；只看活设备会让「踢掉最后一台之后」看不到记录',
  );
  // 判据不能写成「列表为空但卡片还在」：那样用户会看到一张只有标题的空卡。
  assert.ok(
    devices.indexOf('if (devices.length === 0 && revokedCount === 0) return null') < devices.indexOf('<Card'),
    '整卡隐藏的判断要在渲染卡片之前',
  );
});

test('设备卡：3 秒一轮，跟页面那份状态同一个节奏', () => {
  assert.match(devices, /window\.setInterval\(tick, 3000\)/, '设备清单要 3 秒轮询一次');
  // 2026-11-13 决策变了：面板被嵌在桌面那一窗里、收起时不销毁（见 React/src/lib/embed-visibility.ts），
  // 「看不看得见」除了 document.hidden 还要看父窗口有没有收起来，所以页面里判可见性统一问 pageVisible()。
  // 那条判据内部仍然看 document.hidden —— 切后台照样停轮询，只是入口收成一份。
  assert.match(devices, /!pageVisible\(\)/, '页面切到后台 / 被父窗口收起时别再问宿主');
  assert.match(devices, /from '\.\.\/lib\/embed-visibility(\.ts)?'/, '可见性判据只走 embed-visibility 那一份');
  assert.match(devices, /\/api\/relay\/devices'/, '设备清单只从这条路由读');
  // 吊销成功后必须立刻重拉，不能等下一轮 3 秒。
  const revoke = devices.slice(devices.indexOf('async function revoke'), devices.indexOf('if (devices.length === 0'));
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
  // 设备行改版（2026-11-13，用户嫌挤）：绑定时间从活设备那两行里撤掉，只在「历史」里留。
  // 判据反过来钉：活设备行**不许**再有 `boundAt`，而历史那一段必须还有。
  assert.equal(
    devices.slice(0, devices.indexOf('historyTitle')).includes('panel.devices.boundAt'),
    false,
    '活设备行不再摆绑定时间（太挤）；历史里那份留着',
  );
  assert.match(devices, /panel\.devices\.historyBoundAt/, '历史那一段仍要写首次绑定时间');
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

test('准入开关只留在配对卡的「配对策略」那行，一行标签 + 一颗开关', () => {
  // 原来它一屏有两颗（连接状态里一颗、网络配置弹窗里一颗），改哪颗才算得猜；现在只留一处。
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
  const order = ['<PairingCard', '<UpdateCard', '<DevicesCard'].map((tag) => app.indexOf(tag));
  assert.ok(order.every((at) => at > 0), '左栏三块都得渲染出来');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '左栏顺序必须是 配对 → 更新 → 设备');

  // 连接状态卡里只剩「远程控制」一颗：准入开关别在两处各摆一份。
  const connection = read('components', 'ConnectionCard.tsx');
  assert.match(connection, /panel\.connection\.remoteControl/, '远程控制那颗还在连接状态卡里');
  assert.ok(!connection.includes('panel.devices.allowTitle'), '连接状态卡里不许再摆准入开关：它只在配对卡那一处');
  // 配对卡里：它挂在「配对策略」那一行的值上。
  assert.match(policy, /label=\{t\('panel\.pairing\.policy'\)\}/, '准入开关要挂在「配对策略」这一行');

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

  // 网络配置弹窗里那颗撤了（同一份配置，写它等于同一个开关摆两处）。
  const dialog = read('components', 'RelayConfigDialog.tsx');
  assert.ok(!dialog.includes('pairingPolicy'), '网络配置弹窗里又出现配对策略了：它只在配对卡那一处');
});

test('设备类型与接口路径跟宿主契约对齐', () => {
  for (const field of ['deviceId', 'name', 'model', 'platform', 'osVersion', 'appVersion', 'boundAt', 'lastSeenAt', 'lastChannel', 'bindings', 'suffix', 'legacy', 'encrypted', 'expiresAt']) {
    assert.match(api, new RegExp(`\\b${field}\\b`), `RelayDevice 少了契约字段 ${field}`);
  }
  assert.match(api, /serverNow: number/, '设备清单的回答要带 serverNow');
  assert.match(api, /revoked: number/, '吊销的回答里有 revoked');
  assert.match(api, /closed: number/, '吊销的回答里有 closed（断开几条已建立的流）');
});

test('撞名靠序号，不靠机器号尾数；机型与旧绑定条数都要摆出来', () => {
  // 标题回退：机型（手机自己报的）→ 名字（历史来源很乱，见 DevicesCard 的注释）→「未知设备」。
  assert.match(
    devices,
    /device\?\.model \|\| device\?\.name \|\| t\('panel\.devices\.unknown'\)/,
    '标题要按 机型 → 名字 → 未知设备 的顺序取',
  );
  assert.match(devices, /device\?\.suffix \?/, '宿主给了序号才拼「· N」');
  assert.ok(!/slice\(-\d\)/.test(devices), '不许再把 deviceId 后几位拼进名字：那串机器号人认不出来，也没法和手上的手机对上');
  // 标题已经占了机型那一格，第二行只报平台 / 系统 / App 版本，不重复。
  assert.ok(!/device\.name && device\.model/.test(devices), '第二行不再重复标题那格');
  // 同一台手机重配过几次 → 名下好几枚活凭据，要把多出来的条数说出来。
  assert.match(devices, /device\.bindings > 1/, '多家绑定要按 bindings 判');
  assert.match(devices, /panel\.devices\.extraBindings/, '旧绑定那条提示要走字典');
  assert.equal(zh('panel.devices.extraBindings'), '另有 {count} 条旧绑定');
  const rows = dict.split('panel.devices.extraBindings').length - 1;
  assert.ok(rows >= 5, `旧绑定那句只在 ${rows} 门语言里出现，五门都得有`);
});

test('历史 · 已解绑：收起零请求，展开只打一次 ?history=1，不另挂 interval', () => {
  // 这一段是偶发的一问，不是每秒都在变的数据。收起时连一个请求都不该发出去。
  assert.match(devices, /if \(!historyOpen\) return/, '收起时那个 effect 要直接返回，不发请求');
  assert.match(
    devices,
    /apiGet<DeviceHistoryList>\('\/api\/relay\/devices\?history=1'\)/,
    '展开时打的是同一路径的 history=1 分支（宿主没新开路由）',
  );
  // 取数只由 historyOpen 触发：依赖数组里多一个东西就等于跟着轮询重拉。
  const effect = devices.slice(
    devices.indexOf('展开才取一次'),
    devices.indexOf('function endingText'),
  );
  assert.match(effect, /\}, \[historyOpen, loadHistory\]\)/, '这一发的依赖只有展开状态与取数函数，别跟着 3 秒轮询重拉');
  assert.ok(!/setInterval/.test(effect), '历史那一块不许再挂一个 interval');
  // 请求次数：源码里只有一处真的去取它（注释里提到不算）。
  assert.equal((devices.match(/apiGet<DeviceHistoryList>/g) ?? []).length, 1, '?history=1 只该有一个调用点');
  // 吊销成功后要补一发：展开着的时候台数已经变了，列表还停在打开那一刻那份就会「写 1 台、下面空着」。
  const revokePath = devices.slice(devices.indexOf('async function revoke'), devices.indexOf('if (devices.length === 0'));
  assert.match(revokePath, /if \(historyOpen\) void loadHistory\(\)/, '展开中吊销成功要重拉历史');

  // 「吊销全部」走 App，本卡片只有 3 秒轮询能看见台数变了：那一发也要补，否则折叠行写着新台数、
  // 摊开还是老几行，一直到用户自己收起再展开。
  const polled = devices.slice(devices.indexOf('const load = useCallback'), devices.indexOf('const devices = list'));
  assert.match(polled, /revokedCountRef/, '轮询要拿上一发看到的台数来比对');
  assert.match(
    polled,
    /if \(changed && historyOpenRef\.current\) void loadHistory\(\)/,
    '台数变了且展开着，轮询这一发要补一次历史',
  );
  // 只在真变了时补：相同就不补，否则每 3 秒白打一发。
  assert.match(polled, /revokedCountRef\.current !== nextCount/, '台数相同不许补发');
  // 关键：轮询那条 effect 的依赖里不许出现 historyOpen —— 那会每展开 / 收起一次就重建轮询、重起 interval。
  const pollEffect = devices.slice(devices.indexOf('window.setInterval(tick, 3000)'), devices.indexOf('const devices = list'));
  assert.match(pollEffect, /\}, \[load\]\)/, '轮询 effect 只依赖 load');
  assert.ok(!/\}, \[load, historyOpen\]\)/.test(devices), '不许把 historyOpen 塞进轮询 effect 的依赖');
  // 展开态走 ref 同步：load 的闭包才读得到当下的值。
  assert.match(devices, /historyOpenRef\.current = historyOpen/, '展开态要同步进 ref');
  // 接口类型在 api.ts 里，且历史行不含凭据材料。
  assert.match(api, /export type RelayHistoryDevice/, '历史行要有自己的类型');
  assert.match(api, /export type DeviceHistoryList/, '历史清单要有自己的回答类型');
  for (const field of ['deviceId', 'name', 'model', 'platform', 'osVersion', 'appVersion', 'boundAt', 'lastSeenAt', 'lastChannel', 'revokedAt', 'expiresAt', 'bindings']) {
    assert.match(api, new RegExp(`\\b${field}\\b`), `历史行少了契约字段 ${field}`);
  }
  assert.match(api, /kind: 'revoked' \| 'expired'/, '结局只有吊销与过期两种');
  assert.match(api, /revokedCount: number/, '设备清单的回答要带历史台数');
  // 老宿主没有这一格：读的地方必须兜成 0，否则 undefined 会让整卡判据失真。
  assert.match(devices, /list\?\.revokedCount \?\? 0/, 'revokedCount 缺省按 0 处理');
});

test('历史行的结局按 kind 分叉：亲手解绑与自然到期是两句', () => {
  assert.equal(zh('panel.devices.historyRevoked'), '已解绑 {time}');
  assert.equal(zh('panel.devices.historyExpired'), '授权已到期 {time}');
  assert.notEqual(zh('panel.devices.historyRevoked'), zh('panel.devices.historyExpired'));
  // 两条不同的键按 kind 选，不许合并成一句「已失效」。
  assert.match(
    devices,
    /t\(device\.kind === 'revoked' \? 'panel\.devices\.historyRevoked' : 'panel\.devices\.historyExpired', \{ time \}\)/,
    '结局文案要按 kind 分叉到两个不同的键',
  );
  // 结局时刻：吊销看 revokedAt，过期看 expiresAt。
  assert.match(devices, /device\.revokedAt \|\| device\.expiresAt/, '结局时刻按 revokedAt → expiresAt 取');
  // 第二行那三件事与保留窗口也得走字典。
  assert.equal(zh('panel.devices.historyBoundAt'), '首次绑定 {time}');
  assert.equal(zh('panel.devices.historyLastSeen'), '最近连接 {time}');
  assert.equal(zh('panel.devices.historyTitle'), '历史 · 已解绑');
  assert.equal(zh('panel.devices.historyFailed'), '读不到历史');
  assert.match(zh('panel.devices.historyRetention'), /最近 \{days\} 天/, '保留窗口那句的天数走占位符');
  assert.match(devices, /HISTORY_RETENTION_DAYS/, '天数要来自一个具名常量');
  assert.match(devices, /HISTORY_RETENTION_DAYS = 30/, '保留窗口是 30 天，与宿主 HISTORY_RETENTION_MS 对齐');
  assert.match(devices, /HISTORY_RETENTION_MS/, '常量旁边要写明它对齐宿主那个名字');
  // 从没连过就如实说「无记录」，不拿绑定时刻顶上。
  assert.match(devices, /panel\.devices\.historyLastSeen[\s\S]{0,200}?panel\.devices\.noRecord/, '没连过要落到「无记录」');
  // 十门都得有这几条。
  for (const key of ['historyTitle', 'historyCount', 'historyBoundAt', 'historyLastSeen', 'historyRevoked', 'historyExpired', 'historyRetention', 'historyFailed']) {
    const rows = dict.split(`panel.devices.${key}`).length - 1;
    assert.ok(rows >= 10, `panel.devices.${key} 只在 ${rows} 门语言里出现，十门都得有`);
  }
});

test('历史行没有动作按钮，也不跟主列表抢注意力', () => {
  // 已解绑的再解绑一次没有意义，过期的那本通行证也已经进不来：这一块只读。
  const block = devices.slice(devices.indexOf('panel.devices.historyTitle'), devices.indexOf('<AlertDialog'));
  assert.ok(block.length > 0, '没找到历史那一块');
  assert.ok(!/<Button/.test(block), '历史行不许有动作按钮');
  assert.ok(!/setPending\(|setPermPending\(/.test(block), '历史行不许接解绑 / 改权限的入口');
  // 视觉收得住：只用卡片里已有的字号与颜色档，不新造底色与圆角。
  assert.ok(!/bg-/.test(block), '历史那一块不许加底色');
  assert.ok(!/rounded/.test(block), '历史那一块不许加圆角');
  assert.ok(!/font-(semibold|medium|bold)/.test(block), '历史那一块不许加粗');
  assert.match(block, /text-xs text-foreground-muted/, '字号与颜色沿用 text-xs + 弱前景那一档');
  // 折叠头不许自己新造动效：仓库里同类折叠是 transition-transform + group-open 那套，
  // 没有额外的 duration 与 hover 变色。
  const head = block.slice(0, block.indexOf('</button>'));
  assert.ok(!/duration-/.test(head), '折叠头不许加 duration：动效沿用既有那套');
  assert.ok(!/hover:/.test(head), '折叠头不许加 hover 变色');
  assert.match(head, /transition-transform/, '箭头旋转保留（与既有折叠同一写法）');
});

test('老宿主没有 ?history=1 分支时，不许把活设备当成历史摆出来', () => {
  // 老宿主的 handler 不认这个 query，会当普通设备清单答掉：回来的正是**活着的手机**，
  // 那些行没有 kind。照渲染就是把正在连着的设备列进「已解绑」里，比不显示更糟。
  assert.match(
    devices,
    /device\.kind === 'revoked' \|\| device\.kind === 'expired'/,
    '历史行要按 kind 过滤：没有结局的行不是历史',
  );
  assert.match(devices, /historyUnreadable/, '整份对不上时按「读不到历史」处理');
  // 台数徽标只数活设备：一台不剩时不画，否则「已绑定的设备 0」底下挂着解绑记录。
  assert.match(devices, /\{devices\.length > 0 \? \(\s*<Badge variant="secondary" size="sm">/, '台数徽标只在有活设备时画');
});
