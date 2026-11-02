/**
 * 右栏最上面那块公告：两条，一条是公用中转的插件版本门槛，一条是「想自己搭就自己搭」。
 *
 * ## 为什么是右栏的一张卡，而不是浮在页面外面
 *
 * 它最早浮在内容列左边那条缝里（`position: fixed` + `1500px` 断点），只有特别宽的窗口才看得见。
 * 2026-10-30 用户要求挪到「连接状态」上面、做成同一列里的固定卡：这一列本来就是「这台电脑
 * 现在怎么样」，版本门槛和它说的是同一件事，并排放着比在屏幕边上飘着更容易被读到；顺带
 * 窄屏也不用再整块隐藏 —— 两列并一列时这一列排在最前，手机上滚下来第一张就是它。
 *
 * 引导页不再有这块公告（同一天用户的决定）：这类公告是「进了插件页才需要看」的东西，
 * 配对那一步只需要看得懂二维码。
 *
 * ## 第二条（自建中转）为什么也在这张卡
 *
 * 它原来是配对卡底部一颗「自建网络」按钮（2026-11-02 用户要求撤掉那颗）。那排按钮都是
 * 「点一下发生什么」的动作，而它是一条建议 —— 混在一起读不出它在说什么。公告卡本来就是
 * 「值得知道的事」，两条中间一条分隔线，比另开一张卡或再飘一个浮层都省地方。
 *
 * ## 版式
 *
 * 这一栏只有 340px，卡里每一行都得自己挣位置：版本号那一行不占分隔线、生效条件紧贴在它下面、
 * 正文用同一档 `text-sm` 收尾。正文外面那层 `px-4` 不是随便加的 —— 卡片内容区只自带 `p-2`，
 * 标题在 header 里还有一层 `px-4`，不补这一层，下面几段字会比标题往左错出去一截。
 *
 * ## 号从哪来
 *
 * `MIN_PLUGIN_VERSION` 是版本那条公告**唯一**可变的部分，十门语言的正文都从它取
 * `{version}`。改号只改这一行；改完按面板的规矩重建产物
 * （`cd React && pnpm run build` → `lib/panel/index.html` 是提交物）。
 * 与中转那条真正会拦人的配置（`MIN_PLUGIN_VERSION` 环境变量，见 A4-25）、App 里那条
 * 「插件版本过旧」的提醒，是同一个口径：这里只负责说，拦是它们的事，改值要三处一起。
 *
 * 仓库地址取 `lib/links.ts` 的 `RELAY_REPO_URL`：引导页那颗「GitHub 仓库」用的是同一个。
 */
import { Badge } from '@appica/ui-react/badge'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'

import { useState } from 'react'

import { t } from '../lib/i18n/index.ts'
import { Dot } from './InfoRow.tsx'
import { SetupGuideDialog } from './SetupGuideDialog.tsx'

/** 公用中转要求的最低插件版本。改它 = 改整条公告。 */
const MIN_PLUGIN_VERSION = '0.4.9'

export function NoticeBoard({ lanPort }: { lanPort: number }) {
  // 「搭建教程」开的是方案弹窗（自建中转 / 内网穿透 / 局域网直连），仓库链接在弹窗里。
  const [guideOpen, setGuideOpen] = useState(false)

  return (
    <Card frame="solid">
      {/* 标题下面那段空白由 header 的 p-6 撑着；这一卡内容本来就短，用行内值把底部收回来，
          `className` 压不动同属性的 p-6（同属性谁在样式表里靠后谁赢）。 */}
      <CardHeader style={{ paddingBottom: '0.5rem' }}>
        <CardTitle>{t('panel.notice.title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <section className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-sm text-foreground-muted">{t('panel.notice.versionLabel')}</span>
            <Badge variant="warning" size="sm">
              {`≥ ${MIN_PLUGIN_VERSION}`}
            </Badge>
          </div>

          {/* 生效条件：那枚点装在跟行高一样高的格子里居中摆，才会真的压在**这一行的字**上。
              别改回给点加 `mt-*` —— 行内元素自带行盒，估出来的偏移总差几像素。 */}
          <p className="flex items-start gap-2 text-sm leading-5 text-foreground-muted">
            <span className="flex h-5 shrink-0 items-center">
              <Dot tone="warn" />
            </span>
            <span className="min-w-0">{t('panel.notice.effective')}</span>
          </p>

          <p className="text-sm leading-6 text-foreground-muted">
            {t('panel.notice.body', { version: MIN_PLUGIN_VERSION })}
          </p>
        </section>

        {/* 一条建议，不是动作：教程链接挂在标题那一行右侧，与上面那条公告的「≥ 版本」同一种排法。 */}
        <section className="flex flex-col gap-1.5 border-t border-border-muted pt-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 className="text-sm font-medium text-foreground-strong">{t('panel.notice.selfHostTitle')}</h3>
            <button
              type="button"
              className="cursor-pointer text-sm text-foreground-intense underline underline-offset-2 hover:text-foreground-strong"
              onClick={() => setGuideOpen(true)}
            >
              {t('panel.notice.selfHostAction')}
            </button>
          </div>
          <p className="text-sm leading-6 text-foreground-muted">{t('panel.notice.selfHostBody')}</p>
        </section>
      </div>

      <SetupGuideDialog open={guideOpen} onOpenChange={setGuideOpen} port={lanPort} />
    </Card>
  )
}
