'use strict';

/**
 * 扩展卡的宿主侧：卡状态账本与宿主动作登记表（`lib/mobile/extensions.js`）。
 *
 * 这条守卫钉的是四件真会影响手机上的事：
 *
 *  1. 回写过的卡状态必须读得回来 —— App 进会话时拿它盖在「声明那一刻」的卡上，
 *     丢了卡就永远停在旧标题；
 *  2. 标题与说明各截到 200 字符 —— 卡只画一行，长正文会把那张卡撑坏；
 *  3. 整张表封顶 500 条、超了丢最旧的 —— 账本按会话累积，不封顶会一直长下去；
 *  4. **没登记的动作名一律拒**，连 `*` 也不算通配 —— 宿主动作这一档现在一张都没登记，
 *     这条就是那条安全边界的活体证明：扩展不能靠拼一个名字让宿主办事。
 *
 * 账本落在 `$DSH_HOME/mobile-extension-cards.json`，所以整套用临时目录顶着 DSH_HOME 跑，
 * 不碰本机真的那份。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
  actionsFor,
  runAction,
  readCards,
  writeCard,
  registerExtensionTool,
  installExtensions,
  handleExtensionCards,
  handleExtensionCardState,
  handleExtensionAction,
  MAX_TEXT,
  MAX_CARDS,
} = require('../lib/mobile/extensions.js');
const { readRouteTable } = require('./lib/wiring.cjs');

/** 一个临时 DSH_HOME；每个用例自己建、自己删，账本不会串味。 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-extension-'));
  process.env.DSH_HOME = home;
  return home;
}

function restoreHome(previous, home) {
  if (previous === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
}

const ledgerFile = (home) => path.join(home, 'mobile-extension-cards.json');

/** 假 ServerResponse：与 http-routing.test.cjs 同一形状，只记最后一次回包。 */
function fakeRes() {
  const res = { status: 0, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(String(payload)); };
  return res;
}

/** 假 IncomingMessage：GET 用那份带 url 的，POST 用一份真吐 body 的读流。 */
function fakeGet(url) {
  return { url, method: 'GET', headers: {} };
}

function fakePost(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.url = '/api/mobile/v1/extension/card-state';
  req.method = 'POST';
  req.headers = {};
  return req;
}

test('回写一条卡状态，读回来字段齐全', () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    const written = writeCard({
      sessionId: 'session-1',
      cardId: 'call-7',
      extension: 'wechat-draft',
      title: '公众号草稿',
      detail: '已生成 3 段，待发布',
    });
    assert.ok(written, '合法的卡状态不该被拒');
    assert.equal(written.sessionId, 'session-1');
    assert.equal(written.cardId, 'call-7');
    assert.equal(written.extension, 'wechat-draft');
    assert.equal(typeof written.updatedAt, 'number');

    const cards = readCards('session-1');
    assert.equal(cards.length, 1, '刚写的那一条必须读得回来');
    assert.deepEqual(
      { cardId: cards[0].cardId, extension: cards[0].extension, title: cards[0].title, detail: cards[0].detail },
      { cardId: 'call-7', extension: 'wechat-draft', title: '公众号草稿', detail: '已生成 3 段，待发布' },
    );
    assert.equal(typeof cards[0].updatedAt, 'number', 'updatedAt 是 App 排序用的，不能缺');

    // 别的会话看不到这一条：账本按 sessionId 分视图，不按卡 id 全局返回。
    assert.deepEqual(readCards('session-2'), []);

    // 同一张卡再回写是覆盖，不是追加。
    writeCard({ sessionId: 'session-1', cardId: 'call-7', extension: 'wechat-draft', title: '已发布', detail: '' });
    const again = readCards('session-1');
    assert.equal(again.length, 1, '同一张卡回写应当覆盖原记录');
    assert.equal(again[0].title, '已发布');
  } finally {
    restoreHome(previous, home);
  }
});

