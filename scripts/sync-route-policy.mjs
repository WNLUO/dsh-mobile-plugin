#!/usr/bin/env node
// 手机自动选路是规则真源，生成桌面可直接加载、按设备隔离状态的运行时代码。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(root, '../app/src/services/viewmodels/route-order.ts')
const target = path.join(root, 'lib/shared/route-order.cjs')
const check = process.argv.includes('--check')
if (!fs.existsSync(source)) {
  if (!check) throw new Error('App 选路规则来源不存在')
  console.log('独立插件检出：使用随包发布的选路规则')
} else {
  const require = createRequire(path.join(root, 'React/package.json'))
  const ts = require('typescript')
  const result = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, removeComments: true },
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }))
  const content = "'use strict';\n// 由 App 自动选路规则同步；运行 scripts/sync-route-policy.mjs 更新。\nfunction createRoutePolicy() {\n  const exports = {};\n"
    + result.outputText.split('\n').map(line => line ? `  ${line}` : '').join('\n')
    + '\n  return exports;\n}\nmodule.exports = { createRoutePolicy, ...createRoutePolicy() };\n'
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      console.error('桌面选路规则与 App 不一致，请运行 scripts/sync-route-policy.mjs')
      process.exitCode = 1
    } else console.log('手机与桌面自动选路规则一致')
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    console.log('桌面自动选路规则已同步')
  }
}
