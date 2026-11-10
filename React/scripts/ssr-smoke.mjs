// 冒烟渲染：在 node 里把各张卡与配置弹窗渲染一遍，抓运行期崩（不依赖浏览器）。
// Base UI 的弹窗走 portal，SSR 渲染出来是空字符串，弹窗要另用浏览器验收。
import { ToastProvider } from '@appica/ui-react/toast'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
})

// 断言里写的是**源语言**的原文，所以先把界面语言钉到简中。
//
// 脚本跑在 node 里，`navigator.languages` 是 `['en-US']`，不钉就整片渲染成英文，
// 带中文的 `must` 全会红。钉的是**偏好**那一档，走的还是组件真正读的那份状态。
const { setPanelLanguagePreference } = await server.ssrLoadModule('/src/lib/i18n/index.ts')
setPanelLanguagePreference('zh-Hans')

const status = {
  enabled: true,
  instanceId: 'e889ea75',
  pairingCode: '417432',
  relayUrl: 'https://dsh-hub.wnluo.com',
  name: 'Mac',
  pairingPolicy: 'code',
  os: 'darwin',
  platform: 'darwin',
  osVersion: '27.2.0',
  arch: 'arm64',
  appVersion: '0.1.47',
  localPort: 19387,
  tunnel: { state: 'connected', error: null },
  lan: { enabled: true, port: 59583, requestedPort: 59583, state: 'listening', error: null, adjusted: true },
  sidecar: {
    state: 'healthy',
    scope: { worker: 'restartable', facade: 'restartable', host: 'needs-host-restart' },
    restarts: 2,
    restartedAt: 1791364828863,
    restartError: null,
  },
  mirror: { pushedAt: 1791364828863, ok: true, error: null },
}

const pairing = {
  ok: true,
  name: 'Mac',
  relayUrl: 'https://dsh-hub.wnluo.com',
  lanUrls: ['http://192.168.31.253:51864'],
  pairingCode: '417432',
  lanPort: 51864,
  lanPortAdjusted: true,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280"><rect width="280" height="280" fill="#fff"/></svg>',
}

const [Conn, Pair, Upd, Dialog, Lan, Alert, Onb, Join, Spn, Toggle, Picker, Inbox, Dl, Lang, Actions, Notice, Dbg] = await Promise.all([
  server.ssrLoadModule('/src/components/ConnectionCard.tsx'),
  server.ssrLoadModule('/src/components/PairingCard.tsx'),
  server.ssrLoadModule('/src/components/UpdateCard.tsx'),
  server.ssrLoadModule('/src/components/RelayConfigDialog.tsx'),
  server.ssrLoadModule('/src/components/PortDialog.tsx'),
  server.ssrLoadModule('/src/App.tsx'),
  server.ssrLoadModule('/src/Onboarding.tsx'),
  server.ssrLoadModule('/src/components/JoinGroupButton.tsx'),
  server.ssrLoadModule('/src/components/SponsorButton.tsx'),
  server.ssrLoadModule('/src/components/ThemeToggle.tsx'),
  server.ssrLoadModule('/src/components/AddressPicker.tsx'),
  server.ssrLoadModule('/src/components/InboxCard.tsx'),
  server.ssrLoadModule('/src/components/DownloadAppButton.tsx'),
  server.ssrLoadModule('/src/components/LanguageMenu.tsx'),
  server.ssrLoadModule('/src/components/TopRightActions.tsx'),
  server.ssrLoadModule('/src/components/NoticeBoard.tsx'),
  server.ssrLoadModule('/src/Debug.tsx'),
])

const noop = () => {}
/**
 * 地址库（`/api/relay/addresses`）：一块有线 + 一块无线的局域网地址，另有一条公网与两条 IPv6。
 *
 * IPv6 两条照真机形状给：一条 `::998` 稳定地址 + 一条随机后缀的隐私地址，都是真 GUA。
 * 用它冒烟「第三份只显示、不进单选」那条路。
 */
