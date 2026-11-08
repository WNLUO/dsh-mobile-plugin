'use strict'

/**
 * 「总管」这档 Agent 预设（config/agent-presets/supervisor）的形状守卫。
 *
 * 为什么单列一条：这一档是随插件包发布的声明，宿主启动时由 `agent-presets` 的 roots
 * 扫目录挂进 roster，**没有运行时接口能读回检它**。改坏了不报错，只是那一档在手机上
 * 要么选不到、要么少了人设 —— 而这两种都会安静地变成「总管不像总管」。
 * 所以这里钉三件事：目录里两份文件都在、人设行是完整系统提示（complete / 无运行时上下文）、
 * 整份组合仍是一套能用的工具树（不是被谁删空了）。
 *
 * 运行：node --test test/supervisor-preset.test.cjs
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const PRESETS_DIR = path.join(__dirname, '..', 'config', 'agent-presets')
const DIR = path.join(PRESETS_DIR, 'supervisor')

// 预设里的 `!!js process.platform ...` 是 Cordis 的表达式标签，解析时当普通字符串收下。
const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }

const readTree = () => YAML.parse(fs.readFileSync(path.join(DIR, 'agent.cordis.yml'), 'utf8'), {
  customTags: [jsTag],
})

test('目录里两份文件都在，preset.yml 有名字', () => {
  assert.ok(fs.existsSync(path.join(DIR, 'agent.cordis.yml')), '缺 agent.cordis.yml')
  const preset = YAML.parse(fs.readFileSync(path.join(DIR, 'preset.yml'), 'utf8'))
  assert.ok(typeof preset?.name === 'string' && preset.name.trim(), 'preset.yml 的 name 不能空')
})

test('人设行是整份系统提示：complete:true 且关掉可选运行时上下文', () => {
  const tree = readTree()
  const persona = tree.find((row) => row && row.id === 'persona')
  assert.ok(persona, '没有 persona 行 —— 这一档就没有自己的身份了')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona', 'persona 行挂错了包')
  assert.equal(persona.config?.complete, true, 'complete 必须是 true（整份系统提示，压掉其余段落）')
  assert.equal(persona.config?.includeRuntimeContext, false, 'includeRuntimeContext 必须是 false')
  const prefix = persona.config?.prefix
  assert.ok(typeof prefix === 'string' && prefix.length > 200, '人设正文太短或缺失，像是被清空了')
  assert.ok(prefix.includes('总管'), '人设正文里必须点明它是「总管」')
  // complete:true 时没有别的段落兜底，说话方式与「不亲自干活」这两条必须写在这段里。
  assert.ok(prefix.includes('不亲自') || prefix.includes('不替项目'), '人设里缺了「不亲自干活」那条')
})

test('整份仍是一套能用的工具树，不是被删空', () => {
  const tree = readTree()
  assert.ok(Array.isArray(tree) && tree.length >= 12, `组合条目太少（${tree?.length}），像被删过`)
  const ids = new Set(tree.map((row) => row && row.id))
  for (const required of ['agent-instructions', 'tool-fs', 'tool-web', 'tool-todo', 'tool-ask-user']) {
    assert.ok(ids.has(required), `缺了基础行 ${required}`)
  }
})

test('和 standard 并排放，宿主扫目录时两档都会被挂上', () => {
  const subs = fs.readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  assert.ok(subs.includes('standard'), 'standard 那档不见了')
  assert.ok(subs.includes('supervisor'), 'supervisor 这档不见了')
  for (const id of ['standard', 'supervisor']) {
    for (const f of ['preset.yml', 'agent.cordis.yml']) {
      assert.ok(fs.existsSync(path.join(PRESETS_DIR, id, f)), `${id} 缺 ${f}`)
    }
  }
})
