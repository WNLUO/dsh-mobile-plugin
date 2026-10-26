/**
 * 开发机同步收尾的判据：这一轮「装进 profile + 就地重载」到底算不算成功。
 *
 * 同步脚本自己会装完、调一次重载、打一行 ✔ —— 看起来成功。宿主答了 200 就当成功，哪怕
 * 跑着的还是上一代。「热重载了但没生效」有三种都过得了那道判据：
 *
 *  · **装载失败已经回滚**：外壳发现新代起不来，会把上一代装回去（`lib/shell/runtime.js`），
 *    接口回 500 但状态里 `lastError` 记着原因；
 *  · **盘上那份被换回去了**：这份安装声明的是 `file:` 指向某个冻结的 tgz，谁把它重新装一遍，
 *    盘上就退回那个快照的内容，版本号也跟着退；
 *  · **这一轮没落进安装声明**：盘上换了，但 profile 声明的还是旧 tgz —— 重启就退回旧版。
 *
 * 判据要能被守卫直接测，所以和「怎么取这几个版本号」分开：脚本负责取，这里只回答成不成、
 * 以及为什么不成。
 */

/**
 * 这一轮同步算不算数。
 *
 * @param {object} input
 * @param {string|null} input.repoVersion     仓库那一份的版本号
 * @param {string|null} input.diskVersion     装完之后盘上（profile 里）那一份的版本号
 * @param {string|null} input.runningVersion  宿主报的、正在跑的那一代的版本号
 * @param {string|null} input.lastError       宿主这次装载留下的错误（外壳已经回滚过才有）
 * @param {boolean} [input.partial]           `--only` 只推了几个文件：不落安装声明，放宽两条
 * @param {string} [input.declaredSpec]       profile 依赖声明里当前那个 spec
 * @param {string|null} [input.expectedSpec]  整包同步之后声明**应当**是它
 * @returns {{ok: boolean, failures: string[]}}
 */
export function verifyReload({
  repoVersion,
  diskVersion,
  runningVersion,
  lastError,
  partial = false,
  declaredSpec,
  expectedSpec = null,
} = {}) {
  const failures = []

  if (!diskVersion) failures.push('盘上那份没有版本号（安装不完整）：在 profile 里重装一次这个插件，再跑这个脚本。')
  if (!runningVersion) failures.push('宿主没报正在跑的版本：说不清这次生效了没有，别当成功。')

  // 「跑着的 = 盘上的」是唯一能证明重载真的换了代码的证据；两者不同就是宿主手里那一代
  // 与盘上不是同一份（换装换了目录、或者进程里还挂着上一代）。
  if (diskVersion && runningVersion && diskVersion !== runningVersion) {
    failures.push(`跑着的是 ${runningVersion}、盘上是 ${diskVersion}：宿主手里那一代和盘上不是同一份，重启一次 DSH 再跑这个脚本。`)
  }

  // 装载失败时外壳已经回滚，人看到的「版本又是旧的」就是这件事，必须当失败报。
  if (lastError) {
    failures.push(`宿主记了装载错误（${lastError}）：外壳已回滚到上一代，跑着的仍是旧代码。修好原因再跑一次。`)
  }

  // 整包同步之后，profile 的依赖声明必须指着刚装进去那一份，否则重启会把它换回旧快照 ——
  // 这一轮只保到下次重启，那不叫成功。
  if (expectedSpec && declaredSpec !== expectedSpec) {
    failures.push(`profile 的依赖声明是 ${declaredSpec || '(读不到)'}，不是这次装的 ${expectedSpec}：重启会退回旧的一份，这一轮白做。`)
  }

  // `--only` 只推指定的几个文件，盘上 package.json 可能压根没换，那两条判据不成立。
  if (!partial && repoVersion && diskVersion && repoVersion !== diskVersion) {
    failures.push(`盘上是 ${diskVersion}、仓库是 ${repoVersion}：这次没把整包同步过去，别当它生效了。`)
  }

  return { ok: failures.length === 0, failures }
}

/**
 * 开跑前那几行：仓库 / 盘上各是哪一版，以及「盘上为什么是旧的」。
 *
 * `installVersion` 是 profile 的依赖声明里那个冻结 tgz 的版本（`file:dsh-mobile-plugin-0.1.93.tgz`
 * 里的 0.1.93）。盘上正好等于它、又不等于仓库，说明这份开发版已经被那次安装打回去了 ——
 * 报出来的每一行都在解释「为什么界面又是老样子」，省得再去猜是不是自动更新干的。
 *
 * @returns {string[]} 按顺序打印的行
 */
export function describeDrift({ repoVersion, diskVersion, installVersion } = {}) {
  const lines = [`仓库版本：${repoVersion ?? '(读不到)'}    盘上版本：${diskVersion ?? '(读不到)'}`]
  if (repoVersion && diskVersion && repoVersion === diskVersion) return lines

  if (installVersion && diskVersion && installVersion === diskVersion) {
    lines.push(`盘上还是 profile 声明的那个安装包（${installVersion}）里的内容：这份开发版被重装打回过，这次会整包装成仓库这一份、并把声明指过去。`)
  } else if (installVersion && repoVersion && installVersion === repoVersion) {
    lines.push(`盘上与仓库不一致，但都落后/不等同于声明的安装包 ${installVersion}：这次会把盘上装成仓库这一份。`)
  } else {
    lines.push('盘上与仓库不一致：这次会把盘上装成仓库这一份。')
  }
  return lines
}
