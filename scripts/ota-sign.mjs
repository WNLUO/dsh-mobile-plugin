#!/usr/bin/env node
/**
 * 给一个 OTA 包（npm tarball）生成发布用的 sha256 与签名。
 *
 * 输出一段 JSON（stdout）——发布时把 sha256 与 signature 一起写进中转的发布记录即可。
 * 私钥只在这里读一次，不落盘、不外传。
 *
 * 用法：
 *   node scripts/ota-sign.mjs \
 *     --package ./dsh-mobile-plugin-0.5.77.tgz \
 *     --version 0.5.77 --platform darwin-arm64 --channel stable \
 *     --package-url https://example.com/pkg.tgz \
 *     --key ~/ota-signing-private.pem
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { otaSignaturePayload } from '../lib/shell/ota-signing.js'

const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
}

const pkgPath = arg('package')
const version = arg('version')
const platform = arg('platform')
const channel = arg('channel') || 'stable'
const packageUrl = arg('package-url')
const keyPath = arg('key') || path.join(process.env.HOME || '', '.dsh', 'ota-signing', 'ota-signing-private.pem')

if (!pkgPath || !version || !platform || !packageUrl) {
  process.stderr.write('缺少参数：需要 --package --version --platform --package-url（--key 可选）\n')
  process.exit(2)
}

const raw = fs.readFileSync(pkgPath)
const sha256 = crypto.createHash('sha256').update(raw).digest('hex')
const payload = otaSignaturePayload({ version, platform, channel, sha256, packageUrl })
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath))
const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')

process.stdout.write(JSON.stringify({ version, platform, channel, sha256, packageUrl, signature }, null, 2) + '\n')
