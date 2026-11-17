/**
 * 从一段 frp 配置里认出「手机该拨哪个公网入口」。
 *
 * 只管解析，不碰任何 I/O。按 frp 官方配置结构来认（TOML / INI，附带 JSON）：
 *   · 顶层 `serverAddr`（或 ini 的 `server_addr`）+ 若干个代理块（TOML 的 `[[proxies]]`、ini 的 `[名字]`）；
 *   · 每个代理块有 `type`（tcp / https / http…）、`remotePort`、`localPort`、`customDomains`。
 *
 * 出来两种结果：
 *   · tcp 转发：公网入口是 `serverAddr:remotePort` → 进「TCP 直连地址」；
 *   · https/http 转发：公网入口是 `https://域名` → 进「直连地址」（裸 TCP 打到 443 会因 TLS 失败）。
 *
 * 一个真实世界的坑：像 PassNAT 这类服务商生成配置时会把 `remotePort` 留空（公网端口的默认值由
 * 服务端映射，很多家直接等于本机端口）。这时不能直接判失败——按 `localPort` 推一个公网端口填上，
 * 并用 `note: 'inferred-local-port'` 标明「这是推的」，让用户在面板上对着服务商控制台核对。
 */

export type FrpImportResult =
  | { ok: true; field: 'tcp' | 'direct'; value: string; kind: 'tcp' | 'https'; note?: 'inferred-local-port'; port?: number }
  | { ok: false; reason: 'empty' | 'bad-tcp' | 'no-address' }

type Proxy = { type: string; remotePort: string; localPort: string; domains: string[] }

