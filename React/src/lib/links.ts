/**
 * 面板里指向站外的固定链接。
 *
 * 每一条都在两处以上出现（引导页第一页、配对卡），各写一遍迟早会只改掉其中一处 ——
 * 「一处点了能下、另一处点了 404」正是这么来的。
 */

/** 手机 App 的下载入口（官网首页，上面有 App Store / Android / TestFlight 三条路）。第一次装的人得先有 App 才能扫码。 */
export const APP_DOWNLOAD_URL = 'https://ai-hub.wnluo.com/'

/**
 * 公用中转的入口清单。
 *
 * 引导页与中转配置弹窗**都从这里渲染**，各写一份必然漏掉一处，表现是「引导页能用、
 * 弹窗里填的是旧地址」——用户当场就能撞上。
 *
 * **加一台就在末尾加一行**，界面两处自动跟上（列表会滚动）。`url` 必须能应答
 * `/healthz`，`name` 只在界面上显示。
 */
export const PUBLIC_RELAYS: { name: string; url: string }[] = [
  { name: '公用中转 1', url: 'https://ai-hub-de-1.wnluo.com' },
]

/** 列表里的第一条：没有任何偏好时的默认选择。 */
export const PUBLIC_RELAY_URL = PUBLIC_RELAYS[0].url
