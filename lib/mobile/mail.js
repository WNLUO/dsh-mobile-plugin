'use strict';

/**
 * 手机邮箱页那三条通道的宿主侧：问「装没装」、读写邮件、写/发草稿。
 *
 * ## 为什么要在宿主绕一圈
 *
 * 电脑上那个 `dsh-email` 插件把三个接口开在宿主自己的 web 端口上，靠 `x-dsh-email-mailbox`
 * 这类专用头 + 同源 + JSON 认身份。手机是另一台设备：它既不是同源，也不该拿到那套接口的整张脸
 * （设置口返回里就有明文授权码）。所以手机打的是我们自己的 `/api/mobile/v1/mail/*`，由宿主
 * **以自己人身份**在 `127.0.0.1:<宿主端口>` 环回再去问它 —— 与 `mobile/extension-data.js`
 * 那套 `host.data` 同一类事。区别在于邮件只有这一个来源，不必做成可登记的通用转发表，
 * 于是单独一份实现，`SERVICES` 那张表一行不动。
 *
 * ## 收口口径
 *
 * 形状与 `mobile/approval-memory` 那两条同一套：坏字段整条丢、超长截断、不掺文案（文案在
 * App 的字典里）。请求体与响应体都有限长，超时也卡死 —— 目标都是本机服务，慢到这份上就是它
 * 自己卡住了，没有理由让一条移动端请求无限等着。凭据永不出宿主：设置口只用它的账号卡片，
 * 明文授权码那些字段连读都读不进来，更不会拼进回包。
 *
 * 纯 Node（http），无 cordis 依赖；测试把 `http.request` 指到本机假服务上跑，不碰真网。
 */

const http = require('node:http');

const { sendJson, readJsonBody } = require('../shared/http-util');

/** 请求体上限：手机上发来的就是一条 JSON 命令，草稿正文最大 200KB，2MB 已经很宽松。 */
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** 响应体上限：邮件正文与文件夹清单几百 KB 是常态，16MB 兜住异常大包。 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** 一条环回请求的总时限。目标都是本机插件，慢到这份上就是它自己卡住了。 */
const REQUEST_TIMEOUT_MS = 20000;
/** 草稿正文上限：超过就整条拒，**不静默截断** —— 截断后发出去的信没人会发现少了后半截。 */
const DRAFT_TEXT_MAX_BYTES = 200 * 1024;

/** 邮件插件那三个口（与它自己注册的路径一致）。 */
const SETTINGS_PATH = '/api/dsh-email/settings';
const MAILBOX_PATH = '/api/dsh-email/mailbox';
const DRAFT_PATH = '/api/dsh-email/drafts';

/** `mailbox` 口允许的邮件动作。附件/内嵌图不走这条（见 docs/mail-app.md §1.2）。 */
const MAIL_ACTIONS = new Set(['list', 'read', 'folders', 'mark', 'search', 'attachment']);
/** `drafts` 口的草稿动作。 */
const DRAFT_ACTIONS = new Set(['save', 'list', 'get', 'send']);
/** `mailbox` 能接受的标记动作。 */
const MARK_VERBS = new Set(['read', 'unread', 'star', 'unstar', 'move']);

