'use strict';

/**
 * 设备批量同步的两组接口（`/api/mobile/v1/sync/*`，见 docs/device-batch-sync.md）。
 *
 *  · `POST /sync/tickets` —— 已配对的设备替同步组里将来新增的手机申领一次性入场券，连同这台
 *    电脑的概况（名字 / 实例号 / 中转地址 / 直连候选 …）一起回给导出方，拼进二维码。
 *  · `POST /sync/inbox` —— 别的手机把 SGK 加密的记录写进本机收件箱。
 *  · `GET  /sync/inbox` —— 取 `since` 之后、未过期的记录。
 *
 * 宿主只存不读收件箱：它不认识 SGK、解不开 blob。真正的内容加解密、去重与「哪条该做什么」
 * 全在手机上（见契约的「自动同步」节）。这里只做两件事：发券、存取密文。
 *
 * 三个 handler 都要求已配对（路由表里走 `guarded`），否则任何人都能领走配对资格、或往这台
 * 电脑的收件箱塞东西。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { MAX_RECORDS_PER_WRITE } = require('./sync-inbox-store.js');

/**
 * 构造同步那组 handler。依赖由移动端路由表装配时注入。
 *
 * @param {object} deps
 * @param {object} deps.state           宿主状态（instanceId / name / relayUrl / lanEnabled …）
 * @param {object} deps.ticketStore     一次性券表（transfer-tickets.js）
 * @param {object} deps.inboxStore      同步收件箱 store（sync-inbox-store.js）
 * @param {(port: number) => Array<object>} [deps.safeLanCandidates] 直连候选（与 /connection-info 同一份）
 * @param {(port: number) => Array<object>} [deps.safeIpv6Candidates] IPv6 直连候选
 * @param {() => number} [deps.lanPortInUse] 宿主实绑的直连端口
 * @param {() => string} [deps.hostPlatform] 宿主系统标识
 * @param {(message: string) => void} [deps.log]
 */
function createSyncHandlers(deps = {}) {
  const state = deps.state || {};
  const ticketStore = deps.ticketStore || null;
  const inboxStore = deps.inboxStore || null;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const instanceIdOf = () => String(state.instanceId || '');

  /** 这台电脑给手机的概况：新手机配对前靠它知道对面是谁、该往哪拨。 */
  function hostSummary() {
    const port = typeof deps.lanPortInUse === 'function' ? deps.lanPortInUse() : state.lanPort;
    // 直连候选与 /connection-info、/pair 那份同口径：关掉局域网直连时两份都为空。
    const lanUrls = state.lanEnabled && typeof deps.safeLanCandidates === 'function'
      ? deps.safeLanCandidates(port).map((candidate) => candidate && candidate.url).filter(Boolean)
      : [];
    const ipv6Candidates = state.lanEnabled && typeof deps.safeIpv6Candidates === 'function'
      ? deps.safeIpv6Candidates(port).map((candidate) => candidate && candidate.url).filter(Boolean)
      : [];
    const hostPlatform = typeof deps.hostPlatform === 'function' ? deps.hostPlatform() : (state.hostPlatform || process.platform);
    return {
      name: state.name || '',
      instanceId: instanceIdOf(),
      // 券只能走协议 v2 的 sealed 配对，所以这里报协议 2。
      proto: 2,
      relayUrl: state.enabled ? (state.relayUrl || null) : null,
      lanUrls,
      ipv6Candidates,
      hostPlatform,
    };
  }

  /** POST /sync/tickets：申领一次性入场券（count 默认 1、封顶 8）。 */
  async function handleMintTickets(_ctx, req, res) {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
    if (!ticketStore) { sendJson(res, 503, { ok: false, error: 'ticket store unavailable' }); return; }
    // 空体是合法的（count 缺省 1）；读不懂 / 太大也按空对象、让 count 走默认，不因多要一个字段就失败。
    const body = (await readJsonBody(req, 16 * 1024)) || {};
    const tickets = ticketStore.mint(instanceIdOf(), body && body.count, {
      ttlMs: body && body.ttlMs,
      reusable: body && body.reusable,
    });
    sendJson(res, 200, { ok: true, host: hostSummary(), tickets });
  }

  /** POST /sync/inbox：写入一批密文记录，回被接收的 cid 列表。 */
  async function handleInboxWrite(_ctx, req, res) {
    if (!inboxStore) { sendJson(res, 503, { ok: false, error: 'inbox store unavailable' }); return; }
    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.records)) {
      sendJson(res, 400, { ok: false, error: 'records 必须是数组' });
      return;
    }
    if (body.records.length > MAX_RECORDS_PER_WRITE) {
      sendJson(res, 400, { ok: false, error: `单次最多写 ${MAX_RECORDS_PER_WRITE} 条记录` });
      return;
    }
    let accepted;
    try {
      accepted = inboxStore.write(instanceIdOf(), body.records);
    } catch (error) {
      // 读坏盘时 store 会抛错（绝不覆盖已有记录）；这里是那条错误落到请求上的地方。
      log('sync inbox write failed:', error && error.message);
      sendJson(res, 500, { ok: false, error: 'internal error' });
      return;
    }
    sendJson(res, 200, { ok: true, accepted });
  }

  /** GET /sync/inbox?since=<ms>：取 `since` 之后、未过期的记录。 */
  async function handleInboxRead(_ctx, req, res) {
    if (!inboxStore) { sendJson(res, 503, { ok: false, error: 'inbox store unavailable' }); return; }
    let since = 0;
    try {
      const query = new URL(req.url || '/', 'http://x').searchParams.get('since');
      if (query !== null) since = Number(query);
    } catch { /* 畸形 URL 当 since=0，返回全部未过期的 */ }
    if (!Number.isFinite(since) || since < 0) since = 0;
    const records = inboxStore.read(instanceIdOf(), since);
    sendJson(res, 200, { ok: true, records });
  }

  /** 同一条路径上按 method 分派写 / 读（宿主 webServer 一个路径只能挂一个 handler）。 */
  async function handleInbox(ctx, req, res) {
    if (req.method === 'POST') return handleInboxWrite(ctx, req, res);
    if (req.method === 'GET') return handleInboxRead(ctx, req, res);
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
  }

  return { handleMintTickets, handleInbox, handleInboxWrite, handleInboxRead };
}

module.exports = { createSyncHandlers };
