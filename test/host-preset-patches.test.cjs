/** 移动 standard 的声明覆盖、旧目录兼容与原生 Include 展开回归。 */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const { mobilePresetPatches } = require('../lib/host-preset-patches.cjs')
const { rewriteToolNames, dropRows, syncPresetDir, pinInsertedRows } = require('../lib/host-compat.cjs')
const ROOT = path.resolve(__dirname, '..')
const sourceDir = path.join(ROOT, 'config/agent-presets')
const declaration = { insert: [{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset',
  config: { id: 'standard', order: 1, plugins: [] } }] }
const registry = { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } }] }
const legacy = { insert: [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard', roots: [] } }] }
const askEntry = '/dsh/runtime/ask-user.js'
const presentEntry = '/dsh/runtime/present.js'
const targets = { 'tool-ask-user': askEntry, 'tool-present': presentEntry }

function declarationContract(implementation) {
  const patches = implementation([registry, declaration], sourceDir)
  assert.equal(patches.length, 1)
  assert.equal(patches[0].id, 'preset-standard', '新版必须覆盖声明，不能写无人消费的 roots')
  assert.equal(patches[0].config.id, 'standard')
  assert.equal(patches[0].config.order, 1)
  assert.equal(patches[0].config.plugins[0].name, 'cordis:include')
  assert.equal(patches[0].config.plugins[0].config.path,
    pathToFileURL(path.join(sourceDir, 'standard/agent.cordis.yml')).href)
}

test('声明版以移动配置覆盖 standard，完整保留声明元数据且不改原对象', () => {
  declarationContract(mobilePresetPatches)
  assert.deepEqual(declaration.insert[0].config.plugins, [])
  const row = { ...declaration.insert[0], config: { ...declaration.insert[0].config, name: 'Standard', description: 'Coding' } }
  assert.equal(mobilePresetPatches([{ insert: [row] }], sourceDir)[0].config.name, 'Standard')
})
test('目录版只按真实旧注册表行供 roots，不给新版 registry 造 roots', () => {
  assert.deepEqual(mobilePresetPatches([legacy], sourceDir), [{ id: 'agent-presets',
    name: '@deepseek-ai/dsh-agent-preset-registry',
    config: { default: 'standard', roots: [{ path: sourceDir, trust: 'system' }] } }])
  assert.throws(() => mobilePresetPatches([registry], sourceDir), /没有可识别/)
})
test('变异证明：声明目标退回旧注册表会被加载契约拒绝', () => {
  const file = require.resolve('../lib/host-preset-patches.cjs')
  const source = fs.readFileSync(file, 'utf8')
  const marker = "id: standard.id,"
  assert.ok(source.includes(marker))
  const module = { exports: {} }
  vm.runInNewContext(source.replace(marker, "id: 'agent-presets',"), { module, exports: module.exports, require: createRequire(file) })
  assert.throws(() => declarationContract(module.exports.mobilePresetPatches), assert.AssertionError)
})
test('宿主把同步副本接到该 helper，沿用同代工具 pin 与旧子入口剔除', () => {
  const host = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8')
  assert.match(host, /layer\.packageName === '@deepseek-ai\/dsh-web-app'/)
  assert.match(host, /mobilePresetPatches\(webLayer\?\.patches \?\? \[\], presetDir\)/)
  assert.match(host, /\.\.\.presetPatches/)
  assert.match(host, /syncPresetDir\(/)
  assert.match(host, /pinInsertedRows\(/)
  const text = fs.readFileSync(path.join(sourceDir, 'standard/agent.cordis.yml'), 'utf8')
  const pinned = rewriteToolNames(dropRows(text, ['tool-subagent-list-agents']), targets).text
  assert.ok(pinned.includes(askEntry) && pinned.includes(presentEntry))
  assert.ok(!pinned.includes("name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'"))
  assert.ok(pinned.includes('./skills/dsh-mobile-kb/SKILL.md'))
  const patch = [{ insert: [{ id: 'browse', name: 'browse' }] }, { id: 'check', name: 'browse' }]
  const result = pinInsertedRows(patch, { browse: '/runtime/browse.js' })
  assert.equal(result[0].insert[0].name, '/runtime/browse.js')
  assert.equal(result[1].name, 'browse')
})

test('变异证明：pin 同时改顶层 name 断言会被原判据拒绝', () => {
  const file = require.resolve('../lib/host-compat.cjs')
  const source = fs.readFileSync(file, 'utf8')
  const marker = `return patches.map(patch => Array.isArray(patch?.insert)
    ? { ...patch, insert: patch.insert.map(swap) }
    : patch)`
  assert.ok(source.includes(marker))
  const module = { exports: {} }
  vm.runInNewContext(source.replace(marker, 'return patches.map(swap)'), { module, exports: module.exports, require: createRequire(file) })
  const check = pin => {
    const result = pin([{ insert: [{ id: 'browse', name: 'browse' }] }, { id: 'check', name: 'browse' }], { browse: '/runtime/browse.js' })
    assert.equal(result[0].insert[0].name, '/runtime/browse.js')
    assert.equal(result[1].name, 'browse')
  }
  check(pinInsertedRows)
  assert.throws(() => check(module.exports.pinInsertedRows), assert.AssertionError)
})

// Electron 的 ASAR 感知运行时能直接加载本机安装包；没有该安装的 CI 只跳过此集成用例。
const nativeRuntime = Boolean(process.versions.electron && process.env.DSH_INSTALL_DIR)
test('rc.5 原生声明与 Include 展开真实移动配置，工具 pin、延迟表达式及 KB baseUrl 均生效', { skip: !nativeRuntime }, async () => {
  const runtime = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
  const load = async (name) => import(pathToFileURL(runtime.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
  const { default: Include, applyEntryPatches } = await load('@deepseek-ai/cordis-plugin-include')
  const { default: Group } = await load('@deepseek-ai/cordis-plugin-group')
  const { default: AgentPreset } = await load('@deepseek-ai/dsh-agent-preset')
  const { default: AgentPresetRegistry } = await load('@deepseek-ai/dsh-agent-preset-registry')
  const { loadOverlayPatches } = await load('@deepseek-ai/dsh-app-boot')
  const webDir = path.dirname(runtime.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const manifest = runtime('@deepseek-ai/dsh-web-app/package.json')
  const webPatches = manifest.dsh.bundle.patch.flatMap(file => loadOverlayPatches('test', path.join(webDir, file)))
  const readCalls = []
  // 沿用 host-compat 的复制真配置方式；临时目录位于仓内，结束后删除本用例自己的副本。
  const fixtureDir = fs.mkdtempSync(path.join(__dirname, '.host-preset-'))
  const outDir = path.join(fixtureDir, 'presets')
  syncPresetDir(sourceDir, outDir, targets, { dropIds: ['tool-subagent-list-agents'] })
  const patches = mobilePresetPatches(webPatches, outDir)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(path.join(ROOT, 'package.json')).href
  // 测试仓没安装整套宿主依赖；官方技能包从当前安装解析，相对 KB 仍走真实副本目录。
  ctx.process = Object.assign(Object.create(process), { getBuiltinModule(name) {
    const builtin = process.getBuiltinModule(name)
    if (name !== 'node:module') return builtin
    return { ...builtin, createRequire(baseUrl) {
      const anchored = createRequire(baseUrl)
      return { resolve: name => name === '@deepseek-ai/dsh-agent-preset/package.json'
        ? runtime.resolve(name) : anchored.resolve(name) }
    } }
  } })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const originalImport = ctx.loader.internal
  ctx.loader.internal = { import: async (name) => {
    if (name === '@deepseek-ai/dsh-agent-preset') return { default: AgentPreset }
    return { default: (child, config) => { readCalls.push({ id: child.fiber.entry.options.id, name, config, baseUrl: child.baseUrl }) } }
  } }
  ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => null }) })
  ctx.provide('agents', {})
  await ctx.plugin(AgentPresetRegistry, { default: 'standard' })
  try {
    const effective = applyEntryPatches([], [...webPatches, ...patches], () => {})
    await ctx.loader.root.update(effective.filter(row => row.id === 'preset-standard'))
    await ctx.loader.await()
    const roster = await ctx.agentPresets.remoteExportList()
    assert.equal(roster.presets.length, 1)
    assert.equal(roster.presets[0].id, 'standard')
    assert.equal(roster.presets[0].broken, undefined, '声明必须成功注册并完成原生子树加载')
    const skills = readCalls.find(row => row.id === 'skill-filesystem')
    assert.ok(skills, '移动 skill-filesystem 必须从 Include 展开')
    assert.equal(skills.baseUrl, pathToFileURL(path.join(outDir, 'standard')).href + '/')
    assert.ok(skills.config.customSkillDirs.includes(path.join(outDir, 'standard/skills')),
      'KB 技能根必须按预设文件所在目录解析')
    assert.ok(readCalls.some(row => row.id === 'tool-ask-user' && row.name === askEntry))
    assert.ok(readCalls.some(row => row.id === 'tool-present' && row.name === presentEntry))
    assert.ok(readCalls.some(row => row.id === (process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash')))
    assert.ok(!readCalls.some(row => row.id === (process.platform === 'win32' ? 'tool-bash' : 'tool-pwsh')),
      'disabled !!js 必须保留到子行激活时再求值')
    assert.ok(!readCalls.some(row => row.id === 'tool-subagent-list-agents'))
    assert.ok(readCalls.some(row => row.id === 'tool-subagent-control'))
    // 对象中的子表达式仍在；真实 Include 激活后才变成技能根路径。
    assert.equal(typeof effective.find(row => row.id === 'preset-standard').config.plugins[0].config.path, 'string')
  } finally {
    ctx.loader.internal = originalImport
    await ctx.fiber.dispose()
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  }
})
