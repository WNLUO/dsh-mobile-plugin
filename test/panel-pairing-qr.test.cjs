'use strict';

/**
 * 配对二维码：展示尺寸与白边、主页默认隐藏，以及隧道段临期前的自动续码。
 *
 * 续码那一条是 2026-11-07 加的：宿主每取一次码就现开一个两分钟的一次性隧道窗口、并作废
 * 上一张，而用户常常是装完 App 过一阵才回来扫。不续的话屏幕上那张的隧道段早过期，App 静默
 * 丢掉它、只剩局域网与中转 —— 手机不在同一网且中转不通时就是「扫不上但码看着正常」。
 * 所以面板要在临期前重取一次；但**不能退化成轮询**（每两分钟白开一个没人扫的窗口）。
 *
 * 主页那两栏后来合成一张无标题整卡，这一条也钉在这里：两列 6:4，正文各自一份、bare 挂进去。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'React', 'src');
const read = (name) => fs.readFileSync(path.join(src, name), 'utf8');

test('引导页二维码放大并保留白色边框', () => {
  const page = read('Onboarding.tsx');
  assert.match(page, /const qrSvg = pairing\?\.svg \?\? ''/);
  assert.match(page, /size-\[320px\] max-w-full rounded-lg bg-white p-3 \[&_svg\]:h-full \[&_svg\]:w-full/);
  assert.match(page, /dangerouslySetInnerHTML=\{\{ __html: qrSvg \}\}/);
});

test('长动态文案不挤塌信息行标签，也不把行高撑爆', () => {
  const row = read('components/InfoRow.tsx');
  // 2026-11-20 现场：宿主报一串 webServer 错误时，标签被挤成竖排单字、整卡行数乱掉。
  assert.match(row, /min-w-\[5\.5rem\] flex-1/, '标签有最小宽度，不会被长值挤成竖排');
  assert.match(row, /min-w-0 max-w-\[62%\] break-words/, '值可收缩并折行，不再 shrink-0 硬顶');
  assert.match(row, /line-clamp-2/, '动态错误最多两行');
  assert.match(row, /title=\{detail\}/, '全文留在 title 里可看');
});

test('卡片内常驻报错不铺大块告警，只占一行状态', () => {
  // 2026-11-20 现场：重启失败一块红框横在配对卡下面，把整卡撑高、排版全乱。
  for (const file of ['PairingCard.tsx', 'ConnectionCard.tsx', 'InboxCard.tsx']) {
    assert.doesNotMatch(read(`components/${file}`), /<Alert/, `${file} 不该再有铺开的大块告警`);
  }
  const connection = read('components/ConnectionCard.tsx');
  assert.match(connection, /restartError/, '重启失败并入连接卡');
  assert.match(connection, /panel\.pairing\.sidecarRestartFailed/, '失败文案跟在旁挂进程那行');
});

test('P2P 弹窗对老宿主的缺字段兜底，不白屏', () => {
  const dialog = read('components/P2PDialog.tsx');
  assert.match(dialog, /Array\.isArray\(status\?\.candidates\)/, '候选地址缺失时按空数组渲染');
  assert.doesNotMatch(dialog, /status\.candidates\.(?:length|map)/, '不许直接读可能不存在的字段');
});

test('异常走红色感叹号弹窗可复制，动作区独占一排', () => {
  const mark = read('components/IssueMark.tsx');
  const consoleSrc = read('Console.tsx');
  const update = read('components/UpdateCard.tsx');
  const connection = read('components/ConnectionCard.tsx');
  // 2026-11-20 用户要求：报错不铺正文，统一收进标签旁的感叹号；点开有全文与复制按钮。
  assert.match(mark, /text-error/, '感叹号是红色');
  assert.match(mark, /<CopyButton/, '弹窗里能一键复制报错');
  assert.match(mark, /issue\.detail/, '复制的是原文');
  assert.doesNotMatch(update, /<p className="mt-2 text-xs text-foreground-muted">\s*\{t\('panel\.update\.(?:versionDrift|diskDrift)'/, '版本对不上的两段话不再铺正文');
  assert.match(update, /onIssues\(issues\)/, '版本对不上交给上层');
  assert.match(consoleSrc, /versionIssues/, '控制台把详情挂到左列');
  // 动作区在整卡里独占一排，与上面三列之间有分隔，不受上面内容高度推动。
  assert.match(consoleSrc, /<div className="mt-4 flex h-12 items-center justify-end border-t border-border-muted">\s*<UpdateCard/, '动作区独占一排且垂直居中');
  assert.match(connection, /labelExtra=\{[^}]*IssueMark/, '连接状态各行把感叹号挂在标签旁');
  assert.match(connection, /status\.mirror\.ok === false \? <IssueMark/, '会话镜像只在真推送失败（ok===false）挂感叹号，良性跳过不挂');
  // 2026-11-20 用户要求：不可用的长说明不铺在正文，行里只报短状态词，长文进感叹号；复制文案就是「复制」。
  assert.match(connection, /unavailableShort/, '不可用只显示短状态词');
  assert.match(mark, /t\('panel\.common\.copy'\)/, '复制按钮用通用「复制」文案，不借用「发给 AI」');
});

test('主页二维码放大并保留白边，默认隐藏时不渲染 SVG', () => {
  const card = read('components/PairingCard.tsx');
  // 2026-11-23 需求变更：中转地址与本地识别地址两行从配对卡删掉，「揭/遮」那颗按钮
  // 跟着一起撤，地址只在「网络配置」里看。这里反过来钉状态别回来。
  assert.doesNotMatch(card, /useState\(\{ relay: false \}\)/);
  // 二维码整块是一个方形入口：点它直接开放大弹窗（「显示」与「放大」合并），
  // 卡片本体不再内嵌码图（防窥屏，也省高度）。
  // 2026-11-20 需求变更：宽屏占位尺寸量右邻信息行的实际高度，宽高都取它才是正方形；
  // 不能拉伸高度（会变长方形），也不能靠 aspect-ratio 反推宽度（会塌成竖条）。
  // 窄屏单列没有可参照高度，退回限宽 200 的正方形。
  assert.match(card, /onClick=\{openQrZoom\}/);
  assert.match(card, /new ResizeObserver\(measure\)/, '信息行高度变化时重新量');
  assert.match(card, /ref=\{infoRef\}/, '量的正是右邻信息行');
  assert.match(card, /sm:h-\[var\(--qr-size\)\] sm:w-\[var\(--qr-size\)\]/, '宽高都取实测高度，正方形');
  assert.match(card, /panel\.pairing\.qrHidden/);
  assert.equal((card.match(/dangerouslySetInnerHTML/g) ?? []).length, 1, '二维码 SVG 只在放大弹窗里渲染');
  assert.match(card, /dangerouslySetInnerHTML=\{\{ __html: pairing\.svg \}\}/);
});

test('配对与更新合成一张无标题整卡：左六放二维码与控件，右四放网络面板，更新动作独占一排', () => {
  const app = read('Console.tsx');
  const card = read('components/PairingCard.tsx');
  const update = read('components/UpdateCard.tsx');
  // 2026-11-23 用户要求：右列四个控件挪到二维码旁边，空出来的右列装网络面板。
  // 更新动作仍独占下面一排，不受上面内容高度推动。
  assert.match(app, /<Card frame="solid">\s*<div className="flex flex-col gap-4 p-4 lg:flex-row lg:gap-6">/, '顶栏是一张整卡，两列同一 flex 行自然等高');
  assert.match(app, /className="lg:w-3\/5">\s*<PairingCard\s+bare/, '左列放二维码与控件');
  assert.ok(card.includes('ALIGNED_ROWS'), '二维码旁的控件行沿用同一套行高');
  assert.match(app, /<NetworkPanel status=\{status\} \/>/, '右列装网络面板');
  assert.match(app, /<div className="mt-4 flex h-12 items-center justify-end border-t border-border-muted">\s*<UpdateCard\s+bare/, '更新动作独占一排且垂直居中');
  assert.match(update, /flex flex-wrap justify-end gap-1 lg:flex-nowrap/, '宽屏动作行不换行，四颗按钮横着排；小屏才允许折行');
  assert.doesNotMatch(app, /<PairingCard\s+fill|<UpdateCard\s+fill/, '等高开关已撤');
  assert.match(card, /bare = false/, '配对卡有裸内容模式');
  assert.match(update, /bare = false/, '更新卡有裸内容模式');
  assert.doesNotMatch(card, /fill \? 'flex h-full min-h-0 flex-col'/, '不再有 fill 全高分支');
  assert.doesNotMatch(update, /fill \? 'flex h-full min-h-0 flex-col'/, '不再有 fill 全高分支');
  // 信息行顶部对齐、跟二维码齐平，多出的高度留在卡片下方；信息行这层不许再垂直居中。
  assert.match(card, /className="flex min-w-0 flex-1 flex-col"/, '二维码旁的控件列顶部对齐，不靠 justify 拉散');
  assert.doesNotMatch(card, /flex-1 flex-col justify-/, '信息行不许 justify-around/center 把行拉到中间');
  assert.doesNotMatch(card, /hscroll|min-w-max/, '信息行自然换行，不再横向滚动截掉标签');
});

test('整卡左二维码右网络面板：端口与版本搬到连接状态卡，三个开关跟着二维码', () => {
  const app = read('Console.tsx');
  const card = read('components/PairingCard.tsx');
  // 2026-11-23 用户要求：端口与版本两行搬到连接状态卡，开关挪到二维码旁。
  assert.doesNotMatch(card, /moreOpen|panel\.common\.more/, '「其他」弹窗入口已撤');
  assert.doesNotMatch(card, /panel\.update\.runningVersion/, '运行中版本已搬到连接状态卡');
  const connection = read('components/ConnectionCard.tsx');
  assert.match(connection, /panel\.update\.runningVersion/, '运行中版本在连接状态卡');
  // 版本值现在交给连接状态卡（配对卡不再收 version）。
  assert.match(app, /<ConnectionCard[\s\S]{0,400}version=\{status\.appVersion \|\| ''\}/, '版本值传给连接状态卡');
  assert.match(card, /<PairingPolicyRows[\s\S]{0,200}onChangeControlReport/, '自动上报回调交给二维码旁的控件');
  assert.doesNotMatch(card, /onOpenSelfCheck|onOpenConfig|DownloadAppButton/, '网络配置、检查网络、下载 APP 都不在配对卡');
  assert.match(app, /keepApplyError: true/, '配置保存回填宿主状态，开关点下即变');
  assert.match(app, /if \(payload\.applyError\) \{[\s\S]{0,80}notify\('error'/, '下发失败仍按原口径报错，不说成已成功');
});

test('两处都能点开「看大图」弹窗，放大版仍是同一份 SVG 且不改默认隐藏', () => {
  const card = read('components/PairingCard.tsx');
  const page = read('Onboarding.tsx');
  // 主页：点码本身开弹窗（2026-11-02 起不再单独摆一颗「看大图」按钮），弹窗里按视口高度
  // 放大（600px 上限，2026-11-09 从 440 抬高），白底。
  assert.match(card, /const \[qrZoom, setQrZoom\] = React\.useState\(false\)/);
  assert.match(card, /onClick=\{openQrZoom\}/);
  assert.match(card, /dangerouslySetInnerHTML=\{\{ __html: pairing\.svg \}\}/);
  // 2026-11-22 起点码走 openQrZoom（先记当前配对时间基线再开），弹窗 open 多一个“配对已完成就关”的
  // 判断（避免关窗瞬间闪旧码/空白）。断言对齐到这个新行为，原意（点码开同一份 SVG 的放大弹窗）不变。
  assert.match(card, /<Dialog open=\{qrZoom && !pairingDone\} onOpenChange=\{setQrZoom\}>/);
  assert.match(card, /aspect-square h-\[min\(64vh,560px\)\][^\n]*\[&_svg\]:h-full/);
  // 那颗按钮撤了：码本身就够点，遮着的时候也不该有一处点了只看见空白的地方。
  // 现在 `panel.pairing.qrZoom` 只剩码自己那个 `aria-label` 一处。
  assert.equal(
    (card.match(/panel\.pairing\.qrZoom/g) ?? []).length,
    1,
    '主页那颗「看大图」按钮已经删了，别再加回来',
  );
  // 引导页同一份弹窗：码还没有的时候不给放大（那时弹窗里只是一片白）。
  assert.match(page, /const \[qrZoomOpen, setQrZoomOpen\] = useState\(false\)/);
  assert.match(page, /<Dialog open=\{qrZoomOpen\} onOpenChange=\{setQrZoomOpen\}>/);
  assert.match(page, /\{qrSvg \? \([\s\S]{0,200}panel\.pairing\.qrZoom/);
  assert.match(page, /onClick=\{\(\) => setQrZoomOpen\(true\)\}[\s\S]{0,400}dangerouslySetInnerHTML=\{\{ __html: qrSvg \}\}/);
});

test('引导页与主页都在隧道段临期前续一次码，且排的是下一拍而不是轮询', () => {
  const page = read('Onboarding.tsx');
  const app = read('Console.tsx');
  // 两处同一套写法：读这一版码的 `expiresAt`，排一个定时器，到点重取一次。
  for (const [name, text] of [['Onboarding.tsx', page], ['Console.tsx', app]]) {
    assert.match(text, /const wait = pairingRenewIn\(pairing\)/, `${name} 要按这一版码的隧道段排下一拍`);
    assert.match(
      text,
      /window\.setTimeout\(\(\) =>[\s\S]{0,120}(load|renew)Pairing\(\)[\s\S]{0,200}window\.clearTimeout\(timer\)/,
      `${name} 到点只重取一次，卸载时要把定时器撤掉`,
    );
    // 挂在 `pairing` 上：每拿到一版新码就按它的新 `expiresAt` 重排，而不是一秒一轮去问宿主。
    assert.match(text, /\}, \[pairing/);
    assert.ok(
      !/window\.setInterval\([\s\S]{0,200}(load|renew)Pairing/.test(text),
      `${name} 不许把续码做成轮询：每两分钟开一个没人扫的配对窗口，助手那边是实打实的开销`,
    );
  }
  // 主页只在远程控制开着时续：关着的时候宿主对这条路由回 409。
  assert.match(app, /if \(!status\?\.enabled\) return[\s\S]{0,120}pairingRenewIn\(pairing\)/);
  // 续码失败要留着屏幕上那张：`loadPairing` 失败会把码清掉换成一句报错，而背景续码时
  // 屏幕上那张的局域网与中转两段仍然能扫，换成报错只会让人以为码坏了。
  assert.match(
    app,
    /const renewPairing = useCallback\(async \(\) => \{[\s\S]{0,200}catch \{[\s\S]{0,120}\}[\s\S]{0,40}\}, \[\]\)/,
    '主页的续码要走一份不清码的取法',
  );
});

test('续码间隔按隧道段的 expiresAt 算，没有隧道段就不排', async () => {
  const { pairingRenewIn, PAIRING_RENEW_LEAD_MS } = await import(
    path.join(src, 'lib', 'api.ts')
  );
  const now = 1_700_000_000_000;
  const at = (seconds) => ({ ok: true, tailcat: { address: 'a', port: 1, expiresAt: seconds } });

  // 两分钟的窗口取到码，正常节奏是九十秒后再续一次（留 30 秒给人扫码）。
  assert.equal(pairingRenewIn(at(now / 1000 + 120), now), 120_000 - PAIRING_RENEW_LEAD_MS);
  // 只剩最后几秒：一秒后再取，别当场连着发。
  assert.equal(pairingRenewIn(at(now / 1000 + 2), now), 1_000);
  // 没有隧道段：助手不可用 / 出错 / 老宿主没有这个字段 —— 不排下一拍。
  assert.equal(pairingRenewIn({ ok: true }, now), null);
  assert.equal(pairingRenewIn({ ok: true, tailcat: null }, now), null);
  assert.equal(pairingRenewIn(null, now), null);
  // 拿到手就已经过期：这一页的钟和宿主对不上（远程打开面板时常见），倒计时算不出来就不排，
  // 否则定时器会退化成每秒重取一次、每次都白开一个配对窗口。
  assert.equal(pairingRenewIn(at(now / 1000 - 60), now), null, '过期的隧道段不排下一拍');
});

