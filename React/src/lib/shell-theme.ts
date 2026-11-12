/**
 * 这一页的日夜主题：**跟着 DSH 走**，而不是跟着系统走。
 *
 * 这一页最常出现的地方是桌面端那颗手机图标弹出来的那一窗（同源 iframe）。用户在那边的
 * 设置里选了夜间，这边还亮着白底，看起来像是另一个应用。而 `dsh-app://app` 与面板页
 * 同源，所以父窗口的 DOM 读得到：DSH 把深色记号写在 `<body data-ds-dark-theme>` 上，
 * 把来源写在 `<html data-ds-theme-source>` 上（见 `@deepseek-ai/dsh-client-ui-theme`
 * 的 presenter）。
 *
 * 三种环境，一条判据链：
 *  1. 被嵌在同源窗口里 → 照父窗口那两处记号算，并盯着它们变（用户在 DSH 里切主题，
 *     这一页当帧跟着换，不用刷新）；
 *  2. 单独在浏览器里打开（没有父窗口 / 跨源读不到）→ 跟随系统 `prefers-color-scheme`；
 *  3. 读不到任何东西 → 保持 light。
 *
 * 只写 `<html>` 上的 `class` 与 `color-scheme`：这两样是 Appica 主题那套 token 的开关，
 * 面板自己的颜色全在 token 上，所以换主题不需要重画任何组件。
 */

import { useEffect, useState } from 'react'

export type ShellTheme = 'light' | 'dark'

const DARK_ATTR = 'data-ds-dark-theme'
const SOURCE_ATTR = 'data-ds-theme-source'

/** 同源父窗口的 document；读不到（跨源 / 顶层窗口）时返回 null。 */
function parentDocument(): Document | null {
  try {
    if (typeof window === 'undefined' || window.parent === window) return null
    const doc = window.parent.document
    return doc && doc.documentElement ? doc : null
  } catch {
    return null
  }
}

/** 父窗口此刻是不是深色：先看 body 的记号，再看 root 上发布的来源。 */
function fromParent(doc: Document): ShellTheme | null {
  const body = doc.body
  if (body) {
    if (body.hasAttribute(DARK_ATTR)) return 'dark'
    // 亮色时 DSH 不写这个属性（有则深、无则浅），所以 body 存在就可以判浅色。
    return 'light'
  }
  const source = doc.documentElement.getAttribute(SOURCE_ATTR)
  if (source === 'dark') return 'dark'
  if (source === 'light') return 'light'
  return null
}

/** 系统偏好（`matchMedia` 不可用的老环境按亮色）。 */
function fromSystem(): ShellTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * 手动选的那一门（`light` / `dark`），没选过是 `null`。
 *
 * 默认**跟着 DSH**（用户 2026-11-13 要求：DSH 里是夜间，这一窗也得是夜间）。但这一窗顶上
 * 也有一颗日夜按钮，人按下去了就得听他的 —— 于是分两层：没手动选过时跟随父窗口，选过之后
 * 手动那份优先。存盘失败（隐私模式）只影响「下次记不记得」，这一次照样当场生效。
 */
const OVERRIDE_KEY = 'dsh-mobile-console-theme'

export function shellThemeOverride(): ShellTheme | null {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(OVERRIDE_KEY)
    return value === 'dark' || value === 'light' ? value : null
  } catch {
    return null
  }
}

/** 记下（或清掉）手动选择，并当场应用。`null` = 回到「跟随 DSH」。 */
export function setShellThemeOverride(theme: ShellTheme | null): void {
  try {
    if (typeof localStorage !== 'undefined') {
      if (theme) localStorage.setItem(OVERRIDE_KEY, theme)
      else localStorage.removeItem(OVERRIDE_KEY)
    }
  } catch {
    /* 存不住不影响这一次。 */
  }
  applyShellTheme(resolveShellTheme())
  for (const listener of listeners) listener()
}

/** 手动选择变了要重画的那些组件（那一颗日夜按钮）。 */
const listeners = new Set<() => void>()

export function subscribeShellTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 当下这一档：手动选过就听手动的，否则跟随父窗口 / 系统。 */
export function resolveShellTheme(): ShellTheme {
  const picked = shellThemeOverride()
  if (picked) return picked
  const doc = parentDocument()
  if (doc) {
    const theme = fromParent(doc)
    if (theme) return theme
  }
  return fromSystem()
}

/** 把这一档挂到自己的 `<html>` 上（两档互斥，`color-scheme` 一起给）。 */
export function applyShellTheme(theme: ShellTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(theme)
  root.style.colorScheme = theme
}

/**
 * 开始跟随：先应用一次，之后父窗口切主题、系统切主题都会再应用。
 *
 * 返回一个撤销函数。观察器只盯两个属性，开销可以忽略；父窗口不可达时退化成系统监听。
 */
export function watchShellTheme(): () => void {
  const apply = () => applyShellTheme(resolveShellTheme())
  apply()

  const disposers: Array<() => void> = []
  const doc = parentDocument()
  if (doc && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(apply)
    observer.observe(doc.body || doc.documentElement, { attributes: true, attributeFilter: [DARK_ATTR] })
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: [SOURCE_ATTR, 'class'] })
    disposers.push(() => observer.disconnect())
  }

  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply()
    media.addEventListener('change', onChange)
    disposers.push(() => media.removeEventListener('change', onChange))
  } catch {
    /* 没有 matchMedia 就不跟系统，静态主题也能用。 */
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * 订阅当前这一档（控制台顶上那颗日夜按钮用）。
 *
 * 三种来源任一变了都要重画：父窗口切主题、系统切主题、自己手动选了一门。
 * 后两种在 `setShellThemeOverride` 里主动通知（见上面的 `listeners`）。
 */
export function useShellTheme(): ShellTheme {
  const [theme, setTheme] = useState<ShellTheme>(() => resolveShellTheme())
  useEffect(() => subscribeShellTheme(() => setTheme(resolveShellTheme())), [])
  return theme
}
