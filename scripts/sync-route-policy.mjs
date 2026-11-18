#!/usr/bin/env node
// 手机侧的选路规则与通道性格是规则真源，生成桌面可直接加载、按设备隔离状态的运行时代码。
// 2026-11-19：同时转译选路规则与通道性格表，分别生成 route-order.cjs 与 route-channels.cjs，--check 一并覆盖。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const require = createRequire(path.join(root, 'React/package.json'))

// 两份真源：自动选路规则（route-order）与通道性格表（route-channels）。
const sources = [
  {
    name: '自动选路规则',
    source: path.resolve(root, '../app/src/services/viewmodels/route-order.ts'),
    target: path.join(root, 'lib/shared/route-order.cjs'),
    factory: 'createRoutePolicy',
    banner: '由 App 自动选路规则同步',
  },
  {
    name: '通道性格表',
    source: path.resolve(root, '../app/src/services/viewmodels/route-channels.ts'),
    target: path.join(root, 'lib/shared/route-channels.cjs'),
    factory: 'createRouteChannels',
    banner: '由 App 通道表同步',
  },
]

let failed = false
for (const item of sources) {
  if (!fs.existsSync(item.source)) {
    if (!check) throw new Error(`App ${item.name}来源不存在`)
    console.log(`独立插件检出：使用随包发布的${item.name}`)
    continue
  }
  const ts = require('typescript')
  const result = ts.transpileModule(fs.readFileSync(item.source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, removeComments: true },
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }))
  const content = `'use strict';\n// ${item.banner}；运行 scripts/sync-route-policy.mjs 更新。\nfunction ${item.factory}() {\n  const exports = {};\n`
    + result.outputText.split('\n').map((line) => line ? `  ${line}` : '').join('\n')
    + `\n  return exports;\n}\nmodule.exports = { ${item.factory}, ...${item.factory}() };\n`
  if (check) {
    if (!fs.existsSync(item.target) || fs.readFileSync(item.target, 'utf8') !== content) {
      console.error(`桌面${item.name}与 App 不一致，请运行 scripts/sync-route-policy.mjs`)
      failed = true
    } else console.log(`手机与桌面${item.name}一致`)
  } else {
    fs.mkdirSync(path.dirname(item.target), { recursive: true })
    fs.writeFileSync(item.target, content)
    console.log(`桌面${item.name}已同步`)
  }
}
if (check && failed) process.exitCode = 1
