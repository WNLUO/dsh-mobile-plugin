'use strict'

/**
 * `ask_user_question` 工具必须存在于移动宿主的工具目录里。
 *
 * App 有完整的问题面板，插件的 `lib/mobile/questions.js` 听着 `user-questions/request`
 * 钩子并实现了回答端点 —— 但少了把工具本身挂进工具目录的那一行（预设缺 `tool-ask-user`、
 * package.json 缺依赖），于是模型的工具清单里没有 `ask_user_question`，问题面板永远不出现。
 * 这个测试把预设行、依赖归属、工具身份三处一起钉住。
 *
 * **版本不由本包钉**：这几个官方包互相之间用精确版本咬死，而 `dsh-app-boot` 装载前对不上
 * 的处理是**整行禁用**，不是降级。所以只在 `devDependencies` 留一份**范围**声明（离线测试
 * 与源码树兜底），正式安装不带；预设里的 `name` 是占位，由 `host.js` 启动时换成本次运行时
 * 同代那一份的入口绝对路径。
 *
 * 运行：node --test test/ask-user-tool.test.cjs
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { readWiring } = require('./lib/wiring.cjs')

const PACKAGE_DIR = path.join(__dirname, '..')
const PRESET = path.join(PACKAGE_DIR, 'config', 'agent-presets', 'standard', 'agent.cordis.yml')
const MANIFEST = path.join(PACKAGE_DIR, 'package.json')
const TOOL_NAME = '@deepseek-ai/dsh-tool-ask-user'

const readPresetRows = (source) => {
  // 极简行扫描：preset 文件里的行是 `  - id: x` / `    name: '...'` / `    disabled: true`。
  const rows = []
  let current = null
  for (const line of source.split('\n')) {
    const id = line.match(/^\s*-\s+id:\s*(\S+)\s*$/)
    if (id) {
      current = { id: id[1], name: null, disabled: false }
      rows.push(current)
      continue
    }
    if (!current) continue
    const name = line.match(/^\s+name:\s*'([^']+)'\s*$/)
    if (name) current.name = name[1]
    if (/^\s+disabled:\s*true\s*$/.test(line)) current.disabled = true
  }
  return rows
}

test('preset 的 standard 工具目录里挂上了 ask_user_question 工具', () => {
  const rows = readPresetRows(fs.readFileSync(PRESET, 'utf8'))
  const row = rows.find((entry) => entry.name === TOOL_NAME)
  assert.ok(row, `agent.cordis.yml 缺少 name: '${TOOL_NAME}' 的行，工具不会被加载`)
  assert.equal(row.id, 'tool-ask-user', '该行的 id 应为 tool-ask-user')
  assert.equal(row.disabled, false, '该行不得被 disabled，否则工具不会出现在工具目录里')
})

test('package.json 不再把该工具包钉进 dependencies', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const deps = manifest.dependencies || {}
  assert.equal(deps[TOOL_NAME], undefined,
    `${TOOL_NAME} 一旦进 dependencies 就是把某一代钉死在发布物里：换一代 DSH 就整行被禁用`);
  const dev = (manifest.devDependencies || {})[TOOL_NAME]
  assert.ok(dev, `${TOOL_NAME} 应留在 devDependencies（离线测试与源码树兜底）`)
  assert.match(dev, /^[\^~]/, `${TOOL_NAME} 的 dev 声明应是范围而非精确版本，收到 ${dev}`)
})

test('host.js 启动时把预设里的工具行换成本次运行时的入口', () => {
  const host = fs.readFileSync(path.join(PACKAGE_DIR, 'host.js'), 'utf8')
  assert.match(host, /syncPresetDir\(/, 'host.js 没同步预设副本，preset 里的 name 会一直按裸名解析')
  assert.match(host, /evaluatePluginCompatibility\(/,
    '判据必须用 dsh-app-boot 自己导出的那份，自己写一套 semver 会与装载预检分叉')
  assert.match(host, /pinInsertedRows\(/, '目录浏览那一行同样要换成同代入口')
})

test('已安装的工具包确实导出 ask_user_question 且注入 userQuestions', () => {
  const entry = path.join(PACKAGE_DIR, 'node_modules', TOOL_NAME, 'lib', 'index.js')
  assert.ok(fs.existsSync(entry), `${TOOL_NAME} 未安装到 node_modules，宿主启动时会解析失败`)
  const source = fs.readFileSync(entry, 'utf8')
  assert.match(source, /name:\s*"ask_user_question"/, '工具名必须是 ask_user_question')
  assert.match(source, /inject\s*=\s*\[[^\]]*"tools"/, '工具必须注入 tools')
  assert.match(source, /inject\s*=\s*\[[^\]]*"userQuestions"/, '工具必须注入 userQuestions（问题面板那条 seam）')
})

/**
 * `present` 是**同一类**坑：手机这份 preset 里一直缺这一行。
 *
 * 后果不是「交付卡丑一点」，而是**完全没有交付卡** —— 模型在手机上根本没有「把文件交给
 * 用户」这个动作，只能写完文件什么也不说；App 那边就退化成「从 write/edit 反推」，于是
 * 每改一次都冒一张卡、而用命令行改出来的一张都没有。
 *
 * 版本同样跟着运行时走（见文件头）：`present` 要 `dsh-agent` 恰好同代，对不上时
 * `dsh-app-boot` 会整行禁用，模型只会说「没有这个工具」。预设里那一行的 `name` 是占位，
 * 由宿主启动时换成本次运行时的入口。
 */
