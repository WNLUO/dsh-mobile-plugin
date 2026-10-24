/**
 * 面板里指向站外的固定链接。
 *
 * 每一条都在两处以上出现（引导页底部那一排、配对卡底部那一排），各写一份迟早会只改掉其中一处 ——
 * 「一处点了能下、另一处点了 404」正是这么来的。
 */

/** 一个下载渠道：名字 + 一句话说明它是什么，`url` 是直链。 */
export type DownloadChannel = {
  /** 品牌名，原样显示（GitHub / App Store / TestFlight 这类商标不翻）。 */
  name?: string
  /** 描述性名字的字典键；`name` 有值时忽略它。 */
  nameKey?: string
  /** 只写「怎么来的、适合谁」，别写安装步骤——面板不是手册。这一格是字典键。 */
  hintKey: string
  url: string
}

/**
 * 平台用稳定 id，不用翻译过的字。
 *
 * 判据不能建立在文案上：`platform === '安卓'` 这种写法在界面翻成日文之后永远为假
 * （这是 `device-online.ts` 那边踩过的同一个坑，见 App 的 `directChannelKind`）。
 */
export type DownloadPlatform = 'android' | 'apple'

/**
 * 「下载 APP」弹窗里的四条渠道，按平台分两组。
 *
 * 分组不能省：安卓包装不进 iPhone，反过来也是，先报平台再报来源才不会让人点错。组内
 * 顺序按「多数人要走的那条」排前面 —— 安卓是分发平台、苹果是 App Store，后面那条是给
 * 「想拿更早 / 更新的构建」的人的备用来源。
 */
export const DOWNLOAD_CHANNELS: { platform: DownloadPlatform; channels: DownloadChannel[] }[] = [
  {
    platform: 'android',
    channels: [
      {
        nameKey: 'panel.links.distPlatform',
        hintKey: 'panel.links.domesticRecommended',
        url: 'https://app.wnluo.com/public/apps/14',
      },
      {
        name: 'GitHub',
        hintKey: 'panel.links.overseasRecommended',
        url: 'https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk',
      },
    ],
  },
  {
    platform: 'apple',
    channels: [
      {
        name: 'App Store',
        hintKey: 'panel.links.appStore',
        url: 'https://apps.apple.com/cn/app/ai-hub/id6821681438',
      },
      {
        name: 'TestFlight',
        hintKey: 'panel.links.testFlight',
        url: 'https://testflight.apple.com/join/4fn5PCMD',
      },
    ],
  },
]

/**
 * 公用中转的入口清单。
 *
 * 引导页与中转配置弹窗**都从这里渲染**，各写一份必然漏掉一处，表现是「引导页能用、
 * 弹窗里填的是旧地址」——用户当场就能撞上。
 *
 * **加一台就在末尾加一行**，界面两处自动跟上（列表会滚动）。`url` 必须能应答
 * `/healthz`，`name` 只在界面上显示。
 */
export const PUBLIC_RELAYS: { nameKey: string; url: string }[] = [
  { nameKey: 'panel.links.publicRelay', url: 'https://ai-hub-de-1.wnluo.com' },
]

/** 列表里的第一条：没有任何偏好时的默认选择。 */
export const PUBLIC_RELAY_URL = PUBLIC_RELAYS[0].url
