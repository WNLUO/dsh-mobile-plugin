'use strict';

/**
 * 写操作幂等（requestId 重放）。
 *
 * 为什么需要：手机侧的一次写可能在**从未到达宿主**的通道上失败，此时传输内核会换一条
 * 通道重投同一次请求（见 app/src/api/core.ts 的 routeCandidates/request）。重投的语义
 * 是「这次写还没执行过」，但内核无法证明这一点 —— 它只知道「第一个候选连不上」。
 * 一旦第一候选其实已经把请求送到宿主、只是响应回来时通道断了，重投就会让同一次写
 * 执行两遍。对「新建会话」这类非幂等写，用户看到的就是凭空多出来一个会话。
 *
 * 约定与 promptOnce 一致：只缓存**成功**结果；失败必须能被重试（一次瞬时错误不能被
 * 固化成 5 分钟的静默无响应）；没有 requestId 时直接执行，旧客户端行为不变。
 *
 * 存的是结果而不是「已执行」标记：重放要返回和第一次一样的东西，否则 App 会拿到
 * 一个形状不同的响应（例如新建会话拿不到 sessionId）。
 */

const { writeIdempotencyStateOf } = require('./session-cache.js');

/** 重放窗口：手机的一次写如果 5 分钟后才重投，那更可能是用户真的想再做一次。 */
const WRITE_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const MAX_WRITE_IDEMPOTENCY_ENTRIES = 256;

/**
 * 取出这次写请求的幂等 id。
 *
 * 优先 header：App 在构造请求头时生成一次，之后内核换通道重投用的还是同一个 init
 * （同一个请求头），因此天然复用同一个 id。body.requestId 是给不方便加头的老客户端
 * 的回退路径。
 *
 * @returns {string} 没有 id 时返回空串（调用方按「不做幂等」处理）
 */
function requestIdOf(req, body) {
  const header = req && req.headers ? req.headers['x-dsh-request-id'] : undefined;
  if (typeof header === 'string' && header.trim()) return header.trim().slice(0, 128);
  const value = body && typeof body.requestId === 'string' ? body.requestId.trim() : '';
  return value ? value.slice(0, 128) : '';
}

/**
 * 执行一次幂等写。
 *
 * @param {object} ctx 插件上下文
 * @param {string} deviceKey 设备维度（同一 requestId 在不同手机上互不影响）
 * @param {string} requestId 请求 id；空串表示不做幂等，直接执行
 * @param {() => Promise<{status:number, body:object}>} run 真正的写操作
 * @returns {Promise<{status:number, body:object}>}
 */
async function withIdempotency(ctx, deviceKey, requestId, run) {
  if (!requestId) return run();
  const state = writeIdempotencyStateOf(ctx);
  const key = `${deviceKey}\0${requestId}`;
  const now = Date.now();
  const existing = state.get(key);
  if (existing && now - existing.createdAt < WRITE_IDEMPOTENCY_TTL_MS) return existing.result;
  if (existing) state.delete(key);

  // 并发同 id：两个请求共享同一个在途 promise，都拿到同一个结果。
  const promise = Promise.resolve().then(run);
  const record = { createdAt: now, result: promise };
  state.set(key, record);
  while (state.size > MAX_WRITE_IDEMPOTENCY_ENTRIES) state.delete(state.keys().next().value);
  try {
    const outcome = await promise;
    record.result = outcome;
    // 失败态（宿主内部错误/网关不可用）不缓存：它多半是瞬时故障，重投应当真的再试一次。
    if (!outcome || typeof outcome.status !== 'number' || outcome.status >= 500) {
      if (state.get(key) === record) state.delete(key);
    }
    return outcome;
  } catch (error) {
    if (state.get(key) === record) state.delete(key);
    throw error;
  }
}

module.exports = { requestIdOf, withIdempotency, WRITE_IDEMPOTENCY_TTL_MS };