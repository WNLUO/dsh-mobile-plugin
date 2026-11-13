/**
 * 被嵌在 DSH 那一窗里时，「现在看不看得见」由父窗口说了算。
 *
 * 桌面端点手机图标弹出的那一窗**收起时不销毁**（见 `lib/client.js` 的 `hide`）：那一页是
 * 一份 1.4MB 的单文件产物，销毁掉下次打开就得整份重新解析、React 重新挂载一遍（实测每次
 * 多花七百来毫秒）。留着它，再打开就是热的。
 *
 * 代价是那一页仍然挂在 DOM 上、页内几个轮询也还在跑 —— 而用户说的「关掉窗口就恢复正常」
 * 正是靠「关掉之后它真的不动了」维持的。所以父窗口收起时会 `postMessage` 过来，这一层把
 * 它接成 `document.hidden` 的补充判据：页面里那些轮询本来就都在看 `document.hidden`，
 * 统一从这里问一句即可，不必每个组件各接一个监听。
 *
 * 单独在浏览器里打开（没有父窗口在发这条消息）时，行为与以前完全一样：只看 `document.hidden`。
 */

const MESSAGE_TYPE = 'dsh-mobile-plugin:panel-visibility'

/** 父窗口说「收起来了」时为 false；没收到过消息就是 null（照旧按 `document.hidden` 判）。 */
let visibleFromParent: boolean | null = null

/**
 * 现在这一刻值不值得跑轮询。
 *
 * 标签页在后台（`document.hidden`）或者父窗口已经把它收起来，都算看不见。
 * 页面里每一处 `if (document.hidden) return` 都换成问这个函数 —— 判据只有一份。
 */
export function pageVisible(): boolean {
  if (visibleFromParent === false) return false
  return typeof document === 'undefined' ? true : !document.hidden
}

/**
 * 开始听父窗口那两句话。返回撤销函数。
 *
 * 只在被嵌（`window.parent !== window`）时才挂监听：顶层页面上没人会发这条消息。
 */
export function watchEmbedVisibility(): () => void {
  if (typeof window === 'undefined' || window.parent === window) return () => {}
  const onMessage = (event: MessageEvent) => {
    const data = event && event.data
    if (!data || typeof data !== 'object' || data.type !== MESSAGE_TYPE) return
    visibleFromParent = data.visible === true
  }
  window.addEventListener('message', onMessage)
  return () => {
    window.removeEventListener('message', onMessage)
    visibleFromParent = null
  }
}