/** 宿主 web 服务真正在听的端口。与 `mobile/host-web.js` 同一口径：取实绑值，不取配置首选值。 */
function hostPortOf(ctx) {
  try {
    const port = ctx?.webServer?.port;
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 取 DSH 浏览器会话的 launch token。与 `mobile/host-web.js` 同一来源：连接服务的
 * `browserAuth.launchToken`。用 `ctx.get` 而不是 inject，宿主没这个服务时拿到 null 就好，
 * 不会把整行 inject 挂住。
 */
function launchTokenOf(ctx) {
  try {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : null;
    const token = connection && connection.browserAuth ? connection.browserAuth.launchToken : null;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * 用 launch token 换一张浏览器会话 cookie。
 *
 * **这一跳不是可省的**：宿主把 `/api/*`（邮件插件那三个口就注册在它下面）交给连接服务
 * 的 `admit()` 鉴权 —— 没有浏览器会话 cookie 的请求一律 401，哪怕它来自环回地址。
 * 所以插件必须先在 `/connect?token=…` 上把自己换成一个「已登录的浏览器」，再拿回来的
 * `set-cookie` 去打邮件接口。不这么做，`status` 会一直判成「没装」——症状是用户明明装好了、
 * 手机上却永远看不到邮件。
 *
 * 换到的 cookie 按端口 + token 缓存：同一进程里 token 不变、cookie 长（默认 30 天），
 * 每次请求都重换一遍纯属浪费。`/connect` 是一次 GET + 302，本身也很轻。
 */
const cookieCache = new Map();
const COOKIE_TTL_MS = 5 * 60 * 1000;

function browserCookie(port, token) {
  const cacheKey = `${port}:${token}`;
  const hit = cookieCache.get(cacheKey);
  if (hit && Date.now() - hit.at < COOKIE_TTL_MS) return Promise.resolve(hit.cookie);
  return new Promise((resolve) => {
    let done = false;
    const finish = (cookie) => {
      if (done) return;
      done = true;
      try { req.destroy(); } catch { /* 已经断了 */ }
      if (cookie) cookieCache.set(cacheKey, { cookie, at: Date.now() });
      resolve(cookie);
    };
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        path: `/connect?token=${encodeURIComponent(token)}`,
        method: 'GET',
        headers: { accept: 'text/html, */*' },
        timeout: 5000,
      }, (res) => {
        const raw = res.headers['set-cookie'];
        res.resume();
        if (!raw || !raw.length) return finish('');
        // 只取 `name=value` 那一段，属性（Path/HttpOnly/…）不进请求头。
        finish(String(raw[0]).split(';')[0]);
      });
    } catch {
      return finish('');
    }
    req.on('timeout', () => finish(''));
    req.on('error', () => finish(''));
    req.end();
  });
}

/**
 * 一次带会话的环回请求：先确保拿到 cookie，再把它附在请求上。
 *
 * cookie 拿不到时仍照发（不带 cookie）—— 那种情况网关会回 401，`status` 据此判
 * `forbidden`，比直接判「没装」更接近事实（服务在，只是我们没认上）。
 */
async function authedRequest(ctx, port, options) {
  const token = launchTokenOf(ctx);
  const cookie = token ? await browserCookie(port, token) : '';
  const headers = cookie ? { ...(options.headers || {}), cookie } : (options.headers || {});
  return request(port, { ...options, headers });
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 一个非空字符串最多 max 字节；不满条件的字段整格丢掉（不硬塞空串顶位）。 */
function narrowString(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || Buffer.byteLength(text) > max) return undefined;
  return text;
}

/** 一个落在 [min,max] 的整数；不是安全整数就当没给。 */
function narrowInt(value, min, max) {
  if (!Number.isSafeInteger(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

/**
 * 一封信的 uid 只是句柄：IMAP 是正整数，AgentMail 那类是字符串 id。
 * 数字收成原值（插件两种都收），字符串卡长度并拒绝换行/控制字符 —— 它会拼进 IMAP 命令。
 */
function narrowUid(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text !== '' && text.length <= 998 && !/[\r\n\0]/.test(text)) return text;
  }
  return undefined;
}

/**
 * 把一条环回请求发到 `127.0.0.1:<port>`，收状态码与正文（utf8）。
 *
 * 失败统一回 `status: 0`：连不上 / 超时 / 响应过大都是「这次没问到」，调用方再按档归类，
 * 不把「连不上」伪装成一个 HTTP 状态。
 */
function request(port, { method, path, headers, body }) {
  return new Promise((resolve) => {
    const finalHeaders = { accept: 'application/json, */*', ...headers };
    const hasBody = typeof body === 'string' && body.length > 0;
    if (hasBody) {
      finalHeaders['content-type'] = 'application/json';
      finalHeaders['content-length'] = Buffer.byteLength(body);
    }
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: finalHeaders,
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy();
            finish({ status: 0, json: null, text: '' });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          finish({ status: res.statusCode || 0, json, text });
        });
        res.on('error', () => finish({ status: 0, json: null, text: '' }));
      });
    } catch {
      return finish({ status: 0, json: null, text: '' });
    }
    req.on('timeout', () => {
      req.destroy();
      finish({ status: 0, json: null, text: '' });
    });
    req.on('error', () => finish({ status: 0, json: null, text: '' }));
    if (hasBody) req.write(body);
    req.end();
  });
}

