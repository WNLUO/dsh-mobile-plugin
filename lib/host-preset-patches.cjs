/** 按 Web bundle 的真实预设声明选择移动 standard 的挂载方式。 */
'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')

/** 新版声明通过原生 Include 读取移动预设，保留子行表达式和技能目录的 baseUrl。 */
function mobilePresetPatches(webPatches, presetDir) {
  const rows = webPatches.flatMap(patch => patch.insert ?? [])
  const standard = rows.find(row => row.id === 'preset-standard'
    && row.config?.id === 'standard' && Array.isArray(row.config.plugins))
  if (standard) {
    return [{
      id: standard.id,
      name: standard.name,
      config: {
        ...standard.config,
        plugins: [{
          id: 'mobile-standard',
          name: 'cordis:include',
          config: { path: pathToFileURL(path.join(presetDir, 'standard', 'agent.cordis.yml')).href },
        }],
      },
    }]
  }

  // 旧版 Web bundle 的目录注册表仍由宿主提供 roots，不按版本号猜测代际。
  const legacy = rows.find(row => row.id === 'agent-presets'
    && row.name === '@deepseek-ai/dsh-agent-preset-registry')
  if (legacy) {
    return [{
      id: legacy.id,
      name: legacy.name,
      config: { ...legacy.config, default: 'standard', roots: [{ path: presetDir, trust: 'system' }] },
    }]
  }
  throw new Error('DSH Web bundle 没有可识别的 standard 预设声明或目录注册表')
}

module.exports = { mobilePresetPatches }
