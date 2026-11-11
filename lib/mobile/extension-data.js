'use strict';

/**
 * 扩展页「读宿主数据」那条通道的宿主侧（能力 `host.data`）。
 *
 * **为什么需要这一层**：扩展页是从手机本地 `file://` 加载的网页，它自己的 `fetch` 够不到
 * 这台电脑上的服务——跨源、还要凭据。声明了 `hostData` 的扩展把命中的请求（例如 `/api/`）
 * 交给 App，App 转到这里，由宿主**以自己人身份**去问目标服务，再把结果原样递回去。
 *
 * 服务全部由插件自己登记：**第三方插件在自己 `package.json` 里声明 `dshMobileDataServices`**
 * （见 `third-party-extensions.js`）。每个服务自己负责「允许访问哪些路径前缀」（`allow`），
 * 一个服务只该被够到它自己的那部分路径，别拿它当跳板去够同端口的别处。
 *
 * 服务目标固定是宿主自己那个 web 端口（插件接口就注册在同一进程里），凭据用 `launchToken`
 * 换浏览器会话。
 *
 * **边界仍然收着**：只有配好对的手机（这条路由在 token 守卫之后）能调；只能到登记过的服务；
 * 路径必须落在该服务的 `allow` 前缀内；不暴露 shell、系统设置、任意文件读写。请求体与响应体
 * 都有限长，超了如实回错，不硬吃进内存。
 *
 * 纯 Node（http + 文件），无 cordis 依赖，测试可以直接 require 走假服务。
 */

const http = require('node:http');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { hasPermission } = require('./permissions.js');
const { hostPortOf, launchTokenOf } = require('./host-web.js');
const { discoverDataServices } = require('./third-party-extensions.js');

/** 请求体的上限：扩展页发来的是「一条请求」，几个 KB 的 JSON 足够，2MB 已经很宽松。 */
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** 响应体的上限：几百 KB 是常态（magpie 供应商列表就 324KB），给到 16MB 兜住异常大包。 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** 一条代理请求的总时限。目标都是本机服务，慢到这份上就是它自己卡住了。 */
const REQUEST_TIMEOUT_MS = 20000;
/** 只放行这几种方法：读、写、删各一个，别的一律当非法。 */
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** 只要这几项响应头：页面解析正文够用了，别把一整套头也搬来搬去。 */
function pickHeaders(headers) {
  const out = {};
  if (headers && typeof headers['content-type'] === 'string') out['content-type'] = headers['content-type'];
  return out;
}

/** 把一条请求原样代发到目标服务，收集状态码 / 头 / 正文（utf8）。失败回 0 + 一段错误正文。 */
function proxyRequest(port, cookie, method, path, body, contentType) {
  return new Promise((resolve) => {
    const headers = { accept: 'application/json, */*' };
    if (cookie) headers.cookie = cookie;
    const hasBody = typeof body === 'string' && body.length > 0;
    if (hasBody) {
      headers['content-type'] = contentType || 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy();
          finish({ status: 0, headers: {}, body: JSON.stringify({ code: 'response-too-large' }) });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish({
        status: res.statusCode || 0,
        headers: pickHeaders(res.headers),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', (error) => finish({ status: 0, headers: {}, body: JSON.stringify({ code: 'response-failed', message: String(error.message || error) }) }));
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ status: 0, headers: {}, body: JSON.stringify({ code: 'timeout' }) });
    });
    req.on('error', (error) => finish({ status: 0, headers: {}, body: JSON.stringify({ code: 'request-failed', message: String(error.message || error) }) }));
    if (hasBody) req.write(body);
    req.end();
  });
}

/** 一个失败但形状正常的回包：App 侧永远读 `{ status, headers, body }` 这套字段。 */
function failure(res, status, code, message) {
  return sendJson(res, 200, {
    ok: false,
    status,
    headers: {},
    body: JSON.stringify({ code, message }),
    code,
    ...(message === undefined ? {} : { message }),
  });
}

/**
 * 第三方插件声明的数据服务：把它变成一条和静态表同形的 spec。
 *
 * 目标固定是**宿主自己那个 web 端口** —— 第三方插件的接口就注册在同一个进程、同一个
 * `webServer` 上，没有第二个端口要探。凭据也只有一条路：用 `launchToken` 换一张浏览器
 * 会话 cookie（`/api/*` 由连接服务的 `admit()` 认会话，环回地址不作数）。
 *
 * 这样 `allow` 之外的一律 403、没声明的服务一律 404。
 */
function hostServiceSpec(ctx, allow) {
  return {
    allow,
    async resolve() {
      const port = hostPortOf(ctx);
      if (port === null) {
        const error = new Error('service-unavailable');
        error.reason = 'no-port';
        throw error;
      }
      return { port, key: launchTokenOf(ctx) || null };
    },
    async cookie(port, key) {
      return key ? browserCookie(port, key) : '';
    },
  };
}

