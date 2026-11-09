'use strict';

/**
 * 手机邮箱三条通道的契约守卫（`lib/mobile/mail.js`）。
 *
 * 这一层最容易出的错不是「转发没发出去」，而是「把不该带的东西带出去了」和「把该说清楚的
 * 档位揉成一句报错」。所以这里钉四件事：
 *   一、形状收窄 —— 上游只该收到白名单里的字段，多余的一格都不许混进去；
 *   二、没装插件时 status 永远回 200，reason 分 missing / forbidden / error 三档；
 *   三、mark 两层的动作名不许撞：外层的 `action` 是 `mark`，内层标记动作落到上游的 `mark`；
 *   四、草稿正文超 200KB 当场拒，不静默截断。
 *
 * 全程用本机假服务当「邮件插件」：`http.request` 打的是 127.0.0.1 上这个临时端口，
 * 不碰真网、也不依赖这台机器上到底装没装 dsh-email。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const mail = require('../lib/mobile/mail.js');

/** 假 ServerResponse：只记最后一次 writeHead + end（与 test/host-web.test.cjs 同一形状）。 */
function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(raw) { this.body = JSON.parse(String(raw)); },
  };
}

/** 假 ctx：宿主 web 端口指向本机假服务。 */
function fakeCtx(port) {
  return { webServer: { port } };
}

/** 假请求：handler 只读 `req.body`（守卫已把信封解好放进这里），所以给个对象就够。 */
function fakeReq(body) {
  return { method: 'POST', headers: {}, body };
}

/**
 * 起一个本机假服务，按路径回包，并把每次收到的请求记下来供断言。
 * `routes` 的键是 pathname，值是 `(req, body) => { status, body }`。
 */
function startServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      requests.push({ method: req.method, path: req.url, headers: req.headers, body: parsed, raw });
      const route = routes[req.url];
      const out = route ? route(req, parsed) : { status: 404, body: { ok: false } };
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

/** 拿一个此刻没人监听的端口（起一个再关掉），用来造「打不通」。 */
function closedPort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// ── 一、形状收窄：白名单之外的字段不许漏到上游 ──────────────────────────────

test('list 的形状收窄：多余字段丢掉，超长 folder 截不到就整格丢', async () => {
  const { server, port, requests } = await startServer({
    '/api/dsh-email/mailbox': () => ({ status: 200, body: { ok: true, value: { folder: 'INBOX', messages: [], count: 0, hasMore: false } } }),
  });
  try {
    const res = fakeRes();
    await mail.handleMailRoute(fakeCtx(port), fakeReq({
      action: 'list',
      account: 'work',
      folder: 'INBOX',
      limit: 30,
      offset: 0,
      unreadOnly: true,
      since: '2026-11-01',
      // 下面这些都不在白名单里，绝不能出现在上游请求体里。
      password: 'leak!',
      host: 'evil.example',
      port: 25,
    }), res);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const sent = requests[0].body;
    assert.deepEqual(sent, {
      action: 'list',
      account: 'work',
      folder: 'INBOX',
      limit: 30,
      offset: 0,
      unreadOnly: true,
      since: '2026-11-01',
    });
    assert.equal('password' in sent, false);
    assert.equal('host' in sent, false);
  } finally {
    server.close();
  }
});

test('坏字段整格丢：limit 非整数、uid 非法都不发上去', async () => {
  const { server, port, requests } = await startServer({
    '/api/dsh-email/mailbox': () => ({ status: 200, body: { ok: true, value: { folder: 'INBOX', messages: [], count: 0, hasMore: false } } }),
  });
  try {
    const res = fakeRes();
    await mail.handleMailRoute(fakeCtx(port), fakeReq({ action: 'list', limit: '30', offset: -1 }), res);
    assert.deepEqual(requests[0].body, { action: 'list' });

    const bad = fakeRes();
    await mail.handleMailRoute(fakeCtx(port), fakeReq({ action: 'read', uid: { evil: true } }), bad);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.error.code, 'bad-request');
    assert.equal(requests.length, 1, 'uid 不合法时不该发到上游');
  } finally {
    server.close();
  }
});

// ── 二、没装时三个 reason ────────────────────────────────────────────────────

test('打不通 → missing', async () => {
  const port = await closedPort();
  const res = fakeRes();
  await mail.handleMailStatus(fakeCtx(port), fakeReq({}), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, installed: false, reason: 'missing' });
});

test('404（端口上没有邮件插件）→ missing', async () => {
  const { server, port } = await startServer({}); // 每个路径都回 404
  try {
    const res = fakeRes();
    await mail.handleMailStatus(fakeCtx(port), fakeReq({}), res);
    assert.deepEqual(res.body, { ok: true, installed: false, reason: 'missing' });
  } finally {
    server.close();
  }
});

test('403（有服务但拒了我们）→ forbidden', async () => {
  const deny = () => ({ status: 403, body: { ok: false } });
  const { server, port } = await startServer({
    '/api/dsh-email/settings': deny,
    '/api/dsh-email/mailbox': deny,
  });
  try {
    const res = fakeRes();
    await mail.handleMailStatus(fakeCtx(port), fakeReq({}), res);
    assert.deepEqual(res.body, { ok: true, installed: false, reason: 'forbidden' });
  } finally {
    server.close();
  }
});

test('其它错误 → error，并带一句 message', async () => {
  const boom = () => ({ status: 500, body: { ok: false, error: { message: '邮件服务起不来' } } });
  const { server, port } = await startServer({
    '/api/dsh-email/settings': boom,
    '/api/dsh-email/mailbox': boom,
  });
  try {
    const res = fakeRes();
    await mail.handleMailStatus(fakeCtx(port), fakeReq({}), res);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.installed, false);
    assert.equal(res.body.reason, 'error');
    assert.equal(res.body.message, '邮件服务起不来');
  } finally {
    server.close();
  }
});

