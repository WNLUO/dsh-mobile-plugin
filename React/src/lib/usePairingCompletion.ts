// 只跟随宿主实际签发绑定凭据的成功时间；换码、续码与后台凭据升级不触发完成。
import { useEffect, useRef } from 'react'

export function usePairingCompletion(lastPairingAt: number | undefined, onCompleted: () => void) {
  const previousAt = useRef(lastPairingAt)
  useEffect(() => {
    if (lastPairingAt === undefined) return
    const previous = previousAt.current
    if (previous === undefined) previousAt.current = lastPairingAt
    else if (lastPairingAt > previous) {
      previousAt.current = lastPairingAt
      onCompleted()
    }
  }, [lastPairingAt, onCompleted])
}
