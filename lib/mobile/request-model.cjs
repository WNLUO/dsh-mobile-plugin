'use strict';

/** 请求头里的真实模型身份：统计与会话事实共用，不依赖采集器或账本。 */
function requestModelOf(event) {
  const config = event && event.data && event.data.header && event.data.header.config;
  if (!config || typeof config.provider !== 'string' || !config.provider
    || typeof config.model !== 'string' || !config.model) return null;
  return { provider: config.provider, model: config.model };
}

function sameModel(left, right) {
  return Boolean(left && right && left.provider === right.provider && left.model === right.model);
}

module.exports = { requestModelOf, sameModel };
