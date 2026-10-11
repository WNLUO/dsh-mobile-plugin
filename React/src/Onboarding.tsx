import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@appica/ui-react/alert'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Field, FieldLabel } from '@appica/ui-react/field'
import { Input } from '@appica/ui-react/input'
import { Progress } from '@appica/ui-react/progress'
import { Radio } from '@appica/ui-react/radio'
import { RadioGroup } from '@appica/ui-react/radio-group'
import { Spinner } from '@appica/ui-react/spinner'
import { Switch } from '@appica/ui-react/switch'
import { useEffect, useRef, useState } from 'react'

import { InfoList, InfoRow, ToneValue } from './components/InfoRow.tsx'
import { apiGet, apiPost, errorText, type ConfigPatch, type PairingInfo, type StatusView } from './lib/api.ts'
import { cn, lanText, lanTone, tunnelText, tunnelTone } from './lib/format.ts'

/**
 * 首次安装后的接入引导：四页走完，插件就接得上手机。
 *
 * 为什么要有引导：这个插件有三条完全不同的接入路，第一次装的人不会知道自己该走哪条。
 * 第二页先把人分开——
 * - 只用局域网的人：不需要任何服务器，这台电脑就是服务端；
 * - 自己有服务器的人：填自己那台的地址，走它转发；
 * - 用官方中转的人：地址是固定的，缺的只是那把授权密钥。
 * 分开之后第三页只问这一条路真正需要的东西，不多问一句。
 *
 * 第四页不是一句干巴巴的「完成」：手机上要扫码或输配对码，二维码在插件主页上，
 * 所以这里把「连上了没有」「配对码是多少」「局域网地址是什么」一次说清，再把人送进插件主页。
 * 连接结果靠轮询宿主状态得出，引导页不自己猜，也不假报成功。
 *
 * 这一页只做展示与转发：配置全交给宿主已有的 `/api/relay/*`（和 App.tsx 同一批接口）。
 * 两个地址由宿主吐同一份 HTML：`.../api/relay/panel` 自己分流（看宿主记的 `onboarded`），
 * `.../api/relay/panel/setup` 强制走这一趟（也就是下面 `replay` 那个开关的用途）。
 */

type Scenario = 'lan' | 'self' | 'official'

type Props = {
  /** 走完流程后去哪。默认回插件主页。 */
  onDone?: () => void
  /** 强制引导的那条地址（`.../panel/setup`）下多给一个「重新走一遍」。 */
  replay?: boolean
}

/** 官方中转的地址。手机端一份域名都不预置，这里是这台电脑连出去用的地址。 */
const OFFICIAL_RELAY_URL = 'https://dsh-hub.wnluo.com'

const SCENARIOS: { id: Scenario; title: string; detail: string }[] = [
  {
    id: 'lan',
    title: '在局域网内使用',
    detail: '手机和这台电脑连同一个 Wi-Fi，直接连过来，不经过任何服务器。',
  },
  {
    id: 'self',
    title: '自己搭建了服务器后端',
    detail: '你已经有自己的中转服务器，把它填进来，由它转发。',
  },
  {
    id: 'official',
    title: '使用我提供的中转服务',
    detail: '用现成的中转，手机在任何网络下都能连回来。需要授权。',
  },
]

const STEPS = ['欢迎', '使用场景', '配置', '完成']

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

/**
 * 接入引导。
 *
 * @param props.onDone 走完之后去哪
 * @param props.replay 走的是 `.../panel/setup`，多一个「重新走一遍」
 */
