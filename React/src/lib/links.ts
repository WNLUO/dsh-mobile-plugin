/**
 * 面板里指向站外的固定链接。
 *
 * 每一条都在两处以上出现（引导页底部那一排、配对卡底部那一排），各写一份迟早会只改掉其中一处 ——
 * 「一处点了能下、另一处点了 404」正是这么来的。
 */

/** 一个下载渠道：名字 + 一句话说明它是什么，`url` 是直链。 */
export type DownloadChannel = {
  name: string
  /** 只写「怎么来的、适合谁」，别写安装步骤——面板不是手册。 */
  hint: string
  url: string
}

/**
 * 「下载 APP」弹窗里的四条渠道，按平台分两组。
 *
 * 分组不能省：安卓包装不进 iPhone，反过来也是，先报平台再报来源才不会让人点错。组内
 * 顺序按「多数人要走的那条」排前面 —— 安卓是分发平台、苹果是 App Store，后面那条是给
 * 「想拿更早 / 更新的构建」的人的备用来源。
 */
export const DOWNLOAD_CHANNELS: { platform: string; channels: DownloadChannel[] }[] = [
  {
    platform: '安卓',
    channels: [
      {
        name: 'APP 分发平台',
        hint: '国内下载推荐',
        url: 'https://app.wnluo.com/public/apps/14',
      },
      {
        name: 'GitHub',
        hint: '海外下载推荐',
        url: 'https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk',
      },
    ],
  },
  {
    platform: '苹果',
    channels: [
      {
        name: 'App Store',
        hint: '正式版，随系统自动更新',
        url: 'https://apps.apple.com/cn/app/ai-hub/id6821681438',
      },
      {
        name: 'TestFlight',
        hint: '测试版，比商店版先拿到新版本',
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
export const PUBLIC_RELAYS: { name: string; url: string }[] = [
  { name: '公用中转 1', url: 'https://ai-hub-de-1.wnluo.com' },
]

/** 列表里的第一条：没有任何偏好时的默认选择。 */
export const PUBLIC_RELAY_URL = PUBLIC_RELAYS[0].url
