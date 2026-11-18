'use strict';

/**
 * 面板上两件跟「公用中转」有关的约定（2026-11-18 用户要求）。
 *
 *  ① 公用中转体验提示弹窗：只在公用中转**启用**时显示（2026-11-18 用户要求）——Console 拿
 *     status.relayUrl 问 isPublicRelayUrl 得 visible，停用时整扇不渲染，不必每次进来都看；
 *     可关闭、挂在控制台根部，文案走字典（十门）。
 *  ② 网络配置弹窗的中转地址栏：拆成两栏——第一栏「公用中转」是内置地址（只读展示、带
 *     启用/停用切换），第二栏「自建中转」可编辑（2026-11-18 用户要求：把公用中转内置进来、
 *     排在第一个，原「选择公用中转」清单弹窗随之撤掉）。宿主只有 relayUrl 一个字段，两栏共用它。
 *     配公网自建时宿主把公用强制停用（status.publicRelayBlocked）：地址划删除线、禁用「启用」，
 *     但**不再摆那段说明文字**（用户 2026-11-18 要求删掉）。
 *
 * 读源码（不是产物）：这几条是写法上的约定，产物要重建才更新，源码一变就该红。
 * 真正渲染长什么样由 ssr-smoke 与开发服务器看。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'React', 'src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

const dialog = read('components', 'PublicRelayNoticeDialog.tsx');
const consoleSrc = read('Console.tsx');
const config = read('components', 'RelayConfigDialog.tsx');
const noticeDict = read('lib', 'i18n', 'messages', 'notice.ts');
const panelDict = read('lib', 'i18n', 'messages', 'panel.ts');

/** 从字典文件里数某个键出现几次（每门语言一次）。 */
const countKey = (dict, key) => dict.split(`'${key}'`).length - 1;

test('公用中转提示弹窗：只在公用启用时显示、可关闭、挂控制台，文案十门齐', () => {
  // 只在公用启用时显示：Console 从 status.relayUrl 判，停用时整扇不渲染。
  assert.match(dialog, /visible: boolean/, '组件收 visible 判定');
  assert.match(dialog, /if \(!visible \|\| dismissed\) return null/, '停用或已关过就不渲染');
  // 判定与网络配置同源：用 links 的 isPublicRelayUrl，不在组件里另写一份。
  const links = read('lib', 'links.ts');
  assert.match(links, /export function isPublicRelayUrl/, '公用地址判定在 links 一份');
  assert.match(consoleSrc, /visible=\{isPublicRelayUrl\(status\.relayUrl\)\}/, 'Console 用它算 visible 传进来');
  // 可关闭：dismissed 状态关窗，Dialog 的 onOpenChange 也接上（遮罩 / Esc 能关）。
  assert.match(dialog, /useState\(false\)/, 'Dismissed 初始为假');
  assert.match(dialog, /<Dialog open onOpenChange=\{\(open\) => \{ if \(!open\) setDismissed\(true\) \}\}>/, '弹窗要能靠遮罩 / Esc 关');
  assert.match(dialog, /onClick=\{\(\) => setDismissed\(true\)\}/, '「我已知晓」按钮要能关窗');
  // 三类文案都走字典，不写死中文。
  for (const key of ['title', 'body', 'action']) {
    assert.match(dialog, new RegExp(`t\\('panel\\.publicRelayNotice\\.${key}'\\)`), `${key} 要走字典`);
    assert.equal(countKey(noticeDict, `panel.publicRelayNotice.${key}`), 10, `${key} 要十门齐全`);
  }
  // 正文的 \n\n 分段靠 whitespace-pre-line 还原，不拆成多条键。
  assert.match(dialog, /whitespace-pre-line/, '正文的分段要能显示出来');
  // 挂在控制台根部，并把网络配置那扇窗的开关传进去。
  assert.match(consoleSrc, /<PublicRelayNoticeDialog[\s\S]*?onOpenConfig=\{\(\) => setConfigOpen\(true\)\}/, '弹窗要挂在控制台上并接好开配置的回调');
});

test('提示弹窗的「网络配置」按钮：关掉自己、打开配置窗', () => {
  // 收件区两颗按钮：「网络配置」在左、「我已知晓」在右（先网络配置后知晓）。
  const footer = dialog.slice(dialog.indexOf('<DialogFooter'));
  const configAt = footer.indexOf("t('panel.pairing.openConfig')");
  const gotItAt = footer.indexOf("t('panel.publicRelayNotice.action')");
  assert.ok(configAt > 0 && gotItAt > configAt, '「网络配置」要在「我已知晓」左边');
  // 点击时先关自己、再开配置窗，避免两扇叠着；文案复用现成那条（十门已齐）。
  assert.match(footer, /onClick=\{\(\) => \{ setDismissed\(true\); onOpenConfig\(\) \}\}/, '关掉提示、打开网络配置');
  assert.match(dialog, /onOpenConfig: \(\) => void/, '组件要收开配置的回调');
  assert.match(panelDict, /'panel\.pairing\.openConfig': '网络配置'/, '复用现成的网络配置文案');
});

