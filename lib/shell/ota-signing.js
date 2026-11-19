/**
 * 桌面完整包 OTA 的签名校验。
 *
 * 现状（被审阅点名的那个洞）：中转下发的 sha256 与包内清单都来自**同一台发布服务器**，
 * 攻击者拿住那台机器就能把包和「用来证明包没被改」的哈希一起换掉——等于没有校验。这里
 * 用 Ed25519 离线签名补上「来源真实」那一半：发布方在**离线**环境用私钥对「版本 / 平台 /
 * 通道 / sha256 / 下载地址」这组字段签名，客户端内置**公钥**验签。中转只能转发，没有私钥
 * 就伪造不出签名，也就推不了带毒的包。
 *
 * 边界：签名只证明「这组字段由私钥持有者发布」，不加密内容；内容完整性仍由 sha256 钉住。
 * 两者一道：先验签（字段真实）→ 再按 sha256 校验下载内容（内容未改）。
 *
 * 私钥绝不进仓库、绝不与发布服务器同机（否则服务器被黑连签名一起伪造）。
 */

import crypto from 'node:crypto'
import { OTA_PUBLIC_KEY_PEM } from './ota-public-key.js'

/** 签名字段集合的版本前缀，改字段就改它，免得新旧签法互相误认。 */
const SIGNING_DOMAIN = 'dsh-ota-v1'

/**
 * 把要签的字段规范成一个稳定字符串。发布脚本与客户端**必须**用同一份，签出来才对得上。
 *
 * @param {{version:string, platform:string, channel:string, sha256:string, packageUrl:string}} release
 * @returns {string}
 */
export function otaSignaturePayload(release) {
  return [
    SIGNING_DOMAIN,
    String(release.version ?? ''),
    String(release.platform ?? ''),
    String(release.channel ?? ''),
    String(release.sha256 ?? ''),
    String(release.packageUrl ?? ''),
  ].join('\n')
}

/**
 * 内置的 OTA 签名公钥。可用 `DSH_OTA_PUBLIC_KEY_PEM` 覆盖（自建发布方换自己的公钥）。
 * 读不到就返回空串——调用方据此拒绝安装（没有公钥等于验不了签）。
 *
 * @returns {string}
 */
export function otaPublicKeyPem() {
  const override = process.env.DSH_OTA_PUBLIC_KEY_PEM
  if (typeof override === 'string' && override.trim()) return override
  return OTA_PUBLIC_KEY_PEM
}

/**
 * 校验一条 OTA 发布记录的签名。任何一项不满足都抛错——绝不「没签名就当不校验」。
 *
 * @param {object} release 含 version / platform / channel / sha256 / packageUrl / signature
 * @param {string} [publicKeyPem] 公钥 PEM；缺省用内置 / 环境变量
 * @returns {true}
 */
export function verifyOtaSignature(release, publicKeyPem = otaPublicKeyPem()) {
  const signature = release && typeof release.signature === 'string' ? release.signature.trim() : ''
  if (!signature) throw new Error('OTA 包缺少签名，拒绝安装')
  if (!publicKeyPem) throw new Error('未配置 OTA 签名公钥，拒绝安装')
  let key
  try {
    key = crypto.createPublicKey(publicKeyPem)
  } catch {
    throw new Error('OTA 签名公钥无法解析，拒绝安装')
  }
  let ok = false
  try {
    ok = crypto.verify(null, Buffer.from(otaSignaturePayload(release), 'utf8'), key, Buffer.from(signature, 'base64'))
  } catch {
    ok = false
  }
  if (!ok) throw new Error('OTA 包签名校验失败，拒绝安装')
  return true
}