/** 从一次环回结果里挑一句给用户看的话（插件自己的口径优先）。 */
function messageOfResult(result) {
  const json = result && result.json;
  if (isObject(json)) {
    if (isObject(json.error) && typeof json.error.message === 'string') return json.error.message;
    if (typeof json.message === 'string') return json.message;
  }
  return '';
}

/**
 * 设置口的账号卡片 → 只留账号名与地址、默认标记。
 *
 * 设置口回的是整份快照，`value.settings.value` 里就躺着明文授权码。这里**只**从
 * `accountsDetail.list` 里取 name / user / isDefault 三格，别的一概不读 —— 凭据不是
 * 「转发前再删一遍」，而是压根没进过这个函数。
 */
function accountsFromSettings(result) {
  if (result.status !== 200 || !isObject(result.json) || result.json.ok !== true) return null;
  const value = result.json.value;
  if (!isObject(value)) return null;
  const detail = isObject(value.accountsDetail) ? value.accountsDetail : null;
  const list = detail && Array.isArray(detail.list) ? detail.list : null;
  // 有 accountsDetail 或至少 writable/accounts 这两格之一，才认它是邮件插件的设置快照。
  if (!detail && !Array.isArray(value.accounts) && typeof value.writable !== 'boolean') return null;
  const accounts = [];
  for (const card of list || []) {
    if (!isObject(card)) continue;
    const name = narrowString(card.name, 200);
    if (!name) continue;
    accounts.push({
      name,
      address: typeof card.user === 'string' ? card.user.trim() : '',
      default: card.isDefault === true,
    });
  }
  const declared = detail && typeof detail.defaultAccount === 'string' ? detail.defaultAccount.trim() : '';
  const defaultAccount = declared || (accounts.find((entry) => entry.default)?.name ?? '');
  for (const entry of accounts) entry.default = entry.name === defaultAccount;
  const out = { accounts, defaultAccount };
  if (typeof value.version === 'string' && value.version.trim()) out.version = value.version.trim();
  return out;
}

/** mailbox 的 `accounts` 动作 → 同一份账号形状。这条根本不返回凭据，天然干净。 */
function accountsFromMailbox(result) {
  if (result.status !== 200 || !isObject(result.json) || result.json.ok !== true) return null;
  const value = result.json.value;
  if (!isObject(value) || !Array.isArray(value.accounts)) return null;
  const defaultAccount = typeof value.defaultAccount === 'string' ? value.defaultAccount.trim() : '';
  const accounts = [];
  for (const row of value.accounts) {
    if (!isObject(row)) continue;
    const name = narrowString(row.name, 200);
    if (!name) continue;
    accounts.push({
      name,
      address: typeof row.user === 'string' ? row.user.trim() : '',
      default: name === defaultAccount,
    });
  }
  return { accounts, defaultAccount };
}

/**
 * 探活：先问设置口拿账号与默认账号，问不到再问 mailbox 的 accounts 动作。
 *
 * 两条都试过才有资格判「没装」：设置口在某些宿主版本上可能没挂、或者版本不认这套头，
 * 但 mailbox 口照样在。档位按 docs/mail-app.md §1.1：打不通 / 404 → missing，403 → forbidden，
 * 其它 → error。
 */
async function probeStatus(ctx, port) {
  const settings = await authedRequest(ctx, port, {
    method: 'GET',
    path: SETTINGS_PATH,
    headers: { 'x-dsh-email-settings': '1', 'sec-fetch-site': 'none' },
  });
  const fromSettings = accountsFromSettings(settings);
  if (fromSettings) return { ok: true, installed: true, ...fromSettings };

  const mailbox = await authedRequest(ctx, port, {
    method: 'POST',
    path: MAILBOX_PATH,
    headers: { 'x-dsh-email-mailbox': '1', 'sec-fetch-site': 'none' },
    body: JSON.stringify({ action: 'accounts' }),
  });
  const fromMailbox = accountsFromMailbox(mailbox);
  if (fromMailbox) return { ok: true, installed: true, ...fromMailbox };

  const results = [settings, mailbox];
  if (results.some((result) => result.status === 403)) {
    return { ok: true, installed: false, reason: 'forbidden' };
  }
  const errored = results.find((result) => result.status !== 0 && result.status !== 404);
  if (errored) {
    const message = messageOfResult(errored) || '邮件插件没有正常应答。';
    return { ok: true, installed: false, reason: 'error', message };
  }
  return { ok: true, installed: false, reason: 'missing' };
}

