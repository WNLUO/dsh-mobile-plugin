'use strict';

/**
 * 宿主侧的协议 v2 请求信封：验签、解封、封响应。
 *
 * 挂在移动端路由守卫（`http/routing.js` 的 `createGuarded`）里，**业务 handler 之前解、
 * 之后封**。这样每个域 handler 拿到的仍是「已解析的明文 JSON」与「可以照常 `sendJson` 的
 * res」，一行业务代码都不用知道信封存在。
 *
 * 几条容易写错的（都按 §8.3(4) 冻结的口径）：
 *  - 签的是**密文**：先解密再验签会让「把 A 接口的密文搬到 B 接口」成立。
 *  - `PATH` 从 `API_BASE` 起算（中转会把部署前缀剥掉），`QUERY` 按线上原样、不排序。
 *  - 摘要是小写十六进制 64 字符。
 *  - 错误响应**永远明文**：`401/403/503` 与所有 `code` 错误的响应都必须让 App 能直接读懂。
 */

const e2ee = require('../shared/e2ee');
const { ACCEPT_ENC_HEADER, compressPlain, decompressPlain } = require('../shared/e2ee-plain');

/** 重放窗口：手机时钟可能偏几分钟，5 分钟是给它留的余量，真正的防线是 nonce 表。 */
const TS_WINDOW_MS = 5 * 60 * 1000;
/** 每台设备保留最近多少条写请求的 nonce，过期 5 分钟后淘汰。 */
const NONCE_TABLE_SIZE = 256;

/** keyId → { nonce: ts } 的环形表。GET 不记：换通道重投会复用同一 nonce。 */
const nonces = new Map();

/**
 * 读一个请求头（大小写不敏感、数组取第一个）。
 *
 * 中转会把头名压成小写，但假 req、手表升级那条路、以及 Node 不同版本的行为不保证如此，
 * 靠大小写绕过太便宜。
 */
