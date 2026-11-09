'use strict';

/**
 * 「教一次就学会」的守卫：轨迹 → 结构化路线 → 技能目录草稿 → 按 App/意图召回。
 *
 * 用临时 DSH_HOME 驱动真实现（paths 在调用时解析 env），所以这里真的落盘、读回、收下。
 *
 * 钉的是这几条**规格**，不是实现形状：
 *  1. 抽取只收「整批都成了」且动作都在可重放子集里的轨迹；失败/超步数/表外动作一律不收。
 *  2. 存下来的东西里不许出现 ref、原始像素、用户输入的正文 —— 会变的不存，界面锚才存。
 *  3. 学完一律是待收下的草稿；收下之后才进检索池，检索按 App 强约束（别的 App 的路线不会被套上）。
 *  4. 付款类那一步必须标 `mustConfirmLive`，存档里绝不记「已确认」。
 *  5. 召回只读：查出来的东西里没有任何执行入口字段。
 *
 * 运行：node --test test/phone-skill-learn.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-learn-'));
process.env.DSH_HOME = home;
process.env.DSH_MOBILE_SKILLS = path.join(home, 'skills');
process.env.DSH_MOBILE_SKILL_DRAFTS = path.join(home, 'skill-drafts.json');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const routeExtract = require('../lib/mobile/phone/route-extract.js');
const routeStore = require('../lib/mobile/route-store.js');
const skillRecall = require('../lib/mobile/phone/skill-recall.js');

const PKG = 'com.tencent.mm';

function step(action, args, until) {
  return { action, args: args || {}, ...(until ? { until } : {}) };
}

function allOk(steps) {
  return steps.map(() => ({ ok: true }));
}

/** 一段普通的、没有付款的聊天轨迹。 */
function chatSteps() {
  return [
    step('app.open', { packageName: PKG }),
    step('tap', { ref: 'e5', target: '微信' }),
    step('type', { text: '王小明你在吗' }),
    step('tap', { ref: 'e9', target: '发送' }, { appears: '王小明你在吗' }),
  ];
}

/** 一组带定位骨架的屏幕：用来证明 anchor 保字面量、ref 不落盘。 */
function chatScreens() {
  const tap1 = [{ ref: 'e5', text: '微信', role: 'Button', bounds: [10, 20, 30, 25] }];
  const tap2 = [{ ref: 'e9', text: '发送', role: 'Button', bounds: [80, 90, 95, 95] }];
  return [null, tap1, null, tap2];
}

function extract(overrides = {}) {
  const steps = overrides.steps || chatSteps();
  return routeExtract.extractRoute({
    packageName: overrides.packageName || PKG,
    steps,
    screens: overrides.screens || chatScreens(),
    results: overrides.results || allOk(steps),
    intentText: overrides.intentText !== undefined ? overrides.intentText : '给王小明发条消息',
  });
}

// ── 抽取：收什么、不收什么 ────────────────────────────────────────────────

test('整批都成了的轨迹能抽成一条路线，形状对得上', () => {
  const out = extract();
  assert.equal(out.ok, true, `本该抽出来，却是 ${out.problem}`);
  const route = out.route;
  assert.equal(route.version, routeExtract.ROUTE_VERSION);
  assert.equal(route.app.package, PKG);
  assert.equal(route.outcome, 'done');
  assert.equal(route.steps.length, 4);
  assert.equal(route.intent.shape.firstAction, 'app.open');
  assert.equal(route.intent.shape.stepCount, 4);
  assert.ok(Array.isArray(route.intent.shape.actionBigrams));
  assert.equal(routeExtract.validateRoute(route), null);
});

test('有一步没成就不收：这条轨迹不是「做成的那一次」', () => {
  const out = extract({ results: [{ ok: true }, { ok: true }, { ok: false }, { ok: true }] });
  assert.equal(out.ok, false);
  assert.equal(out.problem, 'not_all_steps_ok');
});

test('表外动作不收：能力面是封闭表，学不进来一个', () => {
  const steps = [step('app.open', { packageName: PKG }), step('shell.exec', { cmd: 'ls' })];
  const out = routeExtract.extractRoute({ packageName: PKG, steps, results: allOk(steps) });
  assert.equal(out.ok, false);
  assert.match(out.problem, /^unreplayable_action:/);
});

