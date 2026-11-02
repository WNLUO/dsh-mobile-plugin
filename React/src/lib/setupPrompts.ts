/**
 * 「复制给 AI」的那段话（自建中转用）：面板只放一个复制按钮，正文太长，不摆在界面上。
 *
 * 为什么是「委托给对方的 AI」而不是本页给一套完整命令行：装中转要看他手上有什么
 * （有没有服务器、什么系统、有没有域名、nginx 与 80/443 空不空），这些面板一无所知；
 * 写死一套步骤对不上他的机器，反而多一次试错。交给陪他干活的 AI，让它先问清楚再动手。
 *
 * 段子是字典键拼的（跟着界面语言走），技术名词与仓库地址写死。
 */
import { t } from './i18n/index.ts'

/** 中转仓库地址：和面板上其他入口同一份。 */
const REPO = 'https://github.com/WNLUO/dsh-mobile-server'

export function relaySetupPrompt(): string {
  return [
    t('panel.notice.promptIntro'),
    '',
    `${t('panel.notice.promptRepo')}: ${REPO}`,
    '',
    t('panel.notice.promptAsk'),
    '',
    t('panel.notice.promptDo'),
    '',
    t('panel.notice.promptAfter'),
    '',
    t('panel.notice.promptStyle'),
  ].join('\n')
}