const addressBook = {
  ok: true,
  port: 51864,
  preferred: '172.16.5.5',
  lan: [
    { address: '192.168.31.253', url: 'http://192.168.31.253:51864', interface: 'en0', family: 'IPv4' },
    { address: '172.16.5.5', url: 'http://172.16.5.5:51864', interface: 'eth1', family: 'IPv4' },
  ],
  public: [{ address: '203.0.113.7', url: 'http://203.0.113.7:51864', interface: 'eth0', family: 'IPv4' }],
  ipv6: [
    {
      address: '240e:338:5213:6c11::998',
      url: 'http://[240e:338:5213:6c11::998]:51864',
      interface: 'en1',
      family: 'IPv6',
    },
    {
      address: '240e:338:5213:6c11:cd0:2748:2a39:ecea',
      url: 'http://[240e:338:5213:6c11:cd0:2748:2a39:ecea]:51864',
      interface: 'en1',
      family: 'IPv6',
    },
  ],
}

/**
 * 只有 IPv6 的机器：私网、公网都没有。
 *
 * 这是「可选项为空」那一支的**唯一**入口：退成「还没取到地址」等于用户在面板上看不到
 * 任何可用地址，而 IPv6 正是这台机器唯一能进来的路。
 */
const ipv6OnlyBook = { ok: true, port: 18787, preferred: '', lan: [], public: [], ipv6: addressBook.ipv6 }

/** 服务器那台：一条私网都没有，候选全落在公网那份上。 */
const serverBook = {
  ok: true,
  port: 18787,
  preferred: '',
  lan: [],
  public: [
    { address: '111.180.197.228', url: 'http://111.180.197.228:18787', interface: 'eth0', family: 'IPv4' },
    { address: '210.16.177.228', url: 'http://210.16.177.228:18787', interface: 'eth1', family: 'IPv4' },
  ],
}