/** 一条失败但形状正常的回包：App 侧永远读 `{ ok:false, error:{ code, message } }`。 */
function fail(res, code, message) {
  return sendJson(res, 200, { ok: false, error: { code, message } });
}

/**
 * POST /api/mobile/v1/mail/status
 *
 * 插件没装是一等公民：这条**永远**回 200，用 `installed:false` + `reason` 说清楚，页面据此
 * 摆一句平静的说明，而不是红框 + 重试。只有手机连不上这台电脑本身才是传输层错误。
 */
async function handleMailStatus(ctx, req, res) {
  // 空对象请求体也读掉，别让连接挂在那里。
  await readJsonBody(req, MAX_REQUEST_BYTES);
  const port = hostPortOf(ctx);
  if (port === null) return sendJson(res, 200, { ok: true, installed: false, reason: 'missing' });
  let result;
  try {
    result = await probeStatus(ctx, port);
  } catch {
    result = { ok: true, installed: false, reason: 'error', message: '邮件插件探活失败。' };
  }
  sendJson(res, 200, result);
}

/**
 * 把外部那一条邮件命令收窄成要发给 mailbox 的形状。
 *
 * 只留这个动作用得上的字段，坏字段整格丢、超长截断。`mark` 那一格的内部动作在插件里叫
 * `mark`（契约里称它「内层 action」，但外层已经是 `action`，那两格会撞名，插件实际读的是
 * `mark`），所以外层的 `markAction` 落回上游的 `mark`。`search` 在插件里就是「带 query 的
 * list」，转发时并回 `list` 才走得到它的搜索分支。
 *
 * @returns {object|null} 收窄后的上游请求体；参数不成立回 null（调用方回 bad-request）。
 */
function narrowMailBody(action, body) {
  const out = { action };
  const account = narrowString(body.account, 200);
  if (account !== undefined) out.account = account;
  const folder = narrowString(body.folder, 1024);
  if (folder !== undefined) out.folder = folder;

  if (action === 'list' || action === 'search') {
    if (action === 'search') {
      const query = narrowString(body.query, 500);
      if (query === undefined) return null;
      out.action = 'list';
      out.query = query;
    }
    const limit = narrowInt(body.limit, 1, 100);
    if (limit !== undefined) out.limit = limit;
    const offset = narrowInt(body.offset, 0, 10000);
    if (offset !== undefined) out.offset = offset;
    if (body.unreadOnly === true) out.unreadOnly = true;
    const since = narrowString(body.since, 40);
    if (since !== undefined) out.since = since;
    const until = narrowString(body.until, 40);
    if (until !== undefined) out.until = until;
    return out;
  }

  if (action === 'folders') return out;

  if (action === 'read' || action === 'attachment') {
    const uid = narrowUid(body.uid);
    if (uid === undefined) return null;
    out.uid = uid;
    if (action === 'attachment') {
      const index = narrowInt(body.index, 0, 999);
      if (index !== undefined) out.index = index;
    }
    return out;
  }

  if (action === 'mark') {
    const uid = narrowUid(body.uid);
    if (uid === undefined) return null;
    const verb = narrowString(body.markAction, 20);
    if (!verb || !MARK_VERBS.has(verb)) return null;
    out.uid = uid;
    out.mark = verb;
    const toFolder = narrowString(body.toFolder, 1024);
    if (toFolder !== undefined) out.toFolder = toFolder;
    return out;
  }

  return null;
}

/**
 * 把 mailbox 的成功结果收窄成 App 要的那份形状（App 在 api/domains/mail.ts 里读这些格）。
 *
 * **`hasMore` 是宿主自己算的**：邮件插件 0.24 的 list / search 回包只给 `count`（当前文件夹
 * 或匹配集的总数）与本页 `messages`，没有 `hasMore`。手机要据它决定「还能不能再往下翻」，
 * 所以这里按 `offset + 本页条数 < count` 补一格 —— 少了它，列表滑到底也拉不出第二页，
 * 用户会以为只有 20 封。
 */
