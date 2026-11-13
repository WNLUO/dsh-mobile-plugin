'use strict';

/**
 * 会话 id：宿主自己的两处写法不一致（`dsh-api-session-controller` 用 `session.id`，
 * `dsh-acp` 用 `session.header.id`），两种都要认。
 *
 * 审批桥和判定账本共用这一份：认不出会话 id，审批就没有归属，判定流水也没法按会话对账。
 */
function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return null;
  if (typeof session.id === 'string' && session.id) return session.id;
  const header = session.header;
  return header && typeof header.id === 'string' && header.id ? header.id : null;
}

module.exports = { sessionIdOf };
