// 外壳在进程启动时加载了哪些文件：顺着入口的真实引用算出来，不靠手写清单。
/**
 * 「外壳换不掉」只取决于 Node 在启动时缓存了哪些模块，所以这份清单必须从引用关系里算。
 *
 * 手写的那份一定会落后：少一个文件，那一版更新就会**静默不生效**（界面说「已是最新」、
 * 跑着的还是旧代码），多一个文件则会每次开面板都劝人重启。更新面板的「要不要重启」与开发
 * 脚本的「这次动了外壳没有」都从这里取，两处不再各记一套。
 *
 * 只跟相对引用走（`from './x'`、`import('./x')`、`require('./x')`），第三方包不算：它们装在
 * 包里自己的 node_modules，换代时整棵树不动。
 */

import fs from 'node:fs'
import path from 'node:path'

const ENTRY = 'lib/index.js'
/** 三种相对引用写法。`from` 那条覆盖 `import … from` 与 `export … from`，第二条是 `import './x'` 这种只求副作用的写法。 */
const REFS = [
  /from\s*['"](\.[^'"]+)['"]/g,
  /import\s*['"](\.[^'"]+)['"]/g,
  /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
]

/** 引用写法可能省扩展名或指向目录：按 Node 的次序试一遍，取第一个真的存在的。 */
function resolveFile(dir, spec) {
  const base = path.resolve(dir, spec)
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // 不存在就试下一个。
    }
  }
  return null
}

/**
 * 这份包里外壳实际加载的文件（相对包根、正斜杠、排好序）。
 *
 * 入口不在（老一代、装坏了、`--only` 拷了一半）时返回空数组：调用方据此说「算不出指纹」，
 * 而不是拿一份残缺清单去比。
 */
export function shellFiles(pkgDir) {
  if (!pkgDir) return []
  const root = path.resolve(pkgDir)
  const entry = path.join(root, ENTRY)
  try {
    if (!fs.statSync(entry).isFile()) return []
  } catch {
    return []
  }
  const seen = new Set()
  const pending = [entry]
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let source
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const pattern of REFS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(source))) {
        const hit = resolveFile(path.dirname(file), match[1])
        if (hit && hit.startsWith(`${root}${path.sep}`)) pending.push(hit)
      }
    }
  }
  return [...seen].map(file => path.relative(root, file).split(path.sep).join('/')).sort()
}