test('步数超上限不收', () => {
  const steps = Array.from({ length: routeExtract.MAX_STEPS + 1 }, () => step('key', { key: 'back' }));
  const out = routeExtract.extractRoute({ packageName: PKG, steps, results: allOk(steps) });
  assert.equal(out.ok, false);
  assert.equal(out.problem, 'too_many_steps');
});

test('没有包名 / 没有步骤一律不收', () => {
  assert.equal(routeExtract.extractRoute({ packageName: '', steps: [step('key', { key: 'back' })] }).problem, 'no_package');
  assert.equal(routeExtract.extractRoute({ packageName: PKG, steps: [] }).problem, 'no_steps');
});

// ── 存下来的东西：会变的不存，界面锚才存 ──────────────────────────────────

test('不存 ref：存下来的整条路线里一个 e7 样式的编号都没有', () => {
  const out = extract();
  assert.equal(out.ok, true);
  const raw = JSON.stringify(out.route);
  assert.doesNotMatch(raw, /"ref"\s*:/, '路线里不该有 ref 字段');
  assert.doesNotMatch(raw, /"e\d+"/, '路线里不该有元素编号');
});

test('不存原始像素：位置只有视口百分比，bounds 那种四个数的数组不落盘', () => {
  const out = extract();
  const raw = JSON.stringify(out.route);
  assert.doesNotMatch(raw, /"bounds"/);
  for (const s of out.route.steps) {
    if (!s.locator || !s.locator.relPos) continue;
    assert.ok(s.locator.relPos.x >= 0 && s.locator.relPos.x <= 100, '相对位置必须是 0-100');
    assert.ok(s.locator.relPos.y >= 0 && s.locator.relPos.y <= 100);
  }
});

test('界面锚保留字面量，用户输入的正文换成占位符', () => {
  const out = extract();
  const anchorTexts = out.route.steps.map((s) => (s.locator && s.locator.text) || '').filter(Boolean);
  assert.ok(anchorTexts.includes('微信'), `按钮文字该原样留下，实际是 ${JSON.stringify(anchorTexts)}`);
  assert.ok(anchorTexts.includes('发送'));
  const typed = out.route.steps.find((s) => s.action === 'type');
  assert.equal(typed.args.text, '<参数>', '用户输入的正文不该落盘');
  assert.doesNotMatch(JSON.stringify(out.route), /王小明你在吗/, '输过的原文不许出现在路线里');
});

test('付款 / 下单那一步必须标成「重放时现问」，存档里不写已确认', () => {
  const steps = [
    step('app.open', { packageName: 'com.taobao.com' }),
    step('tap', { ref: 'e1', target: '立即付款' }),
  ];
  const screens = [null, [{ ref: 'e1', text: '立即付款', role: 'Button', bounds: [10, 80, 90, 88] }]];
  const out = routeExtract.extractRoute({
    packageName: 'com.taobao.com',
    steps,
    screens,
    results: allOk(steps),
    intentText: '买下这个',
  });
  assert.equal(out.ok, true);
  const pay = out.route.steps.find((s) => s.locator && s.locator.text === '立即付款');
  assert.equal(pay.mustConfirmLive, true, '付款步必须标成要现问');
  assert.doesNotMatch(JSON.stringify(out.route), /confirmed|approved|allowed-once/, '存档里不许出现「已确认」字样');
});

// ── 落盘：先草稿、收下才生效 ──────────────────────────────────────────────

test('学完先是待收下的草稿，不进检索池', () => {
  fs.rmSync(path.join(home, 'skills'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'skill-drafts.json'), { force: true });

  const out = extract();
  const learned = routeStore.learn(out.route);
  assert.equal(learned.ok, true, `该能学成，却是 ${learned.problem}`);

  assert.equal(routeStore.scan().length, 0, '没收下之前不该出现在已收下的池子里');
  const waiting = routeStore.pending();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].name, learned.name);

  // 草稿不得进召回池：用户收下才生效。
  //
  // 这条以前断的是反的（「草稿阶段也查得到，如实标出来还只是草稿」），于是「等用户收下」
  // 只挡住了「落进技能目录」，没挡住「被模型照着走」—— 模型能拿一份用户还没点头的草稿
  // 直接执行，这道关卡形同虚设。判据改成「查不到」：草稿的出口只有 pending()，
  // 那条路由只喂给用户看的清单，不给 recall。
  const early = routeStore.recall({ packageName: PKG, intentText: '发消息' });
  assert.equal(early, null, '草稿不得进召回池，用户收下才生效');
});

