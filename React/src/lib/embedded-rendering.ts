/** Android 内嵌控制台建立独立绘制边界，滚动与卡片滤镜在 iframe 内合成。 */
export function prepareEmbeddedRendering(): void {
  if (!/Android/i.test(navigator.userAgent) || window.parent === window) return
  const frame = window.frameElement as HTMLIFrameElement | null
  if (!frame || frame.tagName !== 'IFRAME' || !frame.classList.contains('dshm_frame')) return
  // 只提升承载页面的 iframe，不给页面正文加 transform，页内 fixed 控件仍以视口定位。
  frame.style.transform = 'translateZ(0)'
  frame.style.isolation = 'isolate'
  frame.style.contain = 'paint'
}