export function Onboarding({ onDone, replay = false }: Props) {
  const [step, setStep] = useState(0)
  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [status, setStatus] = useState<StatusView | null>(null)
  const [fatal, setFatal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [relayUrl, setRelayUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [lanEnabled, setLanEnabled] = useState(true)
  const [lanPort, setLanPort] = useState('')
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [outcome, setOutcome] = useState<'waiting' | 'ok' | 'bad'>('waiting')

  /** 轮询要能被卸载打断，否则关掉页面后它还在打接口。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // 只为拿一个默认设备名（宿主机名）。读不到也不挡路：名字本来就可以自己填。
  useEffect(() => {
    void (async () => {
      try {
        const current = await apiGet<StatusView>('/api/relay/status')
        setStatus(current)
        setName((value) => value || current.name)
      } catch (err) {
        setFatal(errorText(err))
      }
    })()
  }, [])

  function pick(next: Scenario) {
    setScenario(next)
    setRelayUrl(next === 'official' ? OFFICIAL_RELAY_URL : '')
    setError('')
  }

  function restart() {
    setStep(0)
    setScenario(null)
    setRelayUrl('')
    setSecret('')
    setLanPort('')
    setPairing(null)
    setOutcome('waiting')
    setError('')
  }

  const nameMissing = name.trim() === ''
  const urlMissing = scenario === 'self' && !isHttpUrl(relayUrl)
  const secretMissing = scenario === 'official' && secret.trim() === ''
  const portInvalid =
    lanPort.trim() !== '' && !(/^\d+$/.test(lanPort.trim()) && Number(lanPort) >= 1024 && Number(lanPort) <= 65535)
  const canNext = scenario !== null && !busy
  const canFinish = !busy && !nameMissing && !urlMissing && !secretMissing && !portInvalid

  /** 连上了没有：局域网看代理在不在听，中转看隧道有没有握上手。 */
  function readyOf(current: StatusView): boolean {
    return scenario === 'lan' ? current.lan.state === 'listening' : current.tunnel.state === 'connected'
  }

  function failedOf(current: StatusView): boolean {
    return scenario === 'lan' ? current.lan.state === 'error' : current.tunnel.state === 'error'
  }

  /** 配置写下去之后盯一会儿状态：好了就说好了，坏了就把原因和下一步说清楚。 */
  async function settle() {
    const deadline = Date.now() + 20_000
    try {
      setPairing(await apiGet<PairingInfo>('/api/relay/pairing'))
    } catch {
      /* 配对信息拿不到，不影响先把连接结果说清楚 */
    }
    while (alive.current && Date.now() < deadline) {
      await sleep(1500)
      if (!alive.current) return
      let current: StatusView
      try {
        current = await apiGet<StatusView>('/api/relay/status')
      } catch {
        continue
      }
      setStatus(current)
      if (readyOf(current)) {
        setOutcome('ok')
        return
      }
      if (failedOf(current)) {
        setOutcome('bad')
        return
      }
    }
    if (alive.current) setOutcome('waiting')
  }

  async function finish() {
    if (!canFinish) return
    setBusy(true)
    setError('')
    const patch: ConfigPatch = { name: name.trim(), lanEnabled, pairingPolicy: 'code' }
    // 只用局域网的人不该被「中转连不上」的红字吓到：地址留空，隧道压根不启动。
    patch.relayUrl = scenario === 'lan' ? '' : relayUrl.trim()
    // 密钥留空＝不动它，绝不把空串写回去（那等于把注册密钥关掉）。
    if (secret.trim()) patch.registerSecret = secret.trim()
    if (lanPort.trim()) patch.lanPort = Number(lanPort.trim())
    try {
      setStatus(await apiPost<StatusView>('/api/relay/config', patch))
      setStatus(await apiPost<StatusView>('/api/relay/toggle', { enabled: true }))
      // 告诉宿主「这台机器走过引导了」，下次打开直接进主页。
      // 失败不算这一步失败：老宿主没有这条路由，引导照样走完，只是下次还会再引导一遍。
      await apiPost('/api/relay/onboarded', {}).catch(() => undefined)
      setOutcome('waiting')
      setStep(3)
      void settle()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const stepTitle =
    step === 0
      ? '先把这个插件接到手机上'
      : step === 1
        ? '你打算怎么用？'
        : step === 2
          ? scenario === 'lan'
            ? '局域网这边怎么接'
            : scenario === 'self'
              ? '填你服务器那台的信息'
              : '填官方中转的接入信息'
          : outcome === 'ok'
            ? '配置完成，已经连上了'
            : '配置完成'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <header className="flex w-full max-w-2xl flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground-intense">接入引导</h1>
        <Badge variant="soft" size="sm">
          {`第 ${step + 1} / ${STEPS.length} 步 · ${STEPS[step]}`}
        </Badge>
        <Progress className="w-32" value={((step + 1) / STEPS.length) * 100} min={0} max={100} />
        {replay ? (
          <Button className="ml-auto" variant="ghost" size="sm" disabled={busy} onClick={restart}>
            重新走一遍
          </Button>
        ) : null}
      </header>

      {fatal ? (
        <Alert className="w-full max-w-2xl" variant="error">
          <AlertIcon />
          <AlertTitle>读不到插件状态</AlertTitle>
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert className="w-full max-w-2xl" variant="error">
          <AlertIcon />
          <AlertTitle>这一步没成功</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card frame="solid" className="w-full max-w-2xl">
        {step === 0 ? null : (
          <CardHeader>
            <CardTitle>{stepTitle}</CardTitle>
          </CardHeader>
        )}

        <div className={cn('flex flex-col gap-5 px-4', step === 2 ? 'py-2' : 'min-h-[320px] justify-center py-6')}>
          {step === 0 ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <h2 className="text-2xl font-semibold text-foreground-intense">把 DSH 接到手机上</h2>
              <p className="max-w-md text-sm text-foreground-muted">
                手机连上这台电脑，在外面也能看进度、发指令、接手要你点头的事。电脑继续跑，手机替你盯着。
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Badge variant="soft" size="sm">
                  手机收发消息
                </Badge>
                <Badge variant="soft" size="sm">
                  随时看进度
                </Badge>
                <Badge variant="soft" size="sm">
                  局域网和中转都行
                </Badge>
              </div>
              <p className="text-xs text-foreground-subtle">接下来三步，在这台电脑上点几下就好，手机不用先连过来。</p>
            </div>
          ) : null}

          {step === 1 ? (
            <RadioGroup value={scenario ?? ''} onValueChange={(value) => pick(value as Scenario)} className="gap-3">
              {SCENARIOS.map((item) => (
                <label
                  key={item.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
                    scenario === item.id
                      ? 'border-border-emphasis bg-background-subtle'
                      : 'border-border-muted bg-background-muted hover:border-border-strong',
                  )}
                >
                  <Radio value={item.id} className="mt-0.5" aria-label={item.title} />
                  <span className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-foreground-intense">{item.title}</span>
                    <span className="text-xs text-foreground-muted">{item.detail}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          ) : null}

          {step === 2 ? (
            <>
              {scenario === 'lan' ? (
                <p className="text-sm text-foreground-muted">
                  不需要服务器：手机和这台电脑连同一个 Wi-Fi 就能连过来。这台电脑要一直开着、DSH 要开着。
                </p>
              ) : null}

              {scenario === 'self' ? (
                <p className="text-sm text-foreground-muted">
                  中转服务器负责在手机和这台电脑之间转发，地址填你自己那台。它得先跑起来，手机那边也要填同一个地址。
                </p>
              ) : null}

              {scenario === 'official' ? (
                <p className="text-sm text-foreground-muted">
                  用现成的中转，手机在任何网络下都能连回来。地址固定，缺的只有那把授权密钥——拿到授权后它才会通过中转的准入。
                </p>
              ) : null}

              {scenario === 'official' ? (
                <InfoList>
                  <InfoRow label="中转地址" mono>
                    {OFFICIAL_RELAY_URL}
                  </InfoRow>
                </InfoList>
              ) : null}

              {scenario === 'self' ? (
                <Field>
                  <FieldLabel htmlFor="ob-relay-url">中转地址</FieldLabel>
                  <Input
                    inputProps={{ id: 'ob-relay-url', className: 'font-mono' }}
                    value={relayUrl}
                    placeholder="https://example.com"
                    onChange={(event) => setRelayUrl(event.target.value)}
                  />
                  {urlMissing ? <p className="text-xs text-error">要填一个 http:// 或 https:// 开头的地址。</p> : null}
                </Field>
              ) : null}

              {scenario === 'official' ? (
                <Field>
                  <FieldLabel htmlFor="ob-secret">注册密钥</FieldLabel>
                  <Input
                    type="password"
                    inputProps={{ id: 'ob-secret' }}
                    value={secret}
                    placeholder="粘贴发你的那串密钥"
                    onChange={(event) => setSecret(event.target.value)}
                    clearable
                    onClear={() => setSecret('')}
                  />
                  {secretMissing ? <p className="text-xs text-error">官方中转要凭这把密钥准入，不能空着。</p> : null}
                </Field>
              ) : null}

              <Field>
                <FieldLabel htmlFor="ob-name">设备名</FieldLabel>
                <Input
                  inputProps={{ id: 'ob-name' }}
                  value={name}
                  placeholder="手机里显示的名字"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              <div className="flex items-center justify-between gap-4 rounded-md bg-background-muted px-3 py-2">
                <span className="flex flex-col">
                  <span className="text-sm text-foreground">局域网直连</span>
                  <span className="text-xs text-foreground-muted">同一个 Wi-Fi 时可以直接连，不经服务器。</span>
                </span>
                <Switch size="md" checked={lanEnabled} onCheckedChange={setLanEnabled} aria-label="局域网直连" />
              </div>

              <Field>
                <FieldLabel htmlFor="ob-lan-port">局域网端口</FieldLabel>
                <Input
                  inputProps={{ id: 'ob-lan-port', inputMode: 'numeric' }}
                  value={lanPort}
                  placeholder="留空就自动选一个"
                  onChange={(event) => setLanPort(event.target.value)}
                />
                {portInvalid ? (
                  <p className="text-xs text-error">端口要么留空，要么填 1024–65535 之间的整数。</p>
                ) : null}
              </Field>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <p className="text-sm text-foreground-muted">
                接下来打开手机 App，用「添加设备」扫码或输入配对码。二维码在插件主页上。
              </p>

              <InfoList>
                <InfoRow label={scenario === 'lan' ? '局域网直连' : '中转隧道'}>
                  <ToneValue
                    tone={
                      scenario === 'lan'
                        ? lanTone(status?.lan.state ?? 'off', lanEnabled)
                        : tunnelTone(status?.tunnel.state ?? 'off')
                    }
                    text={
                      scenario === 'lan'
                        ? lanText(status?.lan.state ?? 'off', lanEnabled)
                        : tunnelText(status?.tunnel.state ?? 'off')
                    }
                  />
                </InfoRow>
                <InfoRow label="设备名">{name.trim() || status?.name || '—'}</InfoRow>
                <InfoRow label="配对码" mono>
                  {pairing?.pairingCode ?? status?.pairingCode ?? '—'}
                </InfoRow>
                {scenario === 'lan' ? null : (
                  <InfoRow label="中转地址" mono>
                    {relayUrl.trim() || OFFICIAL_RELAY_URL}
                  </InfoRow>
                )}
                {pairing && pairing.lanUrls.length > 0 ? (
                  <InfoRow label="局域网地址" mono>
                    {pairing.lanUrls.join('　')}
                  </InfoRow>
                ) : null}
              </InfoList>

              {outcome === 'ok' ? null : outcome === 'bad' ? (
                <Alert variant="error">
                  <AlertIcon />
                  <AlertTitle>{scenario === 'lan' ? '局域网没能开始监听' : '中转没连上'}</AlertTitle>
                  <AlertDescription>{failureReason()}</AlertDescription>
                </Alert>
              ) : (
                <div className="flex items-center gap-2 text-sm text-foreground-muted">
                  <Spinner />
                  正在等它连上…
                </div>
              )}
            </>
          ) : null}
        </div>

        <div
          className={cn(
            'flex flex-wrap items-center gap-2 px-4 py-4',
            // 欢迎页只有一颗按钮，居中才像一页欢迎页；后面几步右对齐，跟表单对齐更稳。
            step === 0 ? 'justify-center' : 'justify-end',
          )}
        >
          {step > 0 && step < 3 ? (
            <Button variant="outline" disabled={busy} onClick={() => setStep(step - 1)}>
              上一步
            </Button>
          ) : null}

          {step === 0 ? (
            <Button variant="primary" onClick={() => setStep(1)}>
              下一步
            </Button>
          ) : null}

          {step === 1 ? (
            <Button variant="primary" disabled={!canNext} onClick={() => setStep(2)}>
              下一步
            </Button>
          ) : null}

          {step === 2 ? (
            <Button variant="primary" disabled={!canFinish} onClick={() => void finish()}>
              {busy ? '正在写入…' : '完成并启用'}
            </Button>
          ) : null}

          {step === 3 ? (
            <Button variant="primary" onClick={() => (onDone ? onDone() : window.location.assign('/'))}>
              进入插件
            </Button>
          ) : null}
        </div>
      </Card>
    </main>
  )

  /** 连不上的原因：先把宿主给的准入线索翻成人话，再兜底到原始错误。 */
  function failureReason(): string {
    if (scenario === 'lan') {
      const lanError = status?.lan.error
      return lanError
        ? `${lanError}（端口可能被占用，换一个 1024–65535 的端口再试。）`
        : '局域网代理没起来。端口可能被别的程序占了，回上一步换一个端口；也可以先用中转连。'
    }
    const tunnel = status?.tunnel
    if (tunnel?.registerSecretRequired) {
      return '中转拒绝了这次连接：注册密钥不对，或者没填。这把密钥由中转的部署者给出，官方中转就是拿到授权时发给你的那一串。'
    }
    if (tunnel?.instanceNotAllowed) {
      return '这台机器的实例 ID 不在中转的白名单里，需要部署者把它加进中转的 instances.json。'
    }
    return tunnel?.error
      ? `${tunnel.error}（检查中转地址填对没有、服务器是不是在跑。）`
      : '隧道没建起来。检查中转地址和服务器状态，改完回上一步重试。'
  }
}