test('收下之后落进技能目录：SKILL.md 有，侧车在 references 下', () => {
  const waiting = routeStore.pending();
  assert.ok(waiting.length > 0, '先要有待收下的草稿');
  const accepted = routeStore.accept(waiting[0].id);
  assert.equal(accepted.ok, true, `该能收下，却是 ${accepted.problem}`);

  const dir = accepted.dir;
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), '技能正文该落盘');
  const sidecar = path.join(dir, 'references', 'route.json');
  assert.ok(fs.existsSync(sidecar), '路线侧车该落在 references/ 下');

  const markdown = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(markdown, /^---\n/, '要有 frontmatter');
  for (const section of ['入口', '步骤', '容易出错的地方', '怎样算办成', '什么时候停下交给用户']) {
    assert.match(markdown, new RegExp(`## ${section}`), `五节里少了「${section}」`);
  }

  const route = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.equal(route.app.package, PKG);
  assert.ok(Array.isArray(route.steps) && route.steps.length > 0);

  assert.equal(routeStore.scan().length, 1, '收下之后该进已收下的池子');
  assert.equal(routeStore.pending().length, 0, '收下的草稿该从待收下里消失');

  // 收下之后才进召回池 —— 这一条与上面「草稿不进池」是一对，缺任何一半都不成立。
  const now = routeStore.recall({ packageName: PKG, intentText: '发消息' });
  assert.ok(now, '收下之后该能召回到');
  assert.equal(now.pending, undefined, '收下的路线不该再带 pending 这个标记');
});

test('丢掉之后不复活：草稿没了、召回池里也没有', () => {
  // 用一个别的 App，不动上面那几条已收下的路线（它们后面的用例还要召回）。
  const OTHER = 'com.example.notes';
  const steps = [
    step('app.open', { packageName: OTHER }),
    step('tap', { ref: 'e1', target: '新建' }),
  ];
  const other = routeExtract.extractRoute({
    packageName: OTHER,
    steps,
    screens: [null, [{ ref: 'e1', text: '新建', role: 'Button', bounds: [70, 20, 90, 26] }]],
    results: allOk(steps),
    intentText: '记一条笔记',
  });
  assert.equal(other.ok, true);
  const learned = routeStore.learn(other.route);
  assert.equal(learned.ok, true);
  const waiting = routeStore.pending().find((row) => row.name === learned.name);
  assert.ok(waiting, '刚学的那条该在待收下清单里');

  assert.equal(routeStore.discard(waiting.id), true, '该能丢掉');
  assert.equal(routeStore.pending().some((row) => row.name === learned.name), false, '丢掉之后不该还在待收下清单里');
  assert.equal(routeStore.scan().some((row) => row.name === learned.name), false, '丢掉不该顺手落进技能目录');
  assert.equal(routeStore.recall({ packageName: OTHER, intentText: '记一条笔记' }), null, '丢掉之后召回池里也不该有它');
});

// ── 检索：App 强约束 + 意图打分 ──────────────────────────────────────────