function headerOf(req, name) {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

/**
 * 会从 URL 搬进 `X-Dsh-Params` 的查询参数（白名单，不做通用机制）。
 *
 * `path` / `query` / `refs` 直接暴露「他在哪个目录下干活」「他搜了什么」「他在配哪把 key」。
 * 其余（`sessionId` / `limit` / `offset` / `beforeSeq` / `afterSeq` / `rev` / `fresh` /
 * `archived`）留在 URL 上：`rev` 与分页要留给中转判断镜像能否命中，塞进密文等于废掉镜像。
 */
const PRIVATE_QUERY_KEYS = ['path', 'query', 'refs'];

/** 这条请求是不是协议 v2。 */
const isProto2 = (req) => headerOf(req, 'x-dsh-proto').trim() === '2';

/** `/api/mobile/v1/...` 这一段，去掉部署前缀（中转会剥掉，App 签名时也截到 API_BASE）。 */
function signedPath(req) {
  const raw = String(req?.url || '/');
  const at = raw.indexOf('?');
  const pathname = at >= 0 ? raw.slice(0, at) : raw;
  const base = '/api/mobile/v1/';
  const hit = pathname.indexOf(base);
  return hit >= 0 ? pathname.slice(hit) : pathname;
}

/** 查询串按线上原样（含 `?`），不排序：它必须与 App 真正发出去的那串一致。 */
function signedQuery(req) {
  const raw = String(req?.url || '');
  const at = raw.indexOf('?');
  return at >= 0 ? raw.slice(at) : '';
}

/**
 * 校验并解封一条 v2 请求。
 *
 * @param {object} req
 * @param {object} deps
 * @param {(keyId: string) => { deviceKey: string } | null} deps.keyFor 按 keyId 找设备密钥
 * @param {Buffer} [deps.rawBody] 已读到的请求体原文（没读过就给 undefined，这里会自己读）
 * @returns {{ ok: true, body: object|undefined, keys: object, device: object }
 *          | { ok: false, status: number, code: string, extra?: object }}
 */
function openRequest(req, deps, rawBody) {
  const keyId = headerOf(req, 'x-dsh-key-id').trim();
  if (!keyId) return { ok: false, status: 400, code: 'e2ee-bad-envelope', extra: { reason: 'missing x-dsh-key-id' } };
  const record = deps.keyFor(keyId);
  if (!record || !record.deviceKey) return { ok: false, status: 401, code: 'e2ee-unknown-device' };

  const keys = e2ee.deriveSessionKeys(Buffer.from(record.deviceKey, 'base64url'));

  // ── 签名（签的是密文，所以先验签再解）──
  const ts = Number(headerOf(req, 'x-dsh-ts'));
  const nonce = headerOf(req, 'x-dsh-nonce').trim();
  const sig = headerOf(req, 'x-dsh-sig').trim();
  if (!Number.isFinite(ts) || !nonce || !sig) {
    return { ok: false, status: 400, code: 'e2ee-bad-envelope', extra: { reason: 'missing signature parts' } };
  }

  const method = String(req.method || 'GET').toUpperCase();
  const canonical = e2ee.canonicalString({
    method,
    path: signedPath(req),
    query: signedQuery(req),
    ts,
    nonce,
    bodyBytes: rawBody || Buffer.alloc(0),
  });
  if (!e2ee.verifySignature(keys.sig, canonical, sig)) {
    return { ok: false, status: 400, code: 'e2ee-bad-signature' };
  }

  // ── 时钟 ──
  const skew = Date.now() - ts;
  if (Math.abs(skew) > TS_WINDOW_MS) {
    // 回宿主的时间让 App 校准一次；这条响应必须明文，否则 App 读不到原因。
    return { ok: false, status: 400, code: 'e2ee-clock-skew', extra: { serverTime: Date.now() } };
  }

  // ── 重放（只记改状态的方法：GET 会被换通道重投复用同一个 nonce）──
  if (method !== 'GET') {
    const seen = nonces.get(keyId);
    const table = seen || new Map();
    if (table.has(nonce)) return { ok: false, status: 409, code: 'e2ee-replay' };
    table.set(nonce, ts);
    // 过期淘汰 + 上限：表只增不减的话一台设备长期使用会把它撑大。
    if (table.size > NONCE_TABLE_SIZE) {
      for (const [key, stamp] of table) {
        if (Date.now() - stamp > TS_WINDOW_MS || table.size > NONCE_TABLE_SIZE) table.delete(key);
      }
    }
    nonces.set(keyId, table);
  }

  // ── 解封请求体 ──
  let body;
  if (rawBody && rawBody.length > 0) {
    let envelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, status: 400, code: 'e2ee-bad-envelope' };
    }
    if (!envelope || Number(envelope.v) !== 2 || typeof envelope.c !== 'string') {
      return { ok: false, status: 400, code: 'e2ee-bad-envelope' };
    }
    let plain;
    try {
      plain = e2ee.open(keys.up, Buffer.from(envelope.c, 'base64'), e2ee.upAad(method, signedPath(req)));
    } catch {
      return { ok: false, status: 400, code: 'e2ee-decrypt-failed' };
    }
    try {
      body = JSON.parse(plain.toString('utf8'));
    } catch {
      return { ok: false, status: 400, code: 'e2ee-bad-envelope' };
    }
  }

  // ── 加密头里的私密查询参数（§8.4）──
  const params = headerOf(req, 'x-dsh-params').trim();
  if (params) {
    let decoded;
    try {
      const plain = e2ee.open(keys.up, Buffer.from(params, 'base64'), e2ee.paramsAad(ts, nonce));
      decoded = JSON.parse(plain.toString('utf8'));
    } catch {
      return { ok: false, status: 400, code: 'e2ee-decrypt-failed' };
    }
    if (decoded && typeof decoded === 'object') {
      // 把搬走的参数**合并回 `req.url` 的查询串**（§8.4）：业务 handler 一行都不用改，
      // 它读到的仍是原来那个查询串。只搬白名单三个键 —— 分页与 `rev` 留在 URL 上，
      // 镜像要靠它们判「这是不是同一条读」。
      //
      // 只挂在 `req.__dshParams` 上是不够的：那是个没人读的字段，三条路由
      // （工作区目录、会话检索词、凭据引用名）拿不到参数，表现为「搜索永远是空结果」。
      const moved = []
      for (const key of PRIVATE_QUERY_KEYS) {
        const value = decoded[key]
        if (typeof value !== 'string' || !value) continue
        moved.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      }
      if (moved.length) {
        const raw = String(req.url || '')
        const at = raw.indexOf('?')
        // 剩下那串保持**原样**：它的顺序参与签名，重排会让宿主的验签结论与 App 不一致。
        const kept = at >= 0 ? raw.slice(at + 1) : ''
        const merged = kept ? `${kept}&${moved.join('&')}` : moved.join('&')
        req.url = `${at >= 0 ? raw.slice(0, at) : raw}?${merged}`
      }
    }
  }

  return { ok: true, body, keys, device: record, req: { ts, nonce } };
}

/**
 * 封一条响应。
 *
 * `401/403/503` 例外，见文件头。其余一律封——包括业务层的 `{ ok: false, error }`：
 * 那些是**业务**错误，不是「解不开」，中转不该看见。
 *
 * **先压再封**（`x-dsh-accept-enc` 带 `g` 时才压）：压缩必须发生在 AEAD 之前，密文没有
 * 可压缩的余量。`z` 挂在信封上，客户端据此决定解不解压 —— 老 App 不带那个头，所以它
 * 收到的永远是明文信封，一个字节都不用改。
 */