const pairingProps = {
  status,
  pairing,
  addressBook,
  busy: '',
  error: '',
  restartError: null,
  onOpenConfig: noop,
  onChangePolicy: noop,
  onReconnect: noop,
  onRestartSidecar: noop,
  onRevokeAll: noop,
  onSavePreferred: noop,
}
const cases = [
  ['ConnectionCard', h(Conn.ConnectionCard, { status, busy: '', onToggle: noop, onOpenLan: noop })],
  [
    'ConnectionCard（隧道被拒+局域网调整+旁挂异常）',
    h(Conn.ConnectionCard, {
      status: {
        ...status,
        enabled: false,
        lan: { ...status.lan, enabled: false, state: 'error', error: 'listen EADDRINUSE', port: 0 },
        sidecar: { ...status.sidecar, state: 'error', restartError: 'sidecar 已连续退出 3 次' },
        mirror: { ...status.mirror, ok: false, error: '推送失败', pushedAt: 0 },
        tunnel: { state: 'error', error: '隧道关闭: 1008 bad registration secret', registerSecretRequired: true, admissionHint: 'register-secret' },
      },
      busy: 'toggle',
      onToggle: noop,
      onChangePolicy: noop,
      onOpenLan: noop,
    }),
  ],
  ['ConnectionCard（白名单拒绝）', h(Conn.ConnectionCard, { status: { ...status, tunnel: { state: 'error', error: 'unknown instance: xyz', instanceNotAllowed: true, admissionHint: 'instance-allowlist' } }, busy: '', onToggle: noop, onOpenLan: noop })],
  // 这三处默认遮着（二维码、中转地址、手机该填的地址），断言的是「遮着的时候页面里有什么」：
  // 二维码**根本不在 DOM 里**（整块换成占位），地址只留「已隐藏」+ 一颗贴上无障碍名的
  // 「显示」按钮。点开之后是纯前端状态，`renderToString` 不留状态，要靠真浏览器点。
  ['PairingCard', h(Pair.PairingCard, pairingProps), 'aria-label="显示本地识别地址"'],
  ['PairingCard（二维码默认遮着）', h(Pair.PairingCard, pairingProps), '二维码已隐藏'],
  ['PairingCard（只有公网地址的机器）', h(Pair.PairingCard, { ...pairingProps, addressBook: serverBook }), 'aria-label="显示本地识别地址"'],
  ['PairingCard（拿不到二维码）', h(Pair.PairingCard, { ...pairingProps, pairing: null, error: '请先启用远程控制并保存配置' })],
  ['PairingCard（重启失败）', h(Pair.PairingCard, { ...pairingProps, busy: 'restart', restartError: 'spawn ENOENT' })],
  // 老宿主没有 `/api/relay/addresses`：退回配对接口给的那串 URL，只显示、不能选。
  ['PairingCard（老宿主没有地址库）', h(Pair.PairingCard, { ...pairingProps, addressBook: null }), 'aria-label="显示本地识别地址"'],
  // 准入开关只留在配对卡的「配对策略」那行（2026-11-02 从连接状态与网络配置两处合并过来）：
  // 这里钉住「它真的渲染出来了」，而且名字挂在开关自己身上。
  ['PairingCard（配对策略是开关）', h(Pair.PairingCard, pairingProps), 'aria-label="允许新设备绑定"'],
  // 更新卡片先问宿主那四条 `/api/relay/update/*`，拿不到才退化成市场老路。
  // SSR 里 effect 不跑，两条分支都不进：这一遍只冒烟「标题 + 正在读状态」那一屏。
  // 完整分支要用真浏览器看 —— 这里没有全局 fetch 打桩。
  ['UpdateCard', h(Upd.UpdateCard, { version: '0.1.47', busy: '', onRestartSidecar: noop }), '插件更新'],
  ['UpdateCard（正在重启 sidecar）', h(Upd.UpdateCard, { version: '0.1.47', busy: 'restart', onRestartSidecar: noop })],
  // 收件文件卡：与 UpdateCard 同一个处境 —— 它先问 `/api/relay/inbox/status`，SSR 里
  // effect 不跑，所以这一遍只冒烟「标题 + 正在读收件目录」那一屏。
  ['InboxCard', h(Inbox.InboxCard), '收件文件'],
  ['NetworkConfigDialog', h(Dialog.RelayConfigDialog, { open: true, onOpenChange: noop, status, addressBook, lanUrls: pairing.lanUrls, busy: '', onSave: noop, onSavePreferred: noop })],
  ['NetworkConfigDialog（老宿主没有地址库）', h(Dialog.RelayConfigDialog, { open: true, onOpenChange: noop, status, addressBook: null, lanUrls: pairing.lanUrls, busy: 'lan', onSave: noop, onSavePreferred: noop })],
  ['PortDialog', h(Lan.PortDialog, { open: true, onOpenChange: noop, port: 18787, busy: '', onSave: noop })],
  ['PortDialog（正在提交）', h(Lan.PortDialog, { open: true, onOpenChange: noop, port: 51864, busy: 'lan', onSave: noop })],
  // 地址选择器单独过一遍：配对卡里那处地址默认遮着（见上一条注释），SSR 看不到内容，
  // 所以第三份（IPv6）到底画没画出来只能直接渲染这个组件看。
  ['AddressPicker（有私网 + 公网 + IPv6）', h(Picker.AddressPicker, { book: addressBook, port: 51864, value: '172.16.5.5', onChange: noop }), 'IPv6 直连'],
  ['AddressPicker（只有 IPv6）', h(Picker.AddressPicker, { book: ipv6OnlyBook, port: 18787, value: '', onChange: noop }), 'http://[240e:338:5213:6c11::998]:18787'],
  ['AddressPicker（老宿主没有 ipv6 字段）', h(Picker.AddressPicker, { book: serverBook, port: 18787, value: '', onChange: noop }), '公网地址'],
  ['App（首屏）', h(Alert.App)],
  // 引导页只看得到第一页：后面几页靠页面内部状态推进，SSR 里 effect 不跑。
  // 四页的完整流程要用浏览器点（见 .../api/relay/panel/setup）。
  ['Onboarding（欢迎页）', h(Onb.Onboarding, {})],
  ['Onboarding（强制引导 setup）', h(Onb.Onboarding, { replay: true })],
  // 悬浮那颗「加入交流群」独立于两张卡，单独过一遍：它要贴住右下角（`fixed`）、
  // 文字和微信图标都得在。点开之后是什么还没定，所以只看按钮在不在。
  ['JoinGroupButton', h(Join.JoinGroupButton, {}), '加入交流群'],
  // 赞助那颗悬浮按钮：按钮文字与网络说明都得在；弹窗同样走 portal，SSR 是空串，
  // 收款地址 / 二维码要真浏览器点开看。
  ['SponsorButton', h(Spn.SponsorButton, {}), '赞助'],
  // 右上角那组按钮（日夜 + 界面语言）：SSR 里没有 ThemeProvider（`useTheme` 回空值），
  // 只冒烟「两颗按钮都在、无障碍名给的是下一步」；图标换不换、贴没贴住要看真浏览器。
  ['ThemeToggle', h(Toggle.ThemeToggle, {}), 'aria-label="切换到夜间模式"'],
  ['LanguageMenu', h(Lang.LanguageMenu, {}), 'aria-label="界面语言"'],
  ['TopRightActions', h(Actions.TopRightActions, {}), 'aria-label="切换到夜间模式"'],
  // 语言菜单的弹层走 portal，SSR 出来是空字符串：五门清单与打勾那一项要真浏览器点开看。
  ['TopRightActions（两颗都在）', h(Actions.TopRightActions, {}), 'aria-label="界面语言"'],
  // 下载入口：按钮本身总是在，四条渠道在弹窗里 —— 弹窗未打开时不进 DOM（Base UI 走 portal），
  // 所以这一遍只冒烟按钮；四条链接有没有齐要看真浏览器点开（和上面几颗弹窗同一种处境）。
  ['DownloadAppButton', h(Dl.DownloadAppButton, {}), '下载 APP'],
  // 公告板：标题与那条号都得在 —— 号是常量、正文从它拼，缺了就是占位符没接上。
  // 公告卡里两条：版本门槛 + 「自己搭一台中转」，后者带一个指向仓库的链接。
  // 调试页（桌面端那颗手机图标弹的就是它）：首屏还没读回宿主，只有标题与引导句，
  // 但「加载、链路、故障账本」这几段的骨架得先立着，所以四段标题都该在。
  ['Debug', h(Dbg.Debug, {}), '插件调试'],
  ['Debug（装载段在）', h(Dbg.Debug, {}), '盘上版本'],
  ['Debug（故障账本段在）', h(Dbg.Debug, {}), '故障账本'],
  ['NoticeBoard', h(Notice.NoticeBoard, {}), '搭建自己的网络'],
  ['NoticeBoard（版本门槛还在）', h(Notice.NoticeBoard, {}), '最低插件版本'],
]

