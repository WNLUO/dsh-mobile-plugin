// 连接反馈投影线路及 Tailcat 运行事实，配对码、密钥与完整地址不进入诊断。
import type { StatusView } from './api.ts'

function safeError(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\bBearer[^\S\n]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|key|password|passwd|lansecret|pairingcode|signingkey|registrykey)\s*=\s*[^\s,;&"'）)]+/gi, '$1=[redacted]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted]')
    .slice(0, 500)
}

export function connectionFeedbackFacts(status: StatusView | null): Record<string, string> {
  if (!status) return {}
  let relayHost = ''
  try { relayHost = new URL(status.relayUrl).host } catch { /* 未配置中转时留空 */ }
  return {
    observed_at: new Date().toISOString(),
    plugin_version: status.appVersion || '',
    platform: status.platform || '',
    system_version: status.osVersion || '',
    relay_host: relayHost,
    tunnel_state: status.tunnel.state,
    tunnel_error: safeError(status.tunnel.error),
    lan_state: status.lan.state,
    lan_port: String(status.lan.port),
    lan_error: safeError(status.lan.error),
    discovery_state: status.lan.discovery?.state || '',
    discovery_error: safeError(status.lan.discovery?.error),
    sidecar_state: safeError(status.sidecar.state),
    sidecar_restart_error: safeError(status.sidecar.restartError),
    tailcat_available: String(status.tailcat?.available ?? ''),
    tailcat_enabled: String(status.tailcat?.enabled ?? ''),
    tailcat_running: String(status.tailcat?.running ?? ''),
    tailcat_ready: String(status.tailcat?.ready ?? ''),
    tailcat_target_port: String(status.tailcat?.targetPort ?? ''),
    tailcat_paired: String(status.tailcat?.paired ?? ''),
    tailcat_error: safeError(status.tailcat?.error),
    mirror_error: safeError(status.mirror.error),
  }
}
