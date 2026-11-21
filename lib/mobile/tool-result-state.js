// 工具结果的取消、失败与成功状态由历史和实时路径共用。
'use strict';

/** 已落定结果只按持久化错误码认取消；普通运行失败仍保留失败态。 */
function toolResultState(result) {
  if (!result) return 'running';
  const code = result.code;
  if (code === 'interrupted' || code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return 'stopped';
  return result.isError || code !== undefined ? 'error' : 'ok';
}

module.exports = { toolResultState };