let failed = 0
// 每条用例可以多带一个「必须出现的串」：分支只在特定状态下才渲染（例如「设置菜单那一半是旧的」），
// 光看「没崩」分不出「渲染了提示块」还是「这条分支根本没进去」。
for (const [label, element, must] of cases) {
  try {
    // 提示胶囊的 provider 与真实页面同款（见 `src/main.tsx`）：`useNotify` 在**渲染期**
    // 就取 `useToastManager()`，没有 provider 直接抛，卡片级用例会整片报假红。
    const html = renderToString(h(ToastProvider, {}, element))
    if (must && !html.includes(must)) {
      failed += 1
      console.log(`FAIL ${label}: 渲染出来了，但缺少「${must}」（这条分支没进去？）`)
      continue
    }
    console.log(`ok   ${label}  ${html.length} 字节`)
  } catch (err) {
    failed += 1
    console.log(`FAIL ${label}: ${err && err.message}`)
    console.log(String((err && err.stack) || '').split('\n').slice(1, 4).join('\n'))
  }
}

// ── 保存配置：宿主回了 200 但「没下发成功」时，界面必须当失败处理 ──────────────
//
// 宿主是**先落盘、再重启 sidecar**，所以 200 只说明存上了；隧道没注册上时原因在
// `applyError` 里（`lib/routes/control-plane.js` 那条路由的注释写明这一发是用户填完地址
// 之后唯一的反馈）。面板从前不读它，于是「改坏了、手机当场连不上」被说成「配置已保存」
// 还顺手关了窗。判据收在 `apiPost` 那一层，四个保存入口都从那一条走，所以冒烟它就够。
const realFetch = globalThis.fetch

