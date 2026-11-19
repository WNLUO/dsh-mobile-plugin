/**
 * 异常提示入口：标签右边一颗红色感叹号，点开看全文，还能一键复制发给别人。
 *
 * 面板正文里不铺长篇报错——那会把卡片撑高、把别的行挤歪。所有「出了问题」的状态都收成
 * 这一个小入口：没问题时它不渲染，有问题时才出现在该行标签的右侧（跟着标题左对齐）。
 * 文案全走字典，详情原文一字不改地可复制，方便用户直接贴过来报障。
 */
import { Button } from '@appica/ui-react/button'
import { CopyButton } from '@appica/ui-react/copy-button'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@appica/ui-react/dialog'
import { useState } from 'react'

import { t } from '../lib/i18n/index.ts'
import { useNotify } from '../lib/notify.ts'
import { InfoMark } from './InfoMark.tsx'

export type Issue = {
  /** 弹窗标题：一般是所在行的标签，已走字典。 */
  title: string
  /** 详情全文，原样可复制。 */
  detail: string
}

export function IssueMark({ issue }: { issue: Issue }) {
  const [open, setOpen] = useState(false)
  const notify = useNotify()
  return (
    <>
      <button
        type="button"
        aria-label={issue.title}
        title={issue.title}
        className="shrink-0 cursor-pointer rounded text-error transition-colors duration-200 hover:text-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        onClick={() => setOpen(true)}
      >
        <InfoMark />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{issue.title}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="whitespace-pre-wrap break-all text-sm leading-6 text-foreground-muted">{issue.detail}</p>
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <CopyButton
              value={issue.detail}
              label={t('panel.common.copy')}
              copiedLabel={t('panel.links.sponsorCopied')}
              size="sm"
              variant="outline"
              onCopyError={() => notify('error', t('panel.onboarding.copiedFailed'))}
            >
              {t('panel.common.copy')}
            </CopyButton>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('panel.common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
