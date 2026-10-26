'use strict'

/**
 * 让「官方工具行」跟着运行时换代，而不是跟着本包发版那一刻。
 *
 * 提问工具、交付文件工具、目录浏览后端这三个包互相用精确版本咬死，而 `dsh-app-boot` 在
 * 装载前拿每一行跟运行时对一遍——对不上就整行禁用，现象是手机上「模型说没有这个工具」。
 * 所以启动时先问运行时那棵树要同代的那一份，拿到就把行的 `name` 换成它的入口绝对路径，
 * 绕开按裸名解析；拿不到就保持原样，让官方检查去禁用并打印原因。
 *
 * 这里只放纯函数：`host.js` 一 import 就 `boot()` 整个宿主，测试碰不得。
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * 预设里那两行的 id 与包名。
 *
 * 两个都要：都是官方工具、都精确咬版本、都不在 `dsh-web-app` 的预设里，漏掉一个对应
 * 能力就会同样安静地消失。
 */
const TOOL_ROWS = Object.freeze([
  Object.freeze({ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }),
  Object.freeze({ id: 'tool-present', name: '@deepseek-ai/dsh-tool-present' }),
])

/** 无头宿主里被钉成 browse 的目录选择后端；同样精确咬版本。 */
const DIRECTORY_PICKER_ROW = Object.freeze({
  id: 'directory-picker-browse',
  name: '@deepseek-ai/dsh-host-directory-picker-browse',
})

const ROW_ID = /^(\s*)-\s+id:\s*(\S+)\s*$/
const ROW_NAME = /^(\s+)name:\s*'([^']+)'\s*$/

/**
 * 把 `- id: <id>` 紧跟着的那个 `name:` 换成给定值。
 *
 * 逐行扫而不是解析 YAML 再序列化：这份预设带着大量解释性注释，解析再写回会把它们和
 * 空行全洗掉。只认「上一行是目标 id」的 name，同一个包名出现在别处不会被误伤。
 *
 * @param {string} source 预设文件内容
 * @param {Record<string, string>} targets 行 id → 新的 name（入口绝对路径）
 * @returns {{ text: string, changed: string[] }}
 */
function rewriteToolNames(source, targets) {
  const changed = []
  let currentId = null
  const text = source
    .split('\n')
    .map(line => {
      const id = ROW_ID.exec(line)
      if (id) {
        currentId = id[2]
        return line
      }
      if (currentId === null) return line
      const name = ROW_NAME.exec(line)
      if (!name || targets[currentId] === undefined) return line
      if (name[2] === targets[currentId]) return line
      changed.push(currentId)
      // 单引号是 YAML 的转义形式：值里的 ' 要写成 ''。
      return `${name[1]}name: '${targets[currentId].replace(/'/g, "''")}'`
    })
    .join('\n')
  return { text, changed }
}

/**
 * 把预设目录同步一份到 `outDir`，并把目标行换成本次运行时的入口。
 *
 * 每次启动都重写：两份 yml 加起来不到 8KB，而「只在变化时写」要多记一份状态，就多一处
 * 能不一致的地方。
 *
 * @param {string} presetDir 包内 `config/agent-presets`
 * @param {string} outDir 宿主可写的目标目录
 * @param {Record<string, string>} targets 行 id → 入口绝对路径
 * @returns {string} 真正该交给 `agent-presets` roots 的目录
 */
function syncPresetDir(presetDir, outDir, targets) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.cpSync(presetDir, outDir, { recursive: true })
  if (Object.keys(targets).length === 0) return outDir
  for (const entry of fs.readdirSync(outDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yml')) continue
    const file = path.join(entry.parentPath ?? entry.path, entry.name)
    const { text, changed } = rewriteToolNames(fs.readFileSync(file, 'utf8'), targets)
    if (changed.length > 0) fs.writeFileSync(file, text)
  }
  return outDir
}

/**
 * 把 patch 层里命中目标的 `name` 换成入口绝对路径。
 *
 * 只改 `insert` 里的行：其它形态的 `name` 是断言，与原名相同才会应用，改它等于让整条
 * patch 被静默跳过。
 *
 * @param {Array} patches 已加载的 patch 层
 * @param {Record<string, string>} targets 包名 → 入口绝对路径
 * @returns {Array} 新数组，不改原对象
 */
function pinInsertedRows(patches, targets) {
  const swap = (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const next = targets[row.name] === undefined ? row : { ...row, name: targets[row.name] }
    if (Array.isArray(next.insert)) return { ...next, insert: next.insert.map(swap) }
    return next
  }
  return patches.map(swap)
}

module.exports = {
  TOOL_ROWS,
  DIRECTORY_PICKER_ROW,
  rewriteToolNames,
  syncPresetDir,
  pinInsertedRows,
}