test('参数不合法回 null：三样身份缺一不可，标题与说明不能都空', () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    assert.equal(writeCard({ cardId: 'c', extension: 'e', title: 't' }), null, '缺 sessionId 不该收');
    assert.equal(writeCard({ sessionId: 's', extension: 'e', title: 't' }), null, '缺 cardId 不该收');
    assert.equal(writeCard({ sessionId: 's', cardId: 'c', title: 't' }), null, '缺 extension 不该收');
    assert.equal(writeCard({ sessionId: 's', cardId: 'c', extension: 'e' }), null, '标题与说明都空不该收');
    assert.equal(writeCard(null), null);
    assert.deepEqual(readCards('s'), [], '被拒的写入一条都不该落盘');
  } finally {
    restoreHome(previous, home);
  }
});

test('标题与说明各截到 200 字符', () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    assert.equal(MAX_TEXT, 200, '上限就是 200，App 那张卡只画一行');
    const long = '标'.repeat(500);
    const longDetail = '说'.repeat(500);
    writeCard({ sessionId: 'session-long', cardId: 'call-1', extension: 'ext', title: long, detail: longDetail });
    const [card] = readCards('session-long');
    assert.equal(card.title.length, MAX_TEXT, `标题应截到 ${MAX_TEXT}，实际 ${card.title.length}`);
    assert.equal(card.detail.length, MAX_TEXT, `说明应截到 ${MAX_TEXT}，实际 ${card.detail.length}`);
    assert.equal(card.title, '标'.repeat(MAX_TEXT));
    assert.equal(card.detail, '说'.repeat(MAX_TEXT));
  } finally {
    restoreHome(previous, home);
  }
});

test(`表满 ${MAX_CARDS} 条时丢掉最旧的那几条`, () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    assert.equal(MAX_CARDS, 500, '上限变了就得重新想清楚「丢哪条」');
    // 直接铺一份满表：updatedAt 按 1..501 递增，最旧的那条就是 1。走真账本文件而不是
    // 连写 501 次，是为了让「谁最旧」只由 updatedAt 决定，不受写盘快慢影响。
    const table = {};
    for (let index = 1; index <= MAX_CARDS; index += 1) {
      table[`session-bulk:${index}`] = {
        sessionId: 'session-bulk',
        cardId: `card-${index}`,
        extension: 'ext',
        title: `卡 ${index}`,
        detail: '',
        updatedAt: index,
      };
    }
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(ledgerFile(home), `${JSON.stringify(table, null, 2)}\n`);

    writeCard({ sessionId: 'session-bulk', cardId: 'card-new', extension: 'ext', title: '新卡', detail: '' });

    const cards = readCards('session-bulk');
    assert.equal(cards.length, MAX_CARDS, `超限之后应回到 ${MAX_CARDS} 条，实际 ${cards.length}`);
    const ids = new Set(cards.map((card) => card.cardId));
    assert.ok(!ids.has('card-1'), '最旧的那条必须被丢掉');
    assert.ok(ids.has('card-new'), '刚写的那条必须在表里');
    assert.ok(ids.has(`card-${MAX_CARDS}`), '较新的那条不该被误丢');
  } finally {
    restoreHome(previous, home);
  }
});

test('宿主动作登记表现在是空的：任何动作名都拒，`*` 也不是通配', async () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    assert.deepEqual(actionsFor('wechat-draft'), [], '还没登记过任何扩展，一律空数组');
    assert.deepEqual(actionsFor(''), []);
    assert.deepEqual(actionsFor('*'), []);

    for (const action of ['publish', 'delete-all', '*', '']) {
      const outcome = await runAction({ extension: 'wechat-draft', action });
      assert.equal(outcome.ok, false, `动作 ${JSON.stringify(action)} 不该被放行`);
      assert.equal(outcome.code, 'extension-action-unknown');
      assert.equal(typeof outcome.message, 'string');
      assert.ok(!outcome.result, '被拒的动作不该带回任何结果');
    }
    // 失败是预期结果，不是异常：调用方要拿它回 403，而不是 500。
    assert.equal((await runAction({ extension: 'wechat-draft', action: 'publish' })).ok, false);
  } finally {
    restoreHome(previous, home);
  }
});