test('preset 的 standard 工具目录里挂上了 present 工具', () => {
  const rows = readPresetRows(fs.readFileSync(PRESET, 'utf8'))
  const row = rows.find((entry) => entry.name === '@deepseek-ai/dsh-tool-present')
  assert.ok(row, `agent.cordis.yml 缺少 name: '@deepseek-ai/dsh-tool-present' 的行`)
  assert.equal(row.id, 'tool-present', '该行的 id 应为 tool-present')
  assert.equal(row.disabled, false, '该行不得被 disabled')
})

test('present 与 ask-user 的依赖归属一致：都不进 dependencies', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const deps = manifest.dependencies || {}
  const dev = manifest.devDependencies || {}
  const present = '@deepseek-ai/dsh-tool-present'
  assert.equal(deps[present], undefined, `${present} 不许进 dependencies（钉死一代的坑与 ask-user 同源）`)
  assert.ok(dev[present], `${present} 应留在 devDependencies（离线测试与源码树兜底）`)
  // 两条曾经按精确版本钉过；同一代运行时下两者应一致 —— 一个 0.2.0 一个 0.2.1 时，
  // 低的那一代会被兼容检查整行禁用，而现象只是「工具不见了」。现在同理：两个都是范围，
  // 少写一个就等于让那份兜底悄悄落后。
  assert.match(dev[present], /^[\^~]/, `${present} 的 dev 声明应是范围而非精确版本，收到 ${dev[present]}`)
})

test('已安装的 present 工具确实叫 present 且注入 sessionProjections', () => {
  const entry = path.join(PACKAGE_DIR, 'node_modules', '@deepseek-ai', 'dsh-tool-present', 'lib', 'index.js')
  assert.ok(fs.existsSync(entry), 'dsh-tool-present 未安装到 node_modules，宿主启动时会解析失败')
  const source = fs.readFileSync(entry, 'utf8')
  assert.match(source, /name:\s*"present"/, '工具名必须是 present')
  assert.match(source, /inject\s*=\s*\[[^\]]*"sessionProjections"/, '它靠 sessionProjections 读 turnBoundary')
  assert.match(source, /deliverables\/presented/, '成功落定后必须追加 deliverables/presented 事件')
})

test('插件的回答端点仍然存在（工具产出的 rpcId 要有地方回传）', () => {
  const index = readWiring()
  assert.match(index, /\/api\/mobile\/v1\/question\/respond/, '插件缺少 question/respond 路由')
  const questions = fs.readFileSync(path.join(PACKAGE_DIR, 'lib', 'mobile', 'questions.js'), 'utf8')
  assert.match(questions, /handleQuestionRespond/, 'questions.js 缺少 handleQuestionRespond')
})
