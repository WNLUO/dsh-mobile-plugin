'use strict'

/**
 * 无头宿主拼 patch 层时的两处修正。抽成独立文件是为了能直接测：host.js 一 import
 * 就 `boot()` 整个 Cordis 宿主，测试碰不得。
 */

/**
 * 摘掉「按裸包名挂载本插件」的 patch 行。
 *
 * `cordis.patch.yml` 里有一行 `- insert: [{ id: dsh-mobile, name: 'dsh-mobile-plugin' }]`，
 * 那是给**桌面端**用的：DSH 的插件管理器把这个包装进
 * `~/.dsh/profiles/<profile>/node_modules`，Loader 从那里按包名解析得到 `lib/index.js`。
 *
 * 无头宿主没有那次安装 —— 插件**就是** Loader 正在跑的那个包，没人把它放进
 * `node_modules` —— 于是这一行解析不到。而 loader 对解析失败**不是**留一条警告，是整棵树
 * 加载失败：
 *
 *   dsh-mobile-plugin: boot failed: Error: dsh-mobile-plugin: plugin tree failed to load:
 *   failed to apply loader entry include (cordis:include): failed to import loader entry
 *   dsh-mobile (dsh-mobile-plugin): Cannot find package 'dsh-mobile-plugin'
 *     code: 'ERR_MODULE_NOT_FOUND'
 *
 * （实测：服务器宿主从引入这一行的提交起就再也起不来了。）宿主自己用绝对路径另插一行
 * `mobile-api` 挂载本插件，所以这一行在这里只有害处。
 *
 * 不改 `cordis.patch.yml` 本身：桌面端还要靠它。只在无头宿主装载前从内存里摘掉。
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