/** 服务登记表查一次：按插件声明的找。 */
function specOf(ctx, service) {
  const pluginsRoot = profileNodeModulesOf(ctx);
  if (!pluginsRoot) return null;
  const declared = discoverDataServices(pluginsRoot).find((entry) => entry.service === service);
  return declared ? hostServiceSpec(ctx, declared.allow) : null;
}

/** profile 的 `node_modules`：与路由表那侧同一个来源（运行时快照，取不到就当没有）。 */
function profileNodeModulesOf(ctx) {
  try {
    const runtime = typeof ctx?.get === 'function' ? ctx.get('dshMobilePluginRuntime') : null;
    const status = runtime && typeof runtime.status === 'function' ? runtime.status() : null;
    return typeof status?.profileNodeModules === 'string' ? status.profileNodeModules : null;
  } catch {
    return null;
  }
}

/**
 * 用 launch token 换一张浏览器会话 cookie（`GET /connect?token=…` 的 set-cookie）。
 *
 * 目标固定是宿主自己的端口。缓存按端口 + token：同一进程里 token 不变，每次重新握手纯属
 * 浪费。拿不到就回空串，接口会按 401 如实回，比静默吞掉好查。
 */
const hostCookieCache = new Map();
const HOST_COOKIE_TTL_MS = 5 * 60 * 1000;

function browserCookie(port, token) {
  const cacheKey = `${port}:${token}`;
  const hit = hostCookieCache.get(cacheKey);
  if (hit && Date.now() - hit.at < HOST_COOKIE_TTL_MS) return Promise.resolve(hit.cookie);
  return new Promise((resolve) => {
    let done = false;
    const finish = (cookie) => {
      if (done) return;
      done = true;
      if (cookie) hostCookieCache.set(cacheKey, { cookie, at: Date.now() });
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
        // 只取 `name=value` 那一段，Path / HttpOnly 这些属性不进请求头。
        finish(String(raw[0]).split(';')[0]);
      });
    } catch {
      return finish('');
    }
    req.on('timeout', () => { try { req.destroy(); } catch { /* 已断 */ } finish(''); });
    req.on('error', () => finish(''));
    req.end();
  });
}

/**
 * POST /api/mobile/v1/extension/data（token）
 * body: { service, path, method?, body?, contentType? }
 *
 * 只有登记过的服务、落在它 `allow` 前缀内的路径才放行。目标服务的状态码 / 头 / 正文原样带回，
 * 让扩展页像对待一个普通 Response 一样对待它（4xx / 5xx 也照原样，页面自己判断）。
 */
async function handleExtensionData(ctx, req, res) {
  const body = await readJsonBody(req, MAX_REQUEST_BYTES);
  if (!body || typeof body.service !== 'string' || typeof body.path !== 'string') {
    return failure(res, 400, 'bad-request', '需要 { service, path }');
  }
  const service = body.service.trim();
  const spec = specOf(ctx, service);
  if (!spec) return failure(res, 404, 'service-unknown', `没有登记这个服务：${service}`);

  const method = typeof body.method === 'string' ? body.method.trim().toUpperCase() : 'GET';
  if (!METHODS.has(method)) return failure(res, 400, 'bad-method', `不支持的方法：${method}`);
  // 这条路由在外层永远是 POST（分类表只能按它当读放行），真正的方法藏在 body 里。所以写方法
  // 必须在这里按设备单独判：只读档设备否则能借代发通道对扩展后台发写请求。
  if (method !== 'GET' && !hasPermission(req.__dshRecord, 'files.write')) {
    return failure(res, 403, 'permission-denied', '这台设备没有执行该操作的权限');
  }

  const path = body.path.trim();
  if (!path.startsWith('/') || path.startsWith('//')) return failure(res, 400, 'bad-path', '路径必须是本源内的绝对路径');
  const pathname = path.split('?')[0];
  if (spec.allow.length > 0 && !spec.allow.some((prefix) => pathname.startsWith(prefix))) {
    return failure(res, 403, 'path-not-allowed', `这个服务不开放该路径：${pathname}`);
  }

  let target;
  try {
    target = await spec.resolve();
  } catch (error) {
    return failure(res, 503, 'service-unavailable', `${service} 现在不可用：${(error && error.reason) || 'unavailable'}`);
  }

  let cookie = '';
  if (typeof spec.cookie === 'function') {
    try { cookie = await spec.cookie(target.port, target.key); } catch { cookie = ''; }
  }
  const reqBody = typeof body.body === 'string' ? body.body : undefined;
  const contentType = typeof body.contentType === 'string' ? body.contentType : undefined;
  const result = await proxyRequest(target.port, cookie, method, path, reqBody, contentType);
  sendJson(res, 200, { ok: true, status: result.status, headers: result.headers, body: result.body });
}

module.exports = {
  handleExtensionData,
  specOf,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
};