/** 去掉一对包裹的引号与行尾注释，再 trim。 */
function cleanValue(raw: string): string {
  return String(raw || '')
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^["']/, '')
    .replace(/["']$/, '')
    .trim()
}

/** 一段「键 = 值 / 键: 值」文本 → 小写键的字典（同键取第一个）。 */
function readPairs(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of String(block || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue
    const match = /^([A-Za-z0-9_.]+)\s*[=:]\s*(.+)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    if (!(key in out)) out[key] = cleanValue(match[2])
  }
  return out
}

/** customDomains / custom_domains：数组或逗号分隔都认。 */
function parseDomains(value: string): string[] {
  const text = String(value || '').trim()
  if (!text) return []
  const quoted = [...text.matchAll(/["']([^"']+)["']/g)].map((item) => item[1].trim()).filter(Boolean)
  if (quoted.length) return quoted
  return text
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 一块代理配置（小写键）→ 规范化的代理。 */
function toProxy(pairs: Record<string, string>): Proxy {
  const pick = (...keys: string[]) => {
    for (const key of keys) if (pairs[key]) return pairs[key]
    return ''
  }
  return {
    type: (pick('type') || '').toLowerCase(),
    remotePort: pick('remoteport', 'remote_port'),
    localPort: pick('localport', 'local_port'),
    domains: parseDomains(pick('customdomains', 'custom_domains')),
  }
}

/** TOML / YAML 风格的 `[[proxies]]` 分段。 */
function parseTomlLike(text: string): { serverAddr: string; proxies: Proxy[] } {
  const parts = text.split(/\[\[\s*proxies\s*\]\]/i)
  const global = readPairs(parts[0])
  const serverAddr = global.serveraddr || global.server_addr || ''
  const proxies = parts.slice(1).map((block) => toProxy(readPairs(block)))
  return { serverAddr, proxies }
}

/** 老 INI：`[common]` 放 server_addr，其余段各是一条代理。 */
function parseIni(text: string): { serverAddr: string; proxies: Proxy[] } {
  const sections: Array<{ name: string; pairs: Record<string, string> }> = [{ name: '__global__', pairs: {} }]
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      sections.push({ name: header[1].trim().toLowerCase(), pairs: {} })
      continue
    }
    const match = /^([A-Za-z0-9_.]+)\s*[=:]\s*(.+)$/.exec(line)
    if (!match) continue
    const current = sections[sections.length - 1]
    const key = match[1].toLowerCase()
    if (!(key in current.pairs)) current.pairs[key] = cleanValue(match[2])
  }
  const common = sections.find((section) => section.name === 'common') || sections[0]
  const serverAddr = common.pairs.server_addr || common.pairs.serveraddr || ''
  const proxies = sections
    .filter((section) => section.name !== '__global__' && section.name !== 'common')
    .map((section) => toProxy(section.pairs))
  return { serverAddr, proxies }
}

/** JSON 配置。 */
function parseJson(text: string): { serverAddr: string; proxies: Proxy[] } | null {
  let data: unknown
  try { data = JSON.parse(text) } catch { return null }
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const serverAddr = typeof obj.serverAddr === 'string' ? obj.serverAddr : typeof obj.server_addr === 'string' ? obj.server_addr : ''
  const list = Array.isArray(obj.proxies) ? obj.proxies : []
  const proxies = list.map((raw) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const str = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
    const domainsRaw = item.customDomains ?? item.custom_domains
    return {
      type: str(item.type).toLowerCase(),
      remotePort: str(item.remotePort ?? item.remote_port),
      localPort: str(item.localPort ?? item.local_port),
      domains: Array.isArray(domainsRaw) ? domainsRaw.map((entry) => String(entry)) : parseDomains(str(domainsRaw)),
    }
  })
  return { serverAddr, proxies }
}

function validPort(value: string): number | null {
  if (!/^\d+$/.test(String(value || ''))) return null
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/** 从解析出的 serverAddr + 代理里挑一个「该填哪个栏、填什么」。 */
function select(serverAddr: string, proxies: Proxy[]): FrpImportResult {
  // ① 有明确 remotePort 的 tcp：最准，直接用。
  for (const proxy of proxies) {
    if (proxy.type && proxy.type !== 'tcp') continue
    const remote = validPort(proxy.remotePort)
    if (serverAddr && remote !== null) {
      return { ok: true, field: 'tcp', value: `${serverAddr}:${remote}`, kind: 'tcp' }
    }
  }
  // ② https/http 给了域名：用域名（不需要 serverAddr）。
  for (const proxy of proxies) {
    if ((proxy.type === 'https' || proxy.type === 'http') && proxy.domains.length) {
      return { ok: true, field: 'direct', value: `https://${proxy.domains[0]}`, kind: 'https' }
    }
  }
  // ③ 有 tcp 但没写 remotePort（服务商默认映射）：按本机端口推一个，并标明是推的。
  for (const proxy of proxies) {
    if (proxy.type && proxy.type !== 'tcp') continue;
    const local = validPort(proxy.localPort)
    if (serverAddr && local !== null) {
      return { ok: true, field: 'tcp', value: `${serverAddr}:${local}`, kind: 'tcp', note: 'inferred-local-port', port: local }
    }
  }
  return { ok: false, reason: 'no-address' }
}

/** 一段配置文本 → 该填到哪个地址栏、填什么。 */
export function parseFrpConfig(raw: string): FrpImportResult {
  const text = String(raw || '').trim()
  if (!text) return { ok: false, reason: 'empty' }

  // ① 直接填了 host:port（允许带 http(s):// 前缀与尾斜杠）。
  const plain = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '').trim()
  const bare = /^(\[[^\]]+\]|[^\s/:?#]+):(\d+)$/.exec(plain)
  if (bare) {
    const port = Number(bare[2])
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { ok: true, field: 'tcp', value: `${bare[1]}:${port}`, kind: 'tcp' }
    }
    return { ok: false, reason: 'bad-tcp' }
  }

  let parsed: { serverAddr: string; proxies: Proxy[] }
  if (text.startsWith('{')) {
    parsed = parseJson(text) || { serverAddr: '', proxies: [] }
  } else if (/\[\[\s*proxies\s*\]\]/i.test(text)) {
    parsed = parseTomlLike(text)
  } else if (/^\s*\[common\]\s*$/im.test(text) || /(?:^|[\r\n])\s*server_addr\s*=/i.test(text)) {
    parsed = parseIni(text)
  } else {
    parsed = parseTomlLike(text)
  }

  return select(parsed.serverAddr, parsed.proxies)
}