function shapeMailResult(action, value, offset) {
  if (action === 'folders') {
    const folders = Array.isArray(value) ? value : (isObject(value) && Array.isArray(value.folders) ? value.folders : []);
    return { ok: true, folders };
  }
  if (action === 'read') {
    return { ok: true, message: isObject(value) ? value : null };
  }
  if (isObject(value)) {
    const out = { ok: true, ...value };
    if ((action === 'list' || action === 'search') && Array.isArray(value.messages)) {
      const count = Number.isSafeInteger(value.count) ? value.count : value.messages.length;
      out.hasMore = (Number.isSafeInteger(offset) ? offset : 0) + value.messages.length < count;
    }
    return out;
  }
  return { ok: true };
}

/** 一次 mailbox 环回结果 → 移动端的统一回包（失败折成封闭几档 code，不抛）。 */
function shapeMailFailure(result) {
  if (result.status === 0 || result.status === 404) {
    return { ok: false, error: { code: 'not-installed', message: '这台电脑上没有邮件插件。' } };
  }
  if (!isObject(result.json)) {
    return { ok: false, error: { code: 'mail-failed', message: '邮件插件没有返回可读的结果。' } };
  }
  if (result.json.ok !== true) {
    const message = messageOfResult(result) || '邮件操作失败。';
    return { ok: false, error: { code: 'mail-failed', message } };
  }
  return null;
}

/**
 * POST /api/mobile/v1/mail —— list / read / folders / mark / search / attachment。
 *
 * 与 mailbox 口同名同参，宿主只做「转发 + 收窄」，不做翻译层；唯一要改的是 `markAction`
 * 落回上游的 `mark`，以及 `search` 并回带 query 的 `list`（插件没有独立的 search 分支）。
 */
async function handleMailRoute(ctx, req, res) {
  const body = await readJsonBody(req, MAX_REQUEST_BYTES);
  if (!isObject(body)) return fail(res, 'bad-request', '请求体必须是一个对象。');
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!MAIL_ACTIONS.has(action)) return fail(res, 'bad-request', '不支持的邮件动作。');

  const upstream = narrowMailBody(action, body);
  if (!upstream) return fail(res, 'bad-request', '这个动作的参数不完整。');

  const port = hostPortOf(ctx);
  if (port === null) return fail(res, 'not-installed', '这台电脑上没有邮件插件。');

  const result = await authedRequest(ctx, port, {
    method: 'POST',
    path: MAILBOX_PATH,
    headers: { 'x-dsh-email-mailbox': '1', 'sec-fetch-site': 'none' },
    body: JSON.stringify(upstream),
  });
  const failed = shapeMailFailure(result);
  if (failed) return sendJson(res, 200, failed);
  sendJson(res, 200, shapeMailResult(action, result.json.value, upstream.offset));
}

/** 往草稿口打一发，返回原始环回结果；调用方自己读 `.json.value`。 */
function draftCall(ctx, port, payload) {
  return authedRequest(ctx, port, {
    method: 'POST',
    path: DRAFT_PATH,
    headers: { 'x-dsh-email-draft': '1', 'sec-fetch-site': 'none' },
    body: JSON.stringify(payload),
  });
}

/**
 * POST /api/mobile/v1/mail/draft —— save / list / get / send。
 *
 * 草稿口的动作名和契约不完全同名：新建是 `create`、改已有是 `update`（要带 revision）、
 * 发送要先 `preview` 拿到一张一次性 plan 再 `send` 并带上确认位。这里替手机把这几步走完，
 * 手机只看到 save / list / get / send 四个动词。发送的「点一下就发出去」在 App 侧已经被
 * 一次确认挡住，这里只负责把确认之后的那条路走完，不自己替用户按下去。
 */
