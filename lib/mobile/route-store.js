'use strict';

/**
 * 学来的手机路线存哪儿、怎么找回来。
 *
 * ## 为什么落在技能目录，而不是另起一个库
 *
 * 「教一次就学会」学到的是一条**能照着再走一遍的流程**，它本来就是一个技能。所以路线不单独
 * 建库：走 `skill-store` 那套现成的「草稿 → 收下 → 落盘」，落成
 * `<技能根>/<名字>/SKILL.md` + `<技能根>/<名字>/references/route.json`。
 *
 * 技能根取 `<dshHome>/skills`：宿主 `skill.list` 与手机技能菜单只扫项目级 `.dsh/skills` 与这个
 * 全局根，写进插件私有的 `storages/mobile-plugin/skills` 会「保存成功但菜单没有」；全局根换个
 * 工作区也还在。
 *
 * 结构化的那半放在 `references/` 下、不进 `SKILL.md`，理由是三条实打实的：
 *  - `SKILL.md` 正文有 4000 字上限，带定位骨架的步骤很快就撑爆；
 *  - 正文会被 `redact` / `scrubNumbers` 把「两位以上数字」全换成 `<参数>`，坐标、资源 id、
 *    序号会被打碎 —— 那正是步骤里必须原样留下的东西；
 *  - 附件不过这两道处理，机器数据能原样存取。
 *
 * ## 边界
 *
 * - **只写技能目录**：路径全由「固定根 + kebab 名字」拼出来，不接收调用方给的路径。
 * - **一律先 pending**：新学的一条默认草稿状态，用户点头才落盘（`approveDraft`）。
 * - **附件要自己过敏感关卡**：写盘层只扫 `SKILL.md` 正文，`route.json` 得在这里先扫一遍。
 *   轨迹里的账号、单号、长数字串若漏进去，就是绕过脱敏。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');
const skillStore = require('./skill-store.js');
const memory = require('./memory.js');
const { tokenize, routeKey, rankForIntent, describeRoute } = require('./phone/route-extract.js');

/** 侧车在技能目录里的相对路径。改它等于改所有已存在的技能，别动。 */
const ROUTE_RESOURCE = 'references/route.json';

/** 最多收多少条已收下的路线进检索池。 */
const MAX_POOL = 200;

/**
 * 学来的路线落在哪个技能根：缺省 `<dshHome>/skills`，宿主与手机菜单都扫得到；
 * `DSH_MOBILE_SKILLS` 只给测试与装配层覆盖。
 */
function routeSkillsRoot() {
  return process.env.DSH_MOBILE_SKILLS || path.join(dshHome(), 'skills');
}

/** 本模块的统一入口：所有技能库都要指向同一个根，否则学去的和扫出来的不是一处。 */
function openStore(options = {}) {
  return options.store || skillStore.createSkillStore({ rootDir: routeSkillsRoot() });
}

/**
 * 技能名：kebab、英文/数字、带一段稳定的意图指纹。
 *
 * 名字里必须留一段能区分「同一个 App 的不同意图」的东西 —— 否则同一 App 学两件事会撞成
 * 一个技能，第二件直接把第一件覆盖掉。意图是中文时剥掉汉字就什么都不剩，所以这里取
 * `routeKey` 的短指纹当尾巴，它稳定、可复现、也不含用户内容。
 */
