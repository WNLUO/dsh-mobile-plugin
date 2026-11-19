'use strict';

/**
 * 身份冲突时「换身份」的实装。
 *
 * 连续收到身份冲突（同一 instanceId 被别处占了令牌）后触发一次：生成新号 → 落盘 → 让 sidecar
 * 用新号重下配置 → 总控用新号重连。新号唯一，换完就不再有冲突；重入保护避免并发触发。
 *
 * 放在这里而不是装配层：装配层只把它挂上，不许多长实现（见 `test/assembly-layer.test.cjs`）。
 */
function createIdentityRotator({ state, rotateIdentity, saveState, syncSidecar, syncControl }) {
  let rotating = false;
  return async function rotateIdentityNow() {
    if (rotating) return;
    rotating = true;
    try {
      rotateIdentity(state);
      saveState(state);
      try { await syncSidecar(); } catch { /* 配置下发失败不影响重连，下次 sync 再补 */ }
      try { syncControl(); } catch { /* ignore */ }
    } finally {
      rotating = false;
    }
  };
}

module.exports = { createIdentityRotator };
