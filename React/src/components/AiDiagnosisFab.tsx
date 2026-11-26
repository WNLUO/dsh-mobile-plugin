// 2026-11-26 用户要求：弹窗标题与描述说清「点下去会发生什么」；工作区默认让宿主决定，不显选技术名。
// 2026-11-26 用户要求：问诊胶囊改成白底黑字，原先的 bg-surface 在这块看着是透明的。
/**
 * 面板全局悬浮的 AI 问诊入口：引导页和主页都在，点开选工作区 / 模型，一键发到当前电脑。
 *
 * 只做「选落点 + 发第一句」。排查跑在用户自己的 DSH 里——那边读随插件装的知识库、用
 * dsh_feedback 跟反馈机器人来回。面板这里不复制诊断逻辑，发出去的只是一段开工引导，
 * 让对方 AI 先问清症状、再排查、最后按需反馈；知识库正文不塞进消息里，技能它自己会调。
 *
 * 挂在外壳 `Shell` 上（引导页 / 主页共用那一层），所以两页都在。贴左下角，避开右上角
 * 那组按钮。配色沿用现有 token，不新造视觉语言。
 */
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useEffect, useState } from 'react'

import { apiGet, apiPost, errorText } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'

/**
 * 工作区选项只用到 id / 标题 / 路径三格：`isDefault` 是宿主给后端排序用的，
 * 前端不再据此选中某一项——默认落在第一项「默认工作区」（空 id = 让宿主决定），
 * 免得把宿主内部的技术名（default-workspace）当成用户要选的工作区。
 */
type WorkspaceOption = { workspaceId: string; title: string; path: string; isDefault: boolean }
type ModelOption = { id: string; name: string }
type ModelGroup = { provider: string; displayName: string; models: ModelOption[] }
type Options = {
  ok: boolean
  workspaces: WorkspaceOption[]
  models: ModelGroup[]
  defaultModel: { provider: string; model: string } | null
  error?: { message?: string }
}

/** 面板自己的图标：一个带问号的圆形，纯 CSS 画，不引新依赖。 */
function AskIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" />
      <path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6" strokeLinecap="round" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function AiDiagnosisFab() {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<Options | null>(null)
  const [loadError, setLoadError] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [selection, setSelection] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null)

  // 每次打开重新拉：工作区和模型目录会随用户在 DSH 里改渠道而变，缓存到当下这一帧就够。
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setLoadError('')
    setResult(null)
    void (async () => {
      try {
        const next = await apiGet<Options>('/api/relay/ai-diagnosis/options')
        if (!alive) return
        if (!next.ok) {
          setLoadError(next.error?.message || t('panel.net.requestFailedNoStatus'))
          setOptions(next)
          return
        }
        setOptions(next)
        // 默认落在第一项「默认工作区」（空 id）：让宿主决定建到哪个工作区。
        // 不再显式选中 isDefault 那条——宿主给它的标题常是内部技术名 default-workspace。
        setWorkspaceId('')
        const wanted = next.defaultModel
        setSelection(wanted ? `${wanted.provider}\n${wanted.model}` : '')
      } catch (error) {
        if (alive) setLoadError(errorText(error))
      }
    })()
    return () => { alive = false }
  }, [open])

  const send = async () => {
    if (sending) return
    setSending(true)
    setResult(null)
    try {
      const [provider, model] = selection.split('\n')
      const sent = await apiPost<{ ok: boolean; error?: { message?: string } }>('/api/relay/ai-diagnosis/launch', {
        ...(workspaceId ? { workspaceId } : {}),
        ...(provider && model ? { provider, model } : {}),
        prompt: t('panel.aiDiagnosis.prompt'),
      })
      if (!sent.ok) throw new Error(sent.error?.message || '')
      setResult({ text: t('panel.aiDiagnosis.started'), failed: false })
    } catch (error) {
      setResult({ text: t('panel.aiDiagnosis.failed', { message: errorText(error) }), failed: true })
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={t('panel.aiDiagnosis.label')}
        title={t('panel.aiDiagnosis.label')}
        onClick={() => setOpen(true)}
        className="fixed bottom-5 start-5 z-30 inline-flex items-center gap-2 rounded-full border border-border bg-white px-4 py-2.5 text-sm font-medium text-black shadow-lg transition-colors duration-200 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <AskIcon />
        {t('panel.aiDiagnosis.label')}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" closeLabel={t('panel.aiDiagnosis.close')}>
          <DialogHeader>
            <DialogTitle>{t('panel.aiDiagnosis.title')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm leading-6 text-foreground-muted">{t('panel.aiDiagnosis.hint')}</p>
            {loadError ? <p className="mt-2 text-sm text-error">{t('panel.aiDiagnosis.optionsFailed', { message: loadError })}</p> : null}
            {!options && !loadError ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-foreground-muted">{t('panel.aiDiagnosis.loading')}</p>
            ) : null}
            {options?.ok ? (
              <div className="mt-3 space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-foreground-strong">{t('panel.aiDiagnosis.workspace')}</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                    value={workspaceId}
                    onChange={(event) => setWorkspaceId(event.target.value)}
                  >
                    <option value="">{t('panel.aiDiagnosis.defaultWorkspace')}</option>
                    {options.workspaces.map((item) => (
                      <option key={item.workspaceId || item.path} value={item.workspaceId}>{item.title || item.path}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-foreground-strong">{t('panel.aiDiagnosis.model')}</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                    value={selection}
                    onChange={(event) => setSelection(event.target.value)}
                  >
                    <option value="">{t('panel.aiDiagnosis.modelDefault')}</option>
                    {options.models.map((group) => (
                      <optgroup key={group.provider} label={group.displayName}>
                        {group.models.map((model) => (
                          <option key={`${group.provider}\n${model.id}`} value={`${group.provider}\n${model.id}`}>{model.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                {result ? (
                  <p className={`text-sm leading-6 ${result.failed ? 'text-error' : 'text-foreground-muted'}`}>{result.text}</p>
                ) : null}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('panel.aiDiagnosis.close')}</Button>
            <Button disabled={!options?.ok || sending || Boolean(loadError)} onClick={() => void send()}>
              {sending ? t('panel.aiDiagnosis.starting') : t('panel.aiDiagnosis.start')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