test('三条路由的回包形状：缺参 400、没登记的动作 403 + code', async () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    // GET /extension/cards 必须有 sessionId，缺了不许拿空数组冒充「没有卡」。
    let res = fakeRes();
    await handleExtensionCards({}, fakeGet('/api/mobile/v1/extension/cards'), res);
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);

    res = fakeRes();
    await handleExtensionCards({}, fakeGet('/api/mobile/v1/extension/cards?sessionId=session-route'), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.cards, []);

    // POST /extension/card-state：写进去之后同一条 GET 读得到。
    res = fakeRes();
    await handleExtensionCardState({}, fakePost({
      sessionId: 'session-route', cardId: 'call-9', extension: 'wechat-draft', title: '草稿', detail: '待发布',
    }), res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.card.cardId, 'call-9');

    res = fakeRes();
    await handleExtensionCards({}, fakeGet('/api/mobile/v1/extension/cards?sessionId=session-route'), res);
    assert.equal(res.body.cards.length, 1, '刚回写的那张卡必须出现在 GET 里');

    // 缺身份字段一律 400。
    res = fakeRes();
    await handleExtensionCardState({}, fakePost({ sessionId: 'session-route', title: '只有标题' }), res);
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);

    // POST /extension/action：没登记的动作是 403，顶层带 code（App 读的是 body.code）。
    res = fakeRes();
    await handleExtensionAction({}, fakePost({ extension: 'wechat-draft', action: 'publish' }), res);
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'extension-action-unknown');
    assert.equal(typeof res.body.message, 'string');
    assert.equal(res.body.result, undefined, '被拒的动作不该带回任何结果');

    // 缺 extension / action 是请求本身坏了，回 400 而不是 403。
    res = fakeRes();
    await handleExtensionAction({}, fakePost({ extension: 'wechat-draft' }), res);
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  } finally {
    restoreHome(previous, home);
  }
});

test('extension_present 工具：参数与输出就是 App 拼卡的那三样', async () => {
  let registered = null;
  const ctx = { tools: { register: (tool) => { registered = tool; } } };
  registerExtensionTool(ctx);
  assert.ok(registered, '工具必须被注册进 ctx.tools');
  assert.equal(registered.name, 'extension_present', 'App 按这个名字认轮尾卡');
  const required = registered.parameters.required || [];
  assert.deepEqual([...required].sort(), ['extension', 'title'], 'extension 与 title 必填，detail 可选');
  assert.equal(registered.parameters.properties.detail.type, 'string');

  const value = await registered.execute({ extension: 'wechat-draft', title: '草稿' });
  assert.deepEqual(value, { extension: 'wechat-draft', title: '草稿', detail: '' });
  const rendered = registered.output.render({}, value);
  assert.equal(rendered[0].text, '已为扩展 wechat-draft 声明卡片：草稿');
});

test('没有 tools 注入时静默跳过；别的注册失败照抛', () => {
  // cordis 缺注入抛的是 "cannot get property … without inject"，与 session-cleanup 同一口径。
  const missing = { get tools() { throw new Error('cannot get property "tools" without inject'); } };
  assert.doesNotThrow(() => installExtensions(missing), '缺 tools 注入的 profile 不该因此装不上插件');

  const broken = { tools: { register() { throw new Error('tool registry exploded'); } } };
  assert.throws(() => installExtensions(broken), /tool registry exploded/, '真的注册失败不能被吞掉');
});

test('三条路由接在移动端路由表上', () => {
  const table = readRouteTable();
  for (const route of ['/api/mobile/v1/extension/cards', '/api/mobile/v1/extension/card-state', '/api/mobile/v1/extension/action']) {
    assert.ok(table.includes(`'${route}'`), `${route} 没挂上，手机上必然 404`);
  }
});
