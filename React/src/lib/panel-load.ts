/** 内嵌页向父窗口报告实际启动状态；文档 load 不代表 React 已完成启动。 */
export function reportPanelState(state: 'ready' | 'error', message = ''): void {
  const root = document.documentElement
  root.setAttribute('data-dshm-panel-state', state)
  if (message) root.setAttribute('data-dshm-panel-error', message)
  else root.removeAttribute('data-dshm-panel-error')
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'dsh-mobile-plugin:panel-state', state, message }, '*')
  }
}
