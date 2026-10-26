'use strict'

/**
 * 无头宿主拼 patch 层时的两处修正。抽成独立文件是为了能直接测：host.js 一 import
 * 就 `boot()` 整个 Cordis 宿主，测试碰不得。
 */

/**
 * 摘掉「按裸包名挂载本插件」的 patch 行。
 *
 * `cordis.patch.yml` 里那行 `insert: [{ id: dsh-mobile, name: 'dsh-mobile-plugin' }]` 是
 * 给桌面端用的：插件管理器把包装进 profile 的 `node_modules`，Loader 从那里按包名解析。
 * 无头宿主没有那次安装，解析不到包名时 loader 会让整棵插件树加载失败，而不是留一条警告。
 * 宿主自己用绝对路径另插一行 `mobile-api`，所以这行在这里只有害处。
 *
 * 不改 `cordis.patch.yml` 本身（桌面端还要靠它），只在无头宿主装载前从内存里摘掉。
 *
 * @param {Array} patches 已加载的 patch 层（loadOverlayPatches 的返回值）
 * @param {string} binName 本插件的包名
 * @returns {Array} 新数组；空的 insert 壳会被整条去掉
 */
function dropBareNameSelfMounts(patches, binName) {
  return patches.flatMap((patch) => {
    if (!patch || !Array.isArray(patch.insert)) return [patch]
    const kept = patch.insert.filter((row) => !(row && typeof row === 'object' && row.name === binName))
    if (kept.length === patch.insert.length) return [patch]
    const rest = { ...patch }
    delete rest.insert
    // 整条 patch 就只剩这一行时，连壳一起去掉（空 insert 合法但没有意义）。
    if (kept.length > 0) return [{ ...rest, insert: kept }]
    return Object.keys(rest).length > 0 ? [rest] : []
  })
}

module.exports = { dropBareNameSelfMounts }
