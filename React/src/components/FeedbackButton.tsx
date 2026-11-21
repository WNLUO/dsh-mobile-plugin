// 反馈入口与就地回执共用一个对话框，可在引导页和控制台重新打开。
import { Button } from '@appica/ui-react/button'
import { openFeedbackThread } from '../lib/feedback.ts'
import { t } from '../lib/i18n/index.ts'

export function FeedbackButton({ threadKey, onOpen }: { threadKey?: string; onOpen?: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="px-2" onClick={() => { onOpen?.(); openFeedbackThread(threadKey) }}>
      {t(threadKey ? 'panel.feedback.openThread' : 'panel.feedback.history')}
    </Button>
  )
}
