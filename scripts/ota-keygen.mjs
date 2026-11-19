#!/usr/bin/env node
/**
 * 生成 OTA 签名用的 Ed25519 密钥对。
 *
 * 私钥是发布方的命根子：**离线保管，绝不进仓库、绝不和发布服务器放一起**。这里只把私钥写到
 * 你指定的路径（默认 0600），公钥打到 stdout，贴进 `lib/shell/ota-public-key.pem` 即可。
 *
 * 用法：
 *   node scripts/ota-keygen.mjs --out ~/ota-signing-private.pem
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const out = path.resolve(arg('out', path.join(os.homedir(), '.dsh', 'ota-signing', 'ota-signing-private.pem')))
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' })
const pub = publicKey.export({ type: 'spki', format: 'pem' })

fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
fs.writeFileSync(out, priv, { mode: 0o600 })
process.stderr.write(`私钥已写入 ${out}（0600）。请移到离线介质，别留在发布服务器上。\n`)
process.stdout.write(pub)
