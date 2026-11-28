// 2026-11-28：下载渠道按界面语言排序，海外界面把 GitHub 放前面。
/**
 * 面板里指向站外的固定链接。
 *
 * 每一条都在两处以上出现（引导页底部那一排、配对卡底部那一排），各写一份迟早会只改掉其中一处 ——
 * 「一处点了能下、另一处点了 404」正是这么来的。
 *
 * 2026-11-21：赞助弹窗加「爱发电」，链接也归这一处（和 App 被撤掉的那版赞助页用同一个主页）。
 */

/**
 * 爱发电主页：赞助弹窗里「去爱发电」那颗按钮只跳到这里。
 *
 * 只到主页、不带方案 ID 或下单参数：用户过去自己选档位付，面板不接 API、不绑订单、不给权益，
 * 与官网赞助页的口径一致；也不内嵌网页，开系统浏览器就好。
 */
export const AFDIAN_URL = 'https://ifdian.net/a/AI-HUB'

/**
 * 自建中转那套东西的仓库（中转本体 + 部署说明）。
 *
 * 引导页的「GitHub 仓库」与配对卡底部的「自建网络」指向的是同一个地方：两处都是
 * 「想自己搭一台中转？东西在这儿」。改地址只改这一行。
 */
export const RELAY_REPO_URL = 'https://github.com/WNLUO/dsh-mobile-server'

/**
 * 插件自己的仓库（面板右下角那颗「给个 Star」指向这里）。
 *
 * 与上面那条不是同一个仓库：那条是「中转本体 + 部署说明」，这条是插件与 App 的源码仓库。
 * 求 star 求的是这条 —— 仓库页一打开，右上角那颗 Star 就在原地。
 */
export const PLUGIN_REPO_URL = 'https://github.com/WNLUO/dsh-mobile-plugin'

/**
 * 苹果测试版的 TestFlight 邀请链接。
 *
 * 唯一消费：下载渠道弹窗里的「TestFlight」那条。改地址只改这一行。
 */
export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/4fn5PCMD'

/** 一个下载渠道：名字 + 一句话说明它是什么，`url` 是直链。 */
export type DownloadChannel = {
  /** 品牌名，原样显示（GitHub / App Store / TestFlight 这类商标不翻）。 */
  name?: string
  /** 描述性名字的字典键；`name` 有值时忽略它。 */
  nameKey?: string
  /** 只写「怎么来的、适合谁」，别写安装步骤——面板不是手册。这一格是字典键。 */
  hintKey: string
  url: string
  /** 只在这条渠道明确适合某一边时填；排序把匹配的那条提前，没填的保持原顺序。 */
  preferredRegion?: 'cn' | 'global'
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
        url: 'https://app.wnluo.com/api/public/apps/14/download-latest',
        preferredRegion: 'cn',
      },
      {
        name: 'GitHub',
        hintKey: 'panel.links.overseasRecommended',
        url: 'https://github.com/WNLUO/dsh-mobile-plugin/releases/latest/download/ai-hub-android.apk',
        preferredRegion: 'global',
      },
    ],
  },
  {
    platform: 'apple',
    channels: [
      {
        name: 'App Store',
        hintKey: 'panel.links.appStore',
        // 走官网的地区跳转入口：不带地区的 apps.apple.com/app/id… 在桌面浏览器会被苹果
        // 转到门店首页（Today 页），海外与国内的门店也不同，交给那一页按访问者地区落。
        url: 'https://ai-hub.wnluo.com/ios',
      },
      {
        name: 'TestFlight',
        hintKey: 'panel.links.testFlight',
        url: TESTFLIGHT_URL,
      },
    ],
  },
]

/**
 * 按界面语言排渠道：中文把国内分发平台放前，其余语言把 GitHub 放前。
 * 四条都照常显示、苹果那组顺序不动 —— 只改真正有地区偏好的那两条。
 */
export function downloadChannels(language: string): typeof DOWNLOAD_CHANNELS {
  const preferred: DownloadChannel['preferredRegion'] = language === 'zh-Hans' || language === 'zh-Hant' ? 'cn' : 'global'
  return DOWNLOAD_CHANNELS.map((group) => ({
    ...group,
    channels: [...group.channels].sort((a, b) => Number(b.preferredRegion === preferred) - Number(a.preferredRegion === preferred)),
  }))
}
