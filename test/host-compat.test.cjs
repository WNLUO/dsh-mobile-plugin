'use strict'

/**
 * `lib/host-compat.cjs` 的三件事：改预设行、复制预设目录、改 patch 里的 insert 行。
 *
 * 为什么这三件事值得单独钉：它们是「官方工具跟着运行时换代」的唯一实现，而失效方式
 * 特别安静 —— 改错了不报错，只是那一行仍按裸名解析、被装载预检整行禁用，现象变成
 * 「模型说没有这个工具」。所以这里不测「有没有调用」，测**改完的东西长什么样**。
 *
 * 运行：node --test test/host-compat.test.cjs
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { rewriteToolNames, syncPresetDir, pinInsertedRows } = require('../lib/host-compat.cjs')

const ENTRY = '/opt/dsh/node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js'

test('只改目标 id 紧跟的那个 name，别处的同名文本不动', () => {
  const source = [
    '# 注释里提到 @deepseek-ai/dsh-tool-ask-user 不算数',
    '  - id: tool-ask-user',
    "    name: '@deepseek-ai/dsh-tool-ask-user'",
    '  - id: tool-present',
    "    name: '@deepseek-ai/dsh-tool-present'",
    '  - id: tool-other',
    "    name: '@deepseek-ai/dsh-tool-ask-user'",
    '',
  ].join('\n')
  const { text, changed } = rewriteToolNames(source, { 'tool-ask-user': ENTRY })
  assert.deepEqual(changed, ['tool-ask-user'])
  assert.ok(text.includes(`name: '${ENTRY}'`), '目标行没被换成入口路径')
  assert.ok(text.includes("name: '@deepseek-ai/dsh-tool-present'"), '未被点名的行不该动')
  // tool-other 用的是同一个包名，但 id 不在目标里 —— 必须原样保留，否则会顺手改掉别的行。
  assert.equal(text.split(`name: '${ENTRY}'`).length - 1, 1)
  assert.ok(text.includes('# 注释里提到'), '注释必须原样保留（解析再序列化会洗掉它们）')
})

test('路径里的单引号按 YAML 的写法转义', () => {
  const source = ['  - id: tool-ask-user', "    name: '@deepseek-ai/dsh-tool-ask-user'", ''].join('\n')
  const { text } = rewriteToolNames(source, { 'tool-ask-user': "/opt/it's here/index.js" })
  assert.ok(text.includes("name: '/opt/it''s here/index.js'"), `转义写错了：${text}`)
})

test('没命中目标时文本一字不改（幂等）', () => {
  const source = ['  - id: tool-ask-user', "    name: '@deepseek-ai/dsh-tool-ask-user'", ''].join('\n')
  const { text, changed } = rewriteToolNames(source, {})
  assert.deepEqual(changed, [])
  assert.equal(text, source)
})

test('syncPresetDir 复制整棵目录并只改写命中行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-compat-'))
  const source = path.join(root, 'presets')
  const out = path.join(root, 'out')
  fs.mkdirSync(path.join(source, 'standard'), { recursive: true })
  fs.writeFileSync(path.join(source, 'standard', 'preset.yml'), 'name: Standard\n')
  fs.writeFileSync(
    path.join(source, 'standard', 'agent.cordis.yml'),
    ['  - id: tool-ask-user', "    name: '@deepseek-ai/dsh-tool-ask-user'", ''].join('\n'),
  )

  const result = syncPresetDir(source, out, { 'tool-ask-user': ENTRY })
  assert.equal(result, out)
  assert.equal(fs.readFileSync(path.join(out, 'standard', 'preset.yml'), 'utf8'), 'name: Standard\n',
    '非 yml 目标行的文件也要照原样复制过去（少一个文件 roster 就组不出来）')
  assert.ok(fs.readFileSync(path.join(out, 'standard', 'agent.cordis.yml'), 'utf8').includes(ENTRY))
  // 源目录必须原封不动：它是随包发布的那份，改它等于把本机状态写进产物。
  assert.ok(fs.readFileSync(path.join(source, 'standard', 'agent.cordis.yml'), 'utf8')
    .includes("'@deepseek-ai/dsh-tool-ask-user'"), '源预设被就地改掉了')

  // 第二次跑要覆盖而不是叠加：out 里残留上一次的文件会让 roster 读到旧行。
  fs.writeFileSync(path.join(out, 'stale.yml'), 'x: 1\n')
  syncPresetDir(source, out, { 'tool-ask-user': ENTRY })
  assert.equal(fs.existsSync(path.join(out, 'stale.yml')), false, '目标目录没清干净')
})

test('pinInsertedRows 只改 insert 里的 name，patch 行上的 name 是断言不能动', () => {
  const patches = [
    { id: 'directory-picker', disabled: true },
    { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' }] },
    // 这一行的 name 是「断言」：与原名同才会应用，改名等于让整条 patch 被静默跳过。
    { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app', config: { printUrl: false } },
  ]
  const target = '/opt/dsh/node_modules/@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js'
  const pinned = pinInsertedRows(patches, { '@deepseek-ai/dsh-host-directory-picker-browse': target })

  assert.equal(pinned[1].insert[0].name, target)
  assert.equal(pinned[2].name, '@deepseek-ai/dsh-web-app', '断言用的 name 被改掉了')
  assert.deepEqual(pinned[2].config, { printUrl: false })
  // 原数组不能被动到：调用方可能还要按没改过的形态比对。
  assert.equal(patches[1].insert[0].name, '@deepseek-ai/dsh-host-directory-picker-browse')
})
