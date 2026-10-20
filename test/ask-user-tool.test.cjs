'use strict'

/**
 * `ask_user_question` 工具必须存在于移动宿主的工具目录里。
 *
 * 背景：App 有完整的问题面板（`app/src/hooks/useChatStream.ts:246` 的
 * `question/requested` → `app/src/components/UserQuestionDock.tsx` →
 * `respondQuestion`），插件的 `lib/mobile/questions.js` 听着 `user-questions/request`
 * 钩子（0.2.x 的形状）并实现了回答端点 —— 但**没有任何一行把工具本身挂进工具目录**：
 * `config/agent-presets/standard/agent.cordis.yml` 缺 `tool-ask-user` 行，
 * `package.json` 也缺 `@deepseek-ai/dsh-tool-ask-user` 依赖。
 *
 * 后果是模型的工具清单里没有 `ask_user_question`，于是它只会回一句
 * 「there's no `ask_user_question` tool available in this session」，
 * 问题面板永远不会出现。这个测试把三处一起钉住：依赖、preset 行、工具身份。
 *
 * 为什么这条依赖**必须留在 dependencies**（别再当冗余清掉）：
 * 这份 preset 是**本包自带的**（`host.js` 把 agent-presets 的根指到本包
 * `config/agent-presets`），它按裸名解析 `@deepseek-ai/dsh-tool-ask-user` 时会落到
 * **本包自己的 node_modules**——所以本包不安一份，这一行就解析失败、工具静默消失。
 *
 * 版本号必须**精确钉在运行时那一代**（当前运行时 0.2.0-rc.2，所以钉 0.2.0-rc.2）。
 * 这个包的 peerDependencies 是逐版本紧咬的（0.1.1-rc.2 要 `dsh-agent ^0.1.1-rc.2`，
 * 0.2.0-rc.2 要 `dsh-agent 0.2.0-rc.2`），而 `dsh-app-boot` 的装载检查只要遇到
 * 对不上的 peer 就**整行禁用**——不是降级，是不加载。现象正是上面那句「没有这个工具」，
 * 只剩一行 `disabling profile plugin row "tool-ask-user"` 的启动日志。运行时抬代时
 * 这里要跟着抬，否则同样的静默失效会再来一次。
 *（旧运行时 0.1.x 那一侧已不再支持：本包现在只跟 0.2.x。）
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

test('package.json 依赖里声明了该工具包（preset 从本包自己的树解析）', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const version = manifest.dependencies && manifest.dependencies[TOOL_NAME]
  assert.ok(version, `package.json dependencies 缺少 ${TOOL_NAME}，preset 行会解析失败`)
  assert.match(version, /^\d+\.\d+\.\d+/, `${TOOL_NAME} 的版本应是精确版本，收到 ${version}`)
})

test('已安装的工具包确实导出 ask_user_question 且注入 userQuestions', () => {
  const entry = path.join(PACKAGE_DIR, 'node_modules', TOOL_NAME, 'lib', 'index.js')
  assert.ok(fs.existsSync(entry), `${TOOL_NAME} 未安装到 node_modules，宿主启动时会解析失败`)
  const source = fs.readFileSync(entry, 'utf8')
  assert.match(source, /name:\s*"ask_user_question"/, '工具名必须是 ask_user_question')
  assert.match(source, /inject\s*=\s*\[[^\]]*"tools"/, '工具必须注入 tools')
  assert.match(source, /inject\s*=\s*\[[^\]]*"userQuestions"/, '工具必须注入 userQuestions（问题面板那条 seam）')
})

test('插件的回答端点仍然存在（工具产出的 rpcId 要有地方回传）', () => {
  const index = readWiring()
  assert.match(index, /\/api\/mobile\/v1\/question\/respond/, '插件缺少 question/respond 路由')
  const questions = fs.readFileSync(path.join(PACKAGE_DIR, 'lib', 'mobile', 'questions.js'), 'utf8')
  assert.match(questions, /handleQuestionRespond/, 'questions.js 缺少 handleQuestionRespond')
})
