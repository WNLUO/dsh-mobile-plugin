// 冒烟渲染：在 node 里把各张卡与配置弹窗渲染一遍，抓运行期崩（不依赖浏览器）。
// 注意：Base UI 的弹窗走 portal，SSR 渲染出来是空字符串，弹窗要另用浏览器验收。
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

const [Conn, Pair, Upd, Dialog, Lan, Alert, Onb] = await Promise.all([
  server.ssrLoadModule('/src/components/ConnectionCard.tsx'),
  server.ssrLoadModule('/src/components/PairingCard.tsx'),
  server.ssrLoadModule('/src/components/UpdateCard.tsx'),
  server.ssrLoadModule('/src/components/RelayConfigDialog.tsx'),
  server.ssrLoadModule('/src/components/LanDialog.tsx'),
  server.ssrLoadModule('/src/App.tsx'),
  server.ssrLoadModule('/src/Onboarding.tsx'),
])

const noop = () => {}
/** 地址库（`/api/relay/addresses`）：一块有线 + 一块无线的局域网地址，另有一条公网。 */
const addressBook = {
  ok: true,
  port: 51864,
  preferred: '172.16.5.5',
  lan: [
    { address: '192.168.31.253', url: 'http://192.168.31.253:51864', interface: 'en0', family: 'IPv4' },
    { address: '172.16.5.5', url: 'http://172.16.5.5:51864', interface: 'eth1', family: 'IPv4' },
  ],
  public: [{ address: '203.0.113.7', url: 'http://203.0.113.7:51864', interface: 'eth0', family: 'IPv4' }],
}

/** 服务器那台：一条私网都没有，候选全落在公网那份上（用户 2026-10-11 截图那个现场）。 */
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
  onRegenerate: noop,
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
      onOpenLan: noop,
    }),
  ],
  ['ConnectionCard（白名单拒绝）', h(Conn.ConnectionCard, { status: { ...status, tunnel: { state: 'error', error: 'unknown instance: xyz', instanceNotAllowed: true, admissionHint: 'instance-allowlist' } }, busy: '', onToggle: noop, onOpenLan: noop })],
  ['PairingCard', h(Pair.PairingCard, pairingProps), '局域网地址 · eth1'],
  ['PairingCard（只有公网地址的机器）', h(Pair.PairingCard, { ...pairingProps, addressBook: serverBook }), '公网地址 · eth0'],
  ['PairingCard（拿不到二维码）', h(Pair.PairingCard, { ...pairingProps, pairing: null, error: '请先启用远程控制并保存配置' })],
  ['PairingCard（重启失败）', h(Pair.PairingCard, { ...pairingProps, busy: 'restart', restartError: 'spawn ENOENT' })],
  // 老宿主没有 `/api/relay/addresses`：退回配对接口给的那串 URL，只显示、不能选。
  ['PairingCard（老宿主没有地址库）', h(Pair.PairingCard, { ...pairingProps, addressBook: null }), '192.168.31.253'],
  // 更新卡片现在先问宿主那四条 `/api/relay/update/*`，拿不到才退化成市场那条老路。
  // SSR 里 effect 不跑（`renderToString` 不会执行 useEffect），所以两条分支都不进：
  // 这一遍只冒烟「标题 + 正在读状态」那一屏。宿主 / 市场两条完整分支要用真浏览器看
  // （ssr-smoke 没有全局 fetch 打桩，见 `noop` 上面的说明）。
  ['UpdateCard', h(Upd.UpdateCard, { version: '0.1.47', busy: '', onRestartSidecar: noop }), '插件更新'],
  ['UpdateCard（正在重启 sidecar）', h(Upd.UpdateCard, { version: '0.1.47', busy: 'restart', onRestartSidecar: noop })],
  ['RelayConfigDialog', h(Dialog.RelayConfigDialog, { open: true, onOpenChange: noop, status, busy: '', onSave: noop })],
  ['LanDialog', h(Lan.LanDialog, { open: true, onOpenChange: noop, status, lanUrls: pairing.lanUrls, addressBook, busy: '', onSave: noop, onSavePreferred: noop })],
  ['LanDialog（没地址）', h(Lan.LanDialog, { open: true, onOpenChange: noop, status: { ...status, lan: { ...status.lan, enabled: false, state: 'off', port: 0 } }, lanUrls: [], addressBook: null, busy: 'lan', onSave: noop, onSavePreferred: noop })],
  ['App（首屏）', h(Alert.App)],
  // 引导页只看得到第一页：后面几页靠页面内部状态推进，SSR 里 effect 不跑。
  // 四页的完整流程要用浏览器点（见 .../api/relay/panel/setup）。
  ['Onboarding（欢迎页）', h(Onb.Onboarding, {})],
  ['Onboarding（强制引导 setup）', h(Onb.Onboarding, { replay: true })],
]

let failed = 0
// 每条用例可以多带一个「必须出现的串」：分支只在特定状态下才渲染（例如「设置菜单那一半是旧的」），
// 光看「没崩」分不出「渲染了提示块」还是「这条分支根本没进去」。
for (const [label, element, must] of cases) {
  try {
    const html = renderToString(element)
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

await server.close()
process.exit(failed ? 1 : 0)