async function handleMailDraft(ctx, req, res) {
  const body = await readJsonBody(req, MAX_REQUEST_BYTES);
  if (!isObject(body)) return fail(res, 'bad-request', '请求体必须是一个对象。');
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!DRAFT_ACTIONS.has(action)) return fail(res, 'bad-request', '不支持的草稿动作。');

  const port = hostPortOf(ctx);
  if (port === null) return fail(res, 'not-installed', '这台电脑上没有邮件插件。');

  if (action === 'save') {
    const text = typeof body.text === 'string' ? body.text : '';
    if (Buffer.byteLength(text, 'utf8') > DRAFT_TEXT_MAX_BYTES) {
      return fail(res, 'bad-request', '草稿正文超过 200KB，请精简后再保存。');
    }
    const id = narrowString(body.id, 200);
    const fields = {
      account: narrowString(body.account, 200),
      to: typeof body.to === 'string' ? body.to : '',
      subject: typeof body.subject === 'string' ? body.subject : '',
      text,
    };
    const payload = { ...fields };
    if (id !== undefined) {
      // 改已有草稿要带乐观并发用的 revision：先读一份拿到它，再 update。
      const got = await draftCall(ctx, port, { action: 'get', id });
      const failed = shapeDraftFailure(got);
      if (failed) return sendJson(res, 200, failed);
      const revision = isObject(got.json.value) ? got.json.value.revision : undefined;
      const result = await draftCall(ctx, port, { action: 'update', id, revision, ...fields });
      return respondDraft(res, 'save', result);
    }
    const result = await draftCall(ctx, port, { action: 'create', ...fields });
    return respondDraft(res, 'save', result);
  }

  if (action === 'list') {
    const payload = { action: 'list' };
    const account = narrowString(body.account, 200);
    if (account !== undefined) payload.account = account;
    const result = await draftCall(ctx, port, payload);
    return respondDraft(res, 'list', result);
  }

  // get / send 都要一个 id。
  const id = narrowString(body.id, 200);
  if (id === undefined) return fail(res, 'bad-request', '这一条需要草稿 id。');

  if (action === 'get') {
    const result = await draftCall(ctx, port, { action: 'get', id });
    return respondDraft(res, 'get', result);
  }

  // send：先取 revision → preview 拿 plan id → 带确认位 send。
  const got = await draftCall(ctx, port, { action: 'get', id });
  const gotFailed = shapeDraftFailure(got);
  if (gotFailed) return sendJson(res, 200, gotFailed);
  const revision = isObject(got.json.value) ? got.json.value.revision : undefined;
  const preview = await draftCall(ctx, port, { action: 'preview', id, revision });
  const previewFailed = shapeDraftFailure(preview);
  if (previewFailed) return sendJson(res, 200, previewFailed);
  const plan = isObject(preview.json.value) ? preview.json.value.id : undefined;
  if (typeof plan !== 'string') return fail(res, 'mail-failed', '邮件插件没有给出可用的发送预览。');
  const result = await draftCall(ctx, port, { action: 'send', id, preview: plan, confirmed: true });
  return respondDraft(res, 'send', result);
}

/** 草稿一次环回失败 → 移动端统一回包（与邮件那条同一档 code）。 */
function shapeDraftFailure(result) {
  if (result.status === 0 || result.status === 404) {
    return { ok: false, error: { code: 'not-installed', message: '这台电脑上没有邮件插件。' } };
  }
  if (!isObject(result.json)) {
    return { ok: false, error: { code: 'mail-failed', message: '邮件插件没有返回可读的结果。' } };
  }
  if (result.json.ok !== true) {
    const message = messageOfResult(result) || '草稿操作失败。';
    return { ok: false, error: { code: 'mail-failed', message } };
  }
  return null;
}

/** 草稿动作的成功结果 → App 要的形状：list 给 drafts，其余给单个 draft。 */
function respondDraft(res, action, result) {
  const failed = shapeDraftFailure(result);
  if (failed) return sendJson(res, 200, failed);
  const value = result.json.value;
  if (action === 'list') {
    const drafts = isObject(value) && Array.isArray(value.drafts) ? value.drafts : [];
    return sendJson(res, 200, { ok: true, drafts });
  }
  if (action === 'send') {
    const draft = isObject(value) && isObject(value.draft) ? value.draft : null;
    return sendJson(res, 200, { ok: true, draft });
  }
  sendJson(res, 200, { ok: true, draft: isObject(value) ? value : null });
}

module.exports = {
  handleMailStatus,
  handleMailRoute,
  handleMailDraft,
  // 测试与装配用得到的那几格常量/纯函数。
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  DRAFT_TEXT_MAX_BYTES,
  hostPortOf,
  narrowMailBody,
};