function sealResponse(req, res, keys, request, payload) {
  if (!keys || !request) return payload;
  const status = res?.statusCode || 200;
  // 这三个状态码永远明文：App 必须先读懂「被吊销 / 时钟不对 / 宿主不在线」才谈得上别的。
  if (status === 401 || status === 403 || status === 503) return payload;
  const method = String(req.method || 'GET').toUpperCase();
  const aad = e2ee.downAad(method, signedPath(req), request.ts, request.nonce);
  const acceptEnc = headerOf(req, ACCEPT_ENC_HEADER);
  const seal = (body) => {
    const { payload: plain, z } = compressPlain(Buffer.from(JSON.stringify(body)), acceptEnc);
    return wrapper(e2ee.seal(keys.down, plain, aad), z);
  };
  // 列表类响应要**把三样元数据留在明文**（§8.5）：中转的离线镜像有三处硬读 ——
  // `is_ok()` 找外层 `ok: true`、`revision` 用来判「这份还是不是同一份」、`stale` 由它在
  // 回包里注入。把 ok 藏进密文等于镜像永远存不进去，宿主一离线手机什么都看不到。
  const keep = listMetaOf(payload);
  if (keep) {
    const body = { ...payload };
    delete body.ok;
    delete body.revision;
    delete body.generatedAt;
    return { ...keep, env: seal(body) };
  }
  return seal(payload);
}

/**
 * 这条响应要不要走「外层留元数据、正文进信封」的形状（§8.5）。
 *
 * 只认**列表类**那两条（会话列表 / 工作区列表）：它们带 `revision` 与 `generatedAt`，
 * 而镜像读的就是这两个键。其余响应整包进信封 —— 给每条响应都开一层外壳只会让
 * 「哪些字段是中转能看见的」变成一张需要维护的表。
 *
 * @returns {null | { ok: true, revision?: string, generatedAt?: number }}
 */
function listMetaOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.ok !== true) return null;
  const revision = typeof payload.revision === 'string' ? payload.revision : '';
  const generatedAt = Number.isFinite(payload.generatedAt) ? payload.generatedAt : undefined;
  if (!revision || generatedAt === undefined) return null;
  return { ok: true, revision, generatedAt };
}

/**
 * 响应信封的形状：`{ v: 2, n: <12 字节 base64url>, c: <base64 的密文+tag> }`。
 *
 * `n` 放在信封里是因为响应没有请求头可用。**注意 `seal` 的返回值里已经包含 nonce**
 * （形状是 `nonce || 密文 || tag`），所以这里要把它切成两段分别放进 `n` 与 `c`；
 * 而 App 侧 `open` 期待的入参是 `nonce || 密文 || tag` 一整个 —— 两边拼法不同是刻意的，
 * 拆开是为了让信封自己带上 nonce。
 *
 * AAD 绑的是**请求**的 ts 与 nonce（不是响应自己的）：中转不能把「上一个请求的答复」
 * 塞给「这个请求」，同一个路径上两条并发请求之间也换不了。
 *
 * `z` 只有真的压过明文时才有；没压就一个字段都不多写 —— 信封的形状要与老客户端
 * 认得的那一种逐字节一致。
 */
function wrapper(sealedWithNonce, z) {
  const buf = Buffer.from(sealedWithNonce);
  return {
    v: 2,
    ...(z ? { z } : {}),
    n: buf.subarray(0, e2ee.NONCE_BYTES).toString('base64url'),
    c: buf.subarray(e2ee.NONCE_BYTES).toString('base64'),
  };
}

/** 把 `{ n, c }` 拼回 `open` 要的形状（App 侧同样要这么做，别只取 `c`）。 */
function unwrapper(wire) {
  return Buffer.concat([Buffer.from(String(wire.n), 'base64url'), Buffer.from(String(wire.c), 'base64')]);
}

/**
 * 读原始请求体（信封要求「按线上原样」算摘要，所以不能先 JSON.parse）。
 *
 * 上限按 §8.3(9) 给的数：body 上限按 4/3 放大，判定仍按明文。这里取 8MB，够文件分块那
 * 一档的最大片；超了就当 413，别让一个畸形请求把内存吃光。
 */
// 线上那一侧的上限：最大的明文是上传片（11MB 那一档），信封再加 4/3。
// 明文侧的判定在各自路由里（`readJsonBody(req, ...)`），两边不共用同一个数。
const MAX_SEALED_BODY = Math.ceil(11 * 1024 * 1024 * 4 / 3);

function readRawBody(req, maxBytes = MAX_SEALED_BODY) {
  // **没有请求体的请求不能等 `end`**：SSE 客户端（XHR）发出来的 GET 有时不会像普通
  // fetch 那样把请求流收尾，而守卫在读体这一步就把处理器挡住了 —— 表现是「手机一直在
  // 重连、宿主侧连开流日志都没有」。GET/HEAD 且既没有 content-length
  // 也没有 transfer-encoding，就是没有体，直接回空。
  const method = String((req && req.method) || 'GET').toUpperCase();
  const headers = (req && req.headers) || {};
  if ((method === 'GET' || method === 'HEAD') && !headers['content-length'] && !headers['transfer-encoding']) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('too large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = {
  openRequest,
  sealResponse,
  wrapper,
  unwrapper,
  isProto2,
  headerOf,
  signedPath,
  signedQuery,
  readRawBody,
  MAX_SEALED_BODY,
  TS_WINDOW_MS,
  NONCE_TABLE_SIZE,
};
