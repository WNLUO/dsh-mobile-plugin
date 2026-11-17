'use strict';

/**
 * 面板上两件跟「公用中转」有关的约定（2026-11-18 用户要求）。
 *
 *  ① 公用中转体验提示弹窗：现为**强制显示**（先过样式，触发条件以后接），进来就弹一次、
 *     可关闭、挂在控制台根部；文案走字典（十门）。将来接条件时只该换触发那一处判据。
 *  ② 网络配置弹窗的中转地址栏：拆成两栏——第一栏「公用中转」是内置地址（只读展示、带「使用」
 *     按钮切过去），第二栏「自建中转」可编辑（2026-11-18 用户要求：把公用中转内置进来、排在
 *     第一个，原「选择公用中转」清单弹窗随之撤掉）。宿主只有 relayUrl 一个字段，两栏共用它：
 *     点公用的「使用」写入内置地址；当前用的那条标「使用中」。
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

test('公用中转提示弹窗：强制显示、可关闭、挂控制台，文案十门齐', () => {
  // 强制显示先过样式：判据就是 useState(true)，将来接条件只换这一处。
  assert.match(dialog, /useState\(true\)/, '现在是强制显示：挂载即弹');
  // 可关闭：Confirm 按钮关窗，Dialog 本身也把 onOpenChange 接上（遮罩 / Esc 能关）。
  assert.match(dialog, /<Dialog open=\{open\} onOpenChange=\{setOpen\}>/, '弹窗要能靠遮罩 / Esc 关');
  assert.match(dialog, /onClick=\{\(\) => setOpen\(false\)\}/, '「我已知晓」按钮要能关窗');
  // 三类文案都走字典，不写死中文。
  for (const key of ['title', 'body', 'action']) {
    assert.match(dialog, new RegExp(`t\\('panel\\.publicRelayNotice\\.${key}'\\)`), `${key} 要走字典`);
    assert.equal(countKey(noticeDict, `panel.publicRelayNotice.${key}`), 10, `${key} 要十门齐全`);
  }
  // 正文的 \n\n 分段靠 whitespace-pre-line 还原，不拆成多条键。
  assert.match(dialog, /whitespace-pre-line/, '正文的分段要能显示出来');
  // 挂在控制台根部。
  assert.match(consoleSrc, /<PublicRelayNoticeDialog \/>/, '弹窗要挂在控制台上');
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

test('网络配置：公用被强制停用时划删除线、禁用启用、给出原因', () => {
  // 判据在宿主那一处，面板只读 status.publicRelayBlocked 如实展示，不另算一套。
  assert.match(config, /status\.publicRelayBlocked === true/, '从宿主 status 读被停用标志');
  assert.match(config, /const publicRelayBlocked =/, '收敛成一个具名变量');
  const first = config.slice(config.indexOf('第一栏：公用中转'), config.indexOf('第二栏：自建中转'));
  // 按钮：被停用时禁用「启用」（与正在保存一起做或）。
  assert.match(first, /disabled=\{!canSave \|\| publicRelayBlocked\}/, '被停用时启用按钮要禁用');
  // 地址：被停用时加 line-through 与弱前景。
  assert.match(first, /publicRelayBlocked \? ' line-through text-foreground-muted' : ''/, '被停用时地址划删除线');
  // 说明文案十门齐。
  assert.match(first, /t\('panel\.relay\.publicBlockedHint'\)/, '被停用时给出原因');
  assert.equal(countKey(panelDict, 'panel.relay.publicBlockedHint'), 10, '说明文案要十门齐');
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