function routeSkillName(route) {
  const pkg = route && route.app ? String(route.app.package || '') : '';
  const tail = pkg.split('.').filter(Boolean).slice(-2).join('-') || 'app';
  const ascii = (Array.isArray(route && route.intent && route.intent.tokens) ? route.intent.tokens : [])
    .filter((t) => /^[a-z0-9]+$/.test(t))
    .slice(0, 3)
    .join('-');
  const fingerprint = hashKey(routeKey(route));
  const base = `phone-${tail}${ascii ? `-${ascii}` : ''}-${fingerprint}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return base.slice(0, 64).replace(/-+$/, '') || 'phone-route';
}

/** 稳定短指纹：同一个 App + 同一件事每次都得到同一个名字，不依赖时间或随机数。 */
function hashKey(text) {
  let hash = 0;
  const source = String(text || '');
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).padStart(6, '0').slice(0, 6);
}

/**
 * 把一条路线写成五节 `SKILL.md` 的素材。
 *
 * 五节是 `skill-authoring` 的约定（入口 / 步骤 / 容易出错的地方 / 怎样算办成 / 什么时候停下
 * 交给用户），`skill-store` 会做「缺一节就拒」。这里只给内容，格式由它拼。
 */
function draftOf(route) {
  const pkg = route.app.package;
  const steps = route.steps.map((step, i) => {
    const verb = {
      tap: '点击', type: '输入', swipe: '滑动', key: '按键',
      'app.open': '打开', 'app.close': '关闭', wait: '等待', gesture: '手势',
    }[step.action] || step.action;
    const anchor = step.locator && step.locator.text ? `「${step.locator.text}」` : '';
    const value = step.args && typeof step.args.text === 'string' ? ` ${step.args.text}` : '';
    const confirm = step.mustConfirmLive ? '（付款类，重放时必须当场再确认一次）' : '';
    return `${i + 1}. ${verb}${anchor}${value}${confirm}`;
  });

  const name = routeSkillName(route);
  return {
    name,
    description: `${route.intent.raw || '手机操作'}（${pkg}）。可重放的手机路线，步骤如下；每一步都要先读屏再对目标，界面不符就停下。`,
    title: route.intent.raw ? `手机技能：${route.intent.raw}` : `手机技能：${pkg}`,
    sections: {
      入口: `在 ${pkg} 里做「${route.intent.raw || '这件事'}」：先打开这个 App，等它到前台再动手。`,
      步骤: steps.join('\n'),
      容易出错的地方: [
        '界面改版会让按钮文字对不上；对不上就停下如实说，不要按旧位置硬点。',
        '中途弹出系统框、别的 App 盖上来，先处理掉再继续。',
      ].join('\n'),
      怎样算办成: '用户看到预期的结果，且关键信息（对象、金额、内容）与他当初说的对得上。',
      什么时候停下交给用户: '涉及付款、下单、删除、授权这类收不回来的动作前停下，让用户当场确认。',
    },
  };
}

/**
 * 学一条路线：抽好的 `route` 进草稿（status: pending）。
 *
 * 返回 `{ok:true, draft}` 或 `{ok:false, problem}`。同名已有技能时按「更新草稿」处理，
 * 这样同一个 App 同一件事多教几次不会堆出一串重复技能。用户还没收下的同名旧草稿会被
 * 新的一条顶掉，只留最新的：否则收下第一条之后，后面几条都会死在 `name_taken` 上。
 */
function learn(route, options = {}) {
  if (!route) return { ok: false, problem: 'no_route' };
  const store = openStore(options);
  const input = draftOf(route);

  // 敏感关卡：写盘层只扫正文，侧车得在这里先自己过一遍。命中就整条不要 —— 宁可少学一条，
  // 不落一条带着账号或单号的路线。
  const sidecar = JSON.stringify(route, null, 2);
  let hit = null;
  try { hit = memory.sensitiveHit(sidecar); } catch { hit = null; }
  if (hit) return { ok: false, problem: 'sensitive' };

  const existing = new Set(store.listSkills().map((s) => s.name));

  // 同一件事重跑只留最新一条：旧草稿还挂在那里的话，用户收下第一条后，后面几条会因为
  // 同名技能已存在、又不是它的更新草稿而永久 `name_taken`。这里只删待收下的草稿
  // （`pendingRoutes` 只捞 pending），已收下的技能不在这条路上，不会被静默覆盖。
  for (const old of pendingRoutes(store)) {
    if (old.name === input.name) store.rejectDraft(old.id);
  }

  // 旧草稿已经顶掉了，不再需要更新语义；只有同名**已收下技能**在时才走更新。
  const prepared = store.prepareDraft({
    ...input,
    files: [{ path: ROUTE_RESOURCE, content: sidecar }],
    isUpdateOf: existing.has(input.name) ? input.name : undefined,
    source: 'drafted',
  });
  if (!prepared.ok) return prepared;
  return { ok: true, draft: prepared.draft, name: input.name };
}

/** 收下一份草稿：真正落进技能目录。 */
function accept(draftId, options = {}) {
  const store = openStore(options);
  return store.approveDraft(draftId, options);
}

/** 拒掉一份草稿。 */
function discard(draftId, options = {}) {
  const store = openStore(options);
  return store.rejectDraft(draftId);
}

/** 读一份技能的侧车；读不到 / 读坏 / 形状不对都当没有。 */
function readRoute(skillDir) {
  const file = path.join(skillDir, ROUTE_RESOURCE);
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 512 * 1024) return null;
    const route = JSON.parse(text);
    if (!route || typeof route !== 'object') return null;
    if (!route.app || typeof route.app.package !== 'string') return null;
    if (!Array.isArray(route.steps) || route.steps.length === 0) return null;
    return route;
  } catch {
    return null;
  }
}

/**
 * 技能根下所有带侧车的技能。
 *
 * 直接扫目录而不经 `listSkills`：那个只回 name/description，看不到 routes。扫的边界与
 * `listSkills` 同一层（只看技能根的直接子目录），不递归。
 *
 * 根与写入侧的 `createSkillStore({ rootDir: routeSkillsRoot() })` 必须是同一个，否则学去的
 * 和扫出来的不是一处。`options.rootDir` 只给测试覆盖。
 */
function scan(options = {}) {
  const root = options.rootDir || routeSkillsRoot();
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (out.length >= MAX_POOL) break;
    const dir = path.join(root, name);
    const route = readRoute(dir);
    if (!route) continue;
    out.push({ name, route, learnedAt: route.learnedAt || '' });
  }
  return out;
}

/** 列出待收下的技能草稿里带侧车的那些。 */
function pending(options = {}) {
  return pendingRoutes(openStore(options));
}

/**
 * 同上，直接在给定的技能库上查 —— `learn` 要在同一个库上清掉自己的同名旧草稿，
 * 不能另开一个库。
 */
function pendingRoutes(store) {
  let drafts = [];
  try { drafts = store.listDrafts(); } catch { drafts = []; }
  const out = [];
  for (const draft of drafts) {
    if (!draft || draft.status !== 'pending') continue;
    // 草稿还没落进技能目录，`readResource` 是查已收下的技能、这里读不到。侧车就在草稿自己身上
    // （`prepareDraft` 把 files 一起存进了草稿文件），直接从那份读。
    const full = store.getDraft(draft.id);
    const file = full && Array.isArray(full.files)
      ? full.files.find((f) => f && f.path === ROUTE_RESOURCE)
      : null;
    if (!file || typeof file.content !== 'string') continue;
    let route = null;
    try { route = JSON.parse(file.content); } catch { route = null; }
    if (!route || !Array.isArray(route.steps)) continue;
    out.push({ id: draft.id, name: draft.name, route, createdAt: draft.createdAt });
  }
  return out;
}

/**
 * 按 App + 意图找一条可重放的路线。
 *
 * **池里只有已收下的**（`scan` 扫技能目录里带侧车的那些）。草稿一律不进来 —— 「等用户收下
 * 才生效」如果只挡住落盘、却让模型照着一份还没被点头的草稿去执行，那句话就形同虚设：
 * 用户没收下的东西已经左右了动作。草稿的出口是 `pending()`，只有 `skill-keep` 那条
 * 用户点过的路会读它。
 *
 * 返回 `{ route, name, score }` 或 null。
 *
 * 只认 `rankForIntent` 打分达标的候选：门槛在打分那侧（低于阈值的不会出现在返回里），
 * 这里不自造阈值 —— 返回空就是没有能重放的，宁可不用，也不拿该 App 下别的一条凑数。
 */
function recall({ packageName, intentText, options = {} } = {}) {
  const pool = scan(options);
  if (pool.length === 0) return null;
  const ranked = rankForIntent({ packageName, intentText, candidates: pool });
  const best = Array.isArray(ranked) ? ranked[0] : null;
  if (!best) return null;
  const row = pool.find((p) => p.route === best.route) || {};
  return { route: best.route, name: row.name || '', score: best.score };
}

/** 一条路线渲染成「模型能直接喂给 phone_steps」的样子。 */
function renderForReplay(route) {
  const lines = route.steps.map((step) => {
    const loc = step.locator || {};
    const anchor = [loc.text && `文字「${loc.text}」`, loc.role && `role ${loc.role}`,
      loc.resourceId && `id ${loc.resourceId}`].filter(Boolean).join(' / ');
    const pos = loc.relPos ? `位置 ${loc.relPos.x}%,${loc.relPos.y}%` : '';
    const value = typeof (step.args || {}).text === 'string' ? ` 内容 ${step.args.text}` : '';
    const wait = step.until ? ` 等 ${JSON.stringify(step.until)}` : '';
    const confirm = step.mustConfirmLive ? ' ←付款类，必须单独一步并当场确认' : '';
    return `${step.i + 1}. ${step.action}${anchor || pos ? `：${[anchor, pos].filter(Boolean).join(' ')}` : ''}${value}${wait}${confirm}`;
  });
  return lines.join('\n');
}

module.exports = {
  ROUTE_RESOURCE,
  routeSkillName,
  draftOf,
  learn,
  accept,
  discard,
  readRoute,
  scan,
  pending,
  recall,
  renderForReplay,
  describeRoute,
  tokenize,
  routeKey,
};