/** 让下一次 `fetch` 回一份给定的 JSON（200，与宿主那条路由同形）。 */
function stubFetchJson(payload) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })
}

const api = await server.ssrLoadModule('/src/lib/api.ts')
const { t } = await server.ssrLoadModule('/src/lib/i18n/index.ts')

stubFetchJson({ ...status, applyError: 'tunnel register: ECONNREFUSED' })
try {
  await api.apiPost('/api/relay/config', { relayUrl: 'https://bad.example' })
  failed += 1
  console.log('FAIL 保存配置：宿主回了 applyError，apiPost 却当成成功（界面会报「已保存」并关窗）')
} catch (err) {
  const text = String((err && err.message) || err)
  // 期望的形状 = 字典里 `{message}` 前后那两截 + 宿主那句原话。
  const [head, tail] = t('panel.shell.applyFailed', { message: '\u0000' }).split('\u0000')
  const shaped = text.startsWith(head) && text.includes('tunnel register: ECONNREFUSED') && text.endsWith(tail)
  if (!shaped) {
    failed += 1
    console.log(`FAIL 保存配置：错误里没按字典拼上宿主的原因，拿到的是「${text}」`)
  } else {
    console.log('ok   保存配置：applyError 翻成一次失败，原因带在消息里')
  }
}

// 没有 applyError 时照旧成功 —— 别把每一发都当失败。
stubFetchJson({ ...status, applyError: null })
try {
  const view = await api.apiPost('/api/relay/config', { relayUrl: 'https://good.example' })
  if (view.relayUrl !== status.relayUrl) throw new Error('回来的不是宿主那份状态')
  console.log('ok   保存配置：没有 applyError 时照旧成功')
} catch (err) {
  failed += 1
  console.log(`FAIL 保存配置：没有 applyError 却被判成失败（${err && err.message}）`)
} finally {
  globalThis.fetch = realFetch
}

// 那句失败文案十门语言都得在，占位符也得一样。`panel.shell.*` 住在 shell.ts，
// 而键集对齐那条守卫（`test/panel-i18n.test.cjs`）按文件名把它跳过了 —— 漏一门就没人报。
const { SHELL } = await server.ssrLoadModule('/src/lib/i18n/messages/shell.ts')
{
  const own = Object.entries(SHELL).map(([language, table]) => [language, table['panel.shell.applyFailed']])
  const missing = own.filter(([, text]) => !text).map(([language]) => language)
  const wrongPlaceholder = own.filter(([, text]) => text && !text.includes('{message}')).map(([language]) => language)
  if (missing.length > 0 || wrongPlaceholder.length > 0) {
    failed += 1
    console.log(`FAIL panel.shell.applyFailed：缺 ${missing.join(',') || '无'}；不带 {message} 的 ${wrongPlaceholder.join(',') || '无'}`)
  } else {
    console.log(`ok   panel.shell.applyFailed 十门齐（${own.length} 门，都带 {message}）`)
  }
}

// 五个保存入口（中转地址 / 端口 / 配对策略 / 优先地址 / 审批自动审阅档，引导页那一发也是
// 中转地址）**都还在打那条路由**：谁把它换成别的写法，上面那条判定就再也盖不到它了。
// 按各自提交的字段认，不按出现次数认 —— 少一处就是有一项保存悄悄不走这条判定了。
const SAVE_FIELDS = [
  'patch',
  '{ pairingPolicy }',
  '{ lanPort: port }',
  '{ preferredLanAddress: address }',
  '{ approvalAutoReview: enabled }',
]
for (const [file, fields] of [['App.tsx', SAVE_FIELDS], ['Onboarding.tsx', ['patch']]]) {
  const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')
  const lost = fields.filter((field) => !text.includes(`apiPost<StatusView>('/api/relay/config', ${field})`))
  if (lost.length > 0) {
    failed += 1
    console.log(`FAIL ${file} 这些保存不走 apiPost('/api/relay/config') 了：${lost.join(' / ')}`)
  } else {
    console.log(`ok   ${file} 的 ${fields.length} 个保存入口都还走 apiPost('/api/relay/config')`)
  }
}

await server.close()
process.exit(failed ? 1 : 0)