test('网络配置：公用中转内置只读排第一，自建可编辑，清单弹窗已撤', () => {
  // 两栏共用 relayUrl：从地址本身判当前用的是哪条内置公用地址，判据只写一处。
  assert.match(config, /PUBLIC_RELAYS\.find\(/, '从内置清单找出当前在用的公用地址');
  assert.match(config, /const activePublicRelay =/, '判定收敛到一个具名变量');
  // 第一栏：列出内置清单、只读展示；开关是标题右侧一颗按钮，按当前状态显示启用 / 停用。
  assert.match(config, /PUBLIC_RELAYS\.map\(/, '内置公用地址逐条列出来');
  assert.match(config, /readOnly: true/, '内置地址只读、用户改不了');
  const first = config.slice(config.indexOf('第一栏：公用中转'), config.indexOf('第二栏：自建中转'));
  assert.ok(first.indexOf('FieldLabel') < first.indexOf('<Button'), '启用/停用按钮要在标题右侧');
  assert.match(first, /onClick=\{\(\) => setRelayUrl\(activePublicRelay \? '' : PUBLIC_RELAYS\[0\]\.url\)\}/, '启用写入内置地址、停用清空');
  assert.match(first, /activePublicRelay \? 'panel\.relay\.disablePublic' : 'panel\.relay\.enablePublic'/, '当前用公用时显示停用，否则显示启用');
  assert.ok(!/t\('panel\.relay\.usePublic'\)/.test(config), '原「使用公用中转」按钮已撤');
  // 第二栏：自建地址可编辑；用公用时留空。
  assert.match(config, /value=\{activePublicRelay \? '' : relayUrl\}/, '用公用时自建栏留空');
  assert.match(config, /id: 'relay-url'/, '自建栏保留 relay-url 这个输入');
  // 标签是「公用中转 / 自建中转」两条。
  assert.match(config, /t\('panel\.relay\.publicKind'\)/, '第一栏标签是公用中转');
  assert.match(config, /t\('panel\.relay\.selfKind'\)/, '第二栏标签是自建中转');
  // 文案十门齐：publicKind / selfKind / enablePublic / disablePublic（旧的 usePublic 已撤）。
  for (const key of ['publicKind', 'selfKind', 'enablePublic', 'disablePublic']) {
    assert.equal(countKey(panelDict, `panel.relay.${key}`), 10, `${key} 要十门齐全`);
  }
  assert.equal(countKey(panelDict, 'panel.relay.usePublic'), 0, '旧的「使用公用中转」键已撤，别留死键');
  // 清单弹窗与它的状态都撤了：公用地址内置在主窗第一栏，不再有「选择公用中转」按钮。
  assert.ok(!/relayPickerOpen/.test(config), '「选择公用中转」清单弹窗的状态要删干净');
  assert.ok(!/t\('panel\.relay\.choosePublicRelay'\)/.test(config), '主窗不许再有「选择公用中转」按钮');
});

test('网络配置：公用被强制停用时划删除线、禁用启用，但不摆说明文字', () => {
  // 判据在宿主那一处，面板只读 status.publicRelayBlocked 如实展示，不另算一套。
  assert.match(config, /status\.publicRelayBlocked === true/, '从宿主 status 读被停用标志');
  assert.match(config, /const publicRelayBlocked =/, '收敛成一个具名变量');
  const first = config.slice(config.indexOf('第一栏：公用中转'), config.indexOf('第二栏：自建中转'));
  // 按钮：被停用时禁用「启用」（与正在保存一起做或）。
  assert.match(first, /disabled=\{!canSave \|\| publicRelayBlocked\}/, '被停用时启用按钮要禁用');
  // 地址：被停用时加 line-through 与弱前景。
  assert.match(first, /publicRelayBlocked \? ' line-through text-foreground-muted' : ''/, '被停用时地址划删除线');
  // 用户 2026-11-18 要求删掉那段说明文字：组件不引用、字典也不留死键。
  assert.ok(!/publicBlockedHint/.test(first), '被停用时不再摆那段说明文字');
  assert.equal(countKey(panelDict, 'panel.relay.publicBlockedHint'), 0, '说明文案的键已删干净');
  // StatusView 类型带了这一格（老宿主缺省按未停用）。
  const api = read('lib', 'api.ts');
  assert.match(api, /publicRelayBlocked\?: boolean/, '接口类型要带被停用标志');
});

test('网络配置：六个字段交给 grid 自动排版，不手动分左右列', () => {
  // 之前手动把 4 个塞左列、2 个塞右列，行数不均衡（左 4 右 2）。改成 6 个 Field 直接当
  // grid 子项、按行自动填，增减字段都会重排成两列均衡的行数。
  assert.match(config, /grid-cols-2[^"]*gap-y-4/, '两列之间要有行间距');
  const body = config.slice(config.indexOf('<DialogBody'), config.indexOf('</DialogBody>'));
  assert.ok(!/flex flex-col gap-4/.test(body), '不许再把字段手动包进左右两个 flex 列');
  // 六个字段都直接躺在 DialogBody 里（以 Field 起头，不再多一层 div 包裹）。
  assert.equal((body.match(/<Field>/g) || []).length, 6, '六个字段都要直接排在 grid 里');
  // 启用 / 停要是普通文字按钮（ghost），不抢主按钮的视觉份量。
  const first = config.slice(config.indexOf('第一栏：公用中转'), config.indexOf('第二栏：自建中转'));
  assert.match(first, /variant="ghost"/, '启用 / 停用是普通文字按钮');
  assert.ok(!/variant=\{activePublicRelay/.test(first), '不许按状态切成描边 / 主按钮');
});

test('网络配置：自建中转那一栏右侧有「中转仓库」外链', () => {
  // 用户 2026-11-18 要求：自建中转那一块右侧加一颗文字按钮，点了跳去中转本体的仓库。
  const second = config.slice(config.indexOf('第二栏：自建中转'));
  const field = second.slice(0, second.indexOf('</Field>'));
  assert.match(field, /t\('panel\.relay\.selfRepo'\)/, '按钮文案走字典');
  assert.match(field, /href=\{RELAY_REPO_URL\}/, '地址用 links 里那一条，不在组件里另写');
  assert.match(field, /target="_blank"/, '外链在新标签页打开（桌面壳只把 http(s) 交给系统浏览器）');
  assert.match(field, /buttonVariants\(\{ variant: 'ghost', size: 'sm' \}\)/, '与面板其它文字按钮同一套样式');
  assert.ok(
    field.indexOf('FieldLabel') < field.indexOf('href={RELAY_REPO_URL}'),
    '按钮在「自建中转」标题右侧',
  );
  assert.equal(countKey(panelDict, 'panel.relay.selfRepo'), 10, '文案十门齐全');
  assert.match(
    read('lib', 'links.ts'),
    /RELAY_REPO_URL = 'https:\/\/github\.com\/WNLUO\/dsh-mobile-server'/,
    '仓库地址仍是中转本体那个仓',
  );
});

test('网络配置：公用栏有「查看面板」按钮，另起弹窗看各条入口的延迟与心电图', () => {
  // 用户 2026-11-19 要求：公用中转地址越来越多，要给一个面板看各条入口的性能。
  const first = config.slice(config.indexOf('第一栏：公用中转'), config.indexOf('第二栏：自建中转'));
  assert.match(first, /t\('panel\.relay\.viewPanel'\)/, '按钮文案走字典');
  assert.match(first, /onClick=\{\(\) => setPublicPanelOpen\(true\)\}/, '点开另起面板弹窗');
  // 挂在主窗、接收当前在用的那条（标「使用中」）。
  assert.match(config, /<PublicRelayPanelDialog[\s\S]*?open=\{publicPanelOpen\}[\s\S]*?activeUrl=/, '面板弹窗挂上并传当前地址');

  const panel = read('components', 'PublicRelayPanelDialog.tsx');
  // 走宿主代测接口（浏览器直连会被 CORS 挡）：POST /api/relay/probe-relays，带全部内置地址。
  assert.match(panel, /apiPost<\{ ok: boolean; results: ProbeResult\[\] \}>\('\/api\/relay\/probe-relays'/, '探测走宿主接口');
  assert.match(panel, /PUBLIC_RELAYS\.map\(\(item\) => item\.url\)/, '一次把所有内置地址送测');
  // 定时重测：开窗一轮、之后按间隔再跑；关窗停掉（不常驻打外网）。
  assert.match(panel, /setInterval\(/, '按间隔重复测');
  assert.match(panel, /clearInterval\(/, '关窗停掉定时器');
  // 折线 + 延迟值：复用同一把刻度尺，不在这里另写一套算法。
  assert.match(panel, /latencySparklinePath\(/, '画心电图复用共享的折线函数');
  assert.match(panel, /latencyLevel\(/, '快 / 一般 / 慢按共享口径上色');
  const spark = read('lib', 'latency-sparkline.ts');
  assert.match(spark, /SPARK_FAST_MS = 100/, '刻度拐点 100ms（与 App 同一把尺）');
  assert.match(spark, /SPARK_CEILING_MS = 600/, '刻度封顶 600ms');
  // 文案十门齐。
  for (const key of ['viewPanel', 'panelTitle', 'panelHint', 'panelUpdated']) {
    assert.equal(countKey(panelDict, `panel.relay.${key}`), 10, `${key} 要十门齐全`);
  }
});
