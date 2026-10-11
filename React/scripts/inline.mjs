// vite build 之后把 js/css 塞进 index.html，产出一个自包含的单文件，
// 插件宿主只需要注册一条路由、吐这一个文件。
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'panel')
const htmlPath = join(outDir, 'index.html')
const assetsDir = join(outDir, 'assets')

const escapeScript = text => text.replaceAll('</script', '<\\/script')

// 替换必须走函数形式：bundle 里含有 `$&`、`$'` 这类字面量（esbuild 会把 '$&/' 压成
// 模板字面量），当替换字符串用会被 String.replace 当成替换模式展开，把原始标签重新
// 插进代码中间、并让其中的 </script> 提前闭合脚本，整页退化成可见的源码文本。
const replaceTag = (html, tag, replacement) => {
  const next = html.replace(tag, () => replacement)
  if (next.includes(tag)) throw new Error(`inline: 替换后仍残留标签 ${tag}`)
  return next
}

const assertInlined = html => {
  const closers = html.match(/<\/script/gi)?.length ?? 0
  if (closers !== 1) throw new Error(`inline: 产物里的 </script> 有 ${closers} 个（应为 1 个）`)
  if (html.includes('src="/assets/') || html.includes('href="/assets/')) {
    throw new Error('inline: 产物里仍引用 /assets/，没有内联完')
  }
  return html
}

let html = await readFile(htmlPath, 'utf8')
const files = await readdir(assetsDir).catch(() => [])

for (const name of files) {
  const target = join(assetsDir, name)
  const text = await readFile(target, 'utf8')
  if (name.endsWith('.js')) {
    const tag = html.match(new RegExp(`<script[^>]*src="[^"]*${name}"[^>]*></script>`))
    if (!tag) throw new Error(`inline: 页面里找不到 ${name} 的 script 标签`)
    html = replaceTag(html, tag[0], `<script type="module">${escapeScript(text)}</script>`)
  } else if (name.endsWith('.css')) {
    const tag = html.match(new RegExp(`<link[^>]*href="[^"]*${name}"[^>]*>`))
    if (!tag) throw new Error(`inline: 页面里找不到 ${name} 的 link 标签`)
    html = replaceTag(html, tag[0], `<style>${text}</style>`)
  }
}

await writeFile(htmlPath, assertInlined(html))
await rm(assetsDir, { recursive: true, force: true })
console.log(`inline: 已生成单文件页面 ${htmlPath}（${html.length} 字节）`)
