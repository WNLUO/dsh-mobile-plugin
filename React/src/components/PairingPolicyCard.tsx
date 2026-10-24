/**
 * 「允许新设备绑定」开关：面板上最显眼的那一处准入总闸。
 *
 * ## 为什么它从「中转配置」里搬出来
 *
 * 这个开关决定的是**这台电脑收不收新手机**，不是中转链路的配置细节。埋在「中转配置」
 * 弹窗里时，想临时收一批新设备的人得先想起它在那儿（还得先明白它跟配对策略是一回事）。
 * 弹窗里那对单选项留着（写的是同一份配置），但面板上必须有这一眼可见的一处。
 *
 * ## 为什么没有第二份状态
 *
 * 开关的取值**就是** `status.pairingPolicy`：`'code'` = 允许、`'deny'` = 一律拒绝。
 * 组件自己不留状态副本 —— 副本会和 `/status` 的那份在轮询里打架（点一下之后
 * 两个来源各说各的）。写的时候走 `POST /api/relay/config`，回来的 `status` 由调用方接住，
 * 下一轮渲染读到的就是宿主刚存下的那个值。乐观切换也不做：宿主没收下时就该弹回去。
 */
import { Badge } from '@appica/ui-react/badge'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import { Spinner } from '@appica/ui-react/spinner'
import { Switch } from '@appica/ui-react/switch'

import type { PairingPolicy, StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'

type Props = {
  status: StatusView
  busy: string
  onChange: (policy: PairingPolicy) => void
}

export function PairingPolicyCard({ status, busy, onChange }: Props) {
  const allowed = status.pairingPolicy === 'code'
  const idle = busy !== ''

  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>{t('panel.devices.allowTitle')}</span>
          <Badge variant={allowed ? 'success' : 'secondary'} size="sm">
            {allowed ? t('panel.devices.allowOn') : t('panel.devices.allowOff')}
          </Badge>
          {busy === 'policy' ? <Spinner /> : null}
        </CardTitle>
      </CardHeader>

      <label className="flex items-start justify-between gap-4 pt-1">
        <span className="min-w-0">
          <span className="block text-sm text-foreground">
            {allowed ? t('panel.devices.allowOnHint') : t('panel.devices.allowOffHint')}
          </span>
          {/* 关掉时才说这句：开着的时候它不成立，一直摆着只会让人以为关掉也能连。 */}
          {!allowed ? (
            <span className="mt-0.5 block text-xs text-foreground-muted">
              {t('panel.devices.allowOffNote')}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center">
          <Switch
            size="md"
            checked={allowed}
            disabled={idle}
            onCheckedChange={(next) => onChange(next ? 'code' : 'deny')}
            aria-label={t('panel.devices.allowTitle')}
          />
        </span>
      </label>
    </Card>
  )
}