test('装好了：账号从设置口取，明文授权码不进回包', async () => {
  const { server, port } = await startServer({
    '/api/dsh-email/settings': () => ({
      status: 200,
      body: {
        ok: true,
        value: {
          settings: { value: { password: 'PLAINTEXT-AUTH-CODE', accountsYaml: 'password: PLAINTEXT-AUTH-CODE' } },
          accountsDetail: {
            defaultAccount: 'work',
            list: [
              { name: 'work', user: 'me@corp.com', isDefault: true, hasPassword: true },
              { name: 'home', user: 'me@home.com', isDefault: false },
            ],
          },
        },
      },
    }),
  });
  try {
    const res = fakeRes();
    await mail.handleMailStatus(fakeCtx(port), fakeReq({}), res);
    assert.equal(res.body.installed, true);
    assert.deepEqual(res.body.accounts, [
      { name: 'work', address: 'me@corp.com', default: true },
      { name: 'home', address: 'me@home.com', default: false },
    ]);
    assert.equal(res.body.defaultAccount, 'work');
    assert.equal(JSON.stringify(res.body).includes('PLAINTEXT-AUTH-CODE'), false, '明文授权码不许进回包');
  } finally {
    server.close();
  }
});

// ── 三、mark 两层动作不撞名 ─────────────────────────────────────────────────

test('mark：外层 action 是 mark，内层 markAction 落到上游的 mark 格', async () => {
  const { server, port, requests } = await startServer({
    '/api/dsh-email/mailbox': () => ({ status: 200, body: { ok: true, value: { ok: true } } }),
  });
  try {
    const res = fakeRes();
    await mail.handleMailRoute(fakeCtx(port), fakeReq({
      action: 'mark',
      account: 'work',
      folder: 'INBOX',
      uid: 12345,
      markAction: 'star',
    }), res);
    assert.equal(res.body.ok, true);
    const sent = requests[0].body;
    assert.equal(sent.action, 'mark');
    assert.equal(sent.mark, 'star');
    assert.equal('markAction' in sent, false);
  } finally {
    server.close();
  }
});

// ── 四、草稿正文超 200KB 被拒 ────────────────────────────────────────────────

test('草稿正文超过 200KB：当场 bad-request，一个字都不发给上游', async () => {
  let hits = 0;
  const { server, port } = await startServer({
    '/api/dsh-email/drafts': () => { hits += 1; return { status: 200, body: { ok: true, value: {} } }; },
  });
  try {
    const res = fakeRes();
    await mail.handleMailDraft(fakeCtx(port), fakeReq({
      action: 'save',
      to: 'a@b.com',
      subject: 'big',
      text: 'x'.repeat(200 * 1024 + 1),
    }), res);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'bad-request');
    assert.equal(hits, 0, '超限的正文不该发到上游');
  } finally {
    server.close();
  }
});

test('草稿 save（无 id）转发成上游的 create', async () => {
  const { server, port, requests } = await startServer({
    '/api/dsh-email/drafts': () => ({ status: 200, body: { ok: true, value: { id: 'd1', account: 'work', to: 'a@b.com', subject: 'hi', text: 'yo' } } }),
  });
  try {
    const res = fakeRes();
    await mail.handleMailDraft(fakeCtx(port), fakeReq({
      action: 'save',
      account: 'work',
      to: 'a@b.com',
      subject: 'hi',
      text: 'yo',
    }), res);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.draft.id, 'd1');
    assert.equal(requests[0].body.action, 'create');
    assert.equal(requests[0].body.password, undefined);
  } finally {
    server.close();
  }
});

// ── 五、浏览器会话 cookie：不带它上游一律 401，功能等于死的 ──────────────────
//
// 宿主的 `/api/*`（邮件那三个口就挂在它下面）认的是浏览器会话 cookie，环回地址本身不作数。
// 所以插件必须先在 `/connect?token=…` 上换一张 cookie，再拿它去打邮件接口。漏了这一跳，
// 真机上会一直判「没装」——用户装好了却看不到邮件，而且看不出为什么。

/** 假 ctx：带 launch token，好让 authedRequest 去换 cookie。 */
function fakeCtxWithToken(port, token) {
  return {
    webServer: { port },
    get(name) {
      if (name !== 'connection') return null;
      return { browserAuth: { launchToken: token } };
    },
  };
}

test('先用 launch token 换 cookie，再带着它去打邮件口', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers });
      if (req.url.startsWith('/connect')) {
        res.writeHead(302, {
          location: './api/remote.mux',
          'set-cookie': 'dsh_session=abc123; Path=/; HttpOnly',
        });
        res.end();
        return;
      }
      // 设置口故意 404（某些宿主版本没挂它），好让探活落到 mailbox 的 accounts 动作上。
      if (req.url === '/api/dsh-email/settings') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value: { accounts: [{ name: 'work', user: 'me@corp.com' }], defaultAccount: 'work' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = fakeRes();
    await mail.handleMailStatus(fakeCtxWithToken(port, 'launch-token-xyz'), fakeReq({}), res);
    assert.equal(res.body.installed, true);
    assert.equal(res.body.defaultAccount, 'work');

    const connect = seen.find((entry) => entry.path.startsWith('/connect'));
    assert.ok(connect, '必须先打 /connect 换 cookie');
    assert.match(connect.path, /token=launch-token-xyz/);

    const mailbox = seen.find((entry) => entry.path === '/api/dsh-email/mailbox');
    assert.ok(mailbox, '换到 cookie 之后还要去打邮件口');
    assert.match(String(mailbox.headers.cookie || ''), /dsh_session=abc123/);
  } finally {
    server.close();
  }
});
