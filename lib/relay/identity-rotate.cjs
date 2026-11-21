'use strict';

/**
 * 身份冲突时「换身份」的实装。
 *
 * 连续收到身份冲突（同一 instanceId 被别处占了令牌）后触发一次：生成新号 → 落盘 → 把本机
 * 签发的设备凭据整体迁到新号 → 让 sidecar 用新号重下配置 → 总控用新号重连。新号唯一，换完
 * 就不再有冲突；重入保护避免并发触发。
 *
 * 迁移那步是「换号对已配对设备透明」的关键：鉴权只认「当前号 + 上一代号」，若不迁移，换到
 * 第二次时更早配对、还没换过来的手机会被甩下、只能重新扫码（见 `credentials.reassignInstance`）。
 *
 * 放在这里而不是装配层：装配层只把它挂上，不许多长实现（见 `test/assembly-layer.test.cjs`）。
 */
function createIdentityRotator({ state, rotateIdentity, saveState, syncSidecar, syncControl, migrateCredentials }) {
  let rotating = false;
  return async function rotateIdentityNow() {
    if (rotating) return;
    rotating = true;
    try {
      const { instanceId } = rotateIdentity(state);
      saveState(state);
      // 迁移失败不阻断换号：鉴权仍认旧号，最坏退回「重扫」，不会把本机卡在冲突里。
      try { if (typeof migrateCredentials === 'function') migrateCredentials(instanceId); } catch { /* ignore */ }
      try { await syncSidecar(); } catch { /* 配置下发失败不影响重连，下次 sync 再补 */ }
      try { syncControl(); } catch { /* ignore */ }
    } finally {
      rotating = false;
    }
  };
}

module.exports = { createIdentityRotator };