test('同一个 App 的两件事学成两条，名字不撞、能各自召回', () => {
  const a = extract({ intentText: '给王小明发消息' });
  const otherSteps = [
    step('app.open', { packageName: PKG }),
    step('tap', { ref: 'e2', target: '发现' }),
    step('tap', { ref: 'e3', target: '朋友圈' }),
  ];
  const b = routeExtract.extractRoute({
    packageName: PKG,
    steps: otherSteps,
    screens: [null,
      [{ ref: 'e2', text: '发现', role: 'Button', bounds: [70, 95, 90, 99] }],
      [{ ref: 'e3', text: '朋友圈', role: 'Tab', bounds: [20, 10, 40, 14] }]],
    results: allOk(otherSteps),
    intentText: '看看朋友圈',
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(
    routeStore.routeSkillName(a.route),
    routeStore.routeSkillName(b.route),
    '同一个 App 的两件事不能撞成一个技能名',
  );
});

test('别的 App 的路线绝不被套上来：App 不沾边直接出局', () => {
  const ranked = routeStore.recall({ packageName: 'com.other.app', intentText: '发消息' });
  assert.equal(ranked, null, '换个 App 就该查不到，而不是拿微信那条顶上');
});

test('意图越贴近，打分越高', () => {
  const close = routeStore.recall({ packageName: PKG, intentText: '发消息' });
  assert.ok(close, '该能查到微信那条');
  assert.ok(close.score > 0.5, `同 App + 意图沾边该过阈值，实际 ${close.score}`);
});

test('召回给的是步骤与定位骨架，没有任何执行入口字段', () => {
  const found = routeStore.recall({ packageName: PKG, intentText: '发消息' });
  assert.ok(found);
  const text = skillRecall.renderStep(found.route.steps[0]);
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  const raw = JSON.stringify(found.route);
  assert.doesNotMatch(raw, /shell|exec|command|bash/i, '路线里不许出现像命令的口子');
});

// ── 敏感：先扫一遍再落盘 ──────────────────────────────────────────────────

test('侧车里有像卡号的串就整条拒绝，不落盘', () => {
  fs.rmSync(path.join(home, 'skill-drafts.json'), { force: true });
  const steps = [
    step('app.open', { packageName: 'com.bank.app' }),
    step('type', { text: '6222020200112233445' }),
  ];
  const out = routeExtract.extractRoute({
    packageName: 'com.bank.app',
    steps,
    results: allOk(steps),
    intentText: '付钱',
  });
  // 抽取阶段就把它换成了占位符，落盘的侧车里不该还有那串数字。
  assert.equal(out.ok, true);
  assert.doesNotMatch(JSON.stringify(out.route), /6222020200112233445/);
});

// ── 用户的收下出口：手机上的那两条路由 ────────────────────────────────────
//
// `phone_skill_keep` 那个工具只有模型能调 —— 如果它是唯一入口，「用户收下才生效」这道
// 关卡的实际盖章人就是模型。所以用户自己必须有一条路，这里钉的就是「那条路在、判据对」。

test('收下 / 丢掉那条路由按名字认目标，草稿收下之后才进召回池', async () => {
  const { handleSkillRoutes, handleSkillKeep } = require('../lib/mobile/phone/skill-routes.js');
  const OTHER = 'com.example.mail';
  const steps = [step('app.open', { packageName: OTHER }), step('tap', { ref: 'e1', target: '写邮件' })];
  const out = routeExtract.extractRoute({
    packageName: OTHER,
    steps,
    screens: [null, [{ ref: 'e1', text: '写邮件', role: 'Button', bounds: [80, 90, 95, 96] }]],
    results: allOk(steps),
    intentText: '写一封邮件',
  });
  assert.equal(out.ok, true);
  const learned = routeStore.learn(out.route);
  assert.equal(learned.ok, true);

  // 列表：草稿在里面，且草稿仍然不在召回池里。
  const listed = await callRoute(handleSkillRoutes, {}, {});
  assert.equal(listed.status, 200);
  const row = listed.body.routes.find((r) => r.name === learned.name);
  assert.ok(row, '待收下的草稿该出现在列表里');
  assert.equal(row.stepCount, out.route.steps.length, '列表要告诉用户这条有几步');
  assert.equal(routeStore.recall({ packageName: OTHER, intentText: '写一封邮件' }), null, '没收下之前召回池里不该有');

  // 收下（按名字）：落进技能目录，从那以后召回池里才有。
  const accepted = await callRoute(handleSkillKeep, {}, { action: 'accept', name: learned.name });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.ok, true);
  assert.ok(routeStore.recall({ packageName: OTHER, intentText: '写一封邮件' }), '收下之后该能召回到');

  // 不存在的名字：404，不顺手动别的草稿。
  const missing = await callRoute(handleSkillKeep, {}, { action: 'accept', name: 'phone-nope-000000' });
  assert.equal(missing.status, 404);

  // action 只认那两个。
  const bogus = await callRoute(handleSkillKeep, {}, { action: 'approve', name: learned.name });
  assert.equal(bogus.status, 400);
});

test('丢掉那条路由：草稿消失，不落进技能目录，召回池里也没有', async () => {
  const { handleSkillRoutes, handleSkillKeep } = require('../lib/mobile/phone/skill-routes.js');
  const OTHER = 'com.example.calendar';
  const steps = [step('app.open', { packageName: OTHER }), step('tap', { ref: 'e1', target: '新建日程' })];
  const out = routeExtract.extractRoute({
    packageName: OTHER,
    steps,
    screens: [null, [{ ref: 'e1', text: '新建日程', role: 'Button', bounds: [10, 80, 40, 86] }]],
    results: allOk(steps),
    intentText: '加个日程',
  });
  assert.equal(out.ok, true);
  const learned = routeStore.learn(out.route);
  assert.equal(learned.ok, true);

  const dropped = await callRoute(handleSkillKeep, {}, { action: 'discard', name: learned.name });
  assert.equal(dropped.status, 200);
  assert.equal(dropped.body.routes.some((r) => r.name === learned.name), false, '丢掉之后列表里不该还有它');
  assert.equal(routeStore.scan().some((r) => r.name === learned.name), false, '丢掉不该落进技能目录');
  assert.equal(routeStore.recall({ packageName: OTHER, intentText: '加个日程' }), null);
  // 丢掉是从草稿里删掉，不是标个「已丢弃」等下次复活：再列一次仍然没有。
  const again = await callRoute(handleSkillRoutes, {}, {});
  assert.equal(again.body.routes.some((r) => r.name === learned.name), false, '丢掉的不许复活');
});

test('重放路径仍走封闭动作表：召回出来的每一步都在 REPLAYABLE_ACTIONS 里', () => {
  // 收下的路线不会变成一条新执行入口：模型拿到步骤后仍然写 phone_steps，那批动作要过
  // `tools.js` 的封闭表。这里钉的是「召回给出的东西本身也不越界」。
  const found = routeStore.recall({ packageName: PKG, intentText: '发消息' });
  assert.ok(found, '先要有收下的微信路线');
  for (const s of found.route.steps) {
    assert.ok(routeExtract.REPLAYABLE_ACTIONS.has(s.action), `${s.action} 不在可重放动作表里`);
  }
  assert.equal(routeExtract.validateRoute(found.route), null, '收进来的路线仍满足形状校验');
});

test('付款熔断在重放路径上：付款那一步带着 mustConfirmLive 一起被召回', () => {
  // 「熔断还在」不是靠召回一句话，而是靠那一步上的 `mustConfirmLive` 标记 ——
  // 抽取时打上、侧车里存着、召回时交回给模型，模型照它写的那一批会被 tools.js 切开。
  const steps = [
    step('app.open', { packageName: 'com.taobao.com' }),
    step('tap', { ref: 'e1', target: '立即付款' }),
  ];
  const screens = [null, [{ ref: 'e1', text: '立即付款', role: 'Button', bounds: [10, 80, 90, 88] }]];
  const out = routeExtract.extractRoute({
    packageName: 'com.taobao.com',
    steps,
    screens,
    results: allOk(steps),
    intentText: '买下这个',
  });
  assert.equal(out.ok, true);
  const learned = routeStore.learn(out.route);
  assert.equal(learned.ok, true);
  const waiting = routeStore.pending().find((r) => r.name === learned.name);
  assert.ok(waiting, '先要有一条待收下的付款路线');
  assert.equal(routeStore.accept(waiting.id).ok, true, '该能收下');

  const found = routeStore.recall({ packageName: 'com.taobao.com', intentText: '买下这个' });
  assert.ok(found, '收下之后该能召回');
  const pay = found.route.steps.find((s) => s.locator && s.locator.text === '立即付款');
  assert.ok(pay, '付款那一步要原样带回来');
  assert.equal(pay.mustConfirmLive, true, '付款步必须仍标着「重放时现问」—— 熔断靠这个标记');
  // 召回给的那份渲染也把它写出来，模型照抄时才不会被这步混进批量里。
  const line = skillRecall.renderStep(pay);
  assert.match(line, /付款类/, '渲染结果要说明这一步是付款类');
});

/** 跑一次 handler：把 body / query 灌成一条请求流，收一份 JSON。 */
async function callRoute(handler, query, body) {
  const { Readable } = require('node:stream');
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.headers = {};
  const search = new URLSearchParams(query || {}).toString();
  req.url = `/api/mobile/v1/phone/skill/routes${search ? `?${search}` : ''}`;
  // GET 那条路径不读 body；POST 那条读。两种都给一个可读流，handler 自己决定读不读。
  req.method = Object.keys(body || {}).length > 0 ? 'POST' : 'GET';
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  await handler({}, req, res);
  return res;
}
