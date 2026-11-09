'use strict';

/**
 * `phone_skill_recall`：把以前学成的那条路线找回来，**给模型照着一步步做**。
 *
 * ## 为什么不直接自动重放
 *
 * 自动重放要在插件里再写一套「读屏 → 认目标 → 下发动作 → 等条件」的循环，那等于把 `phone_steps`
 * 已经做对的执行链复制一份，两份迟早不同步；更要紧的是能力面：重放一旦能自己往下推，就意味着
 * 有了一条不受模型逐步判断约束的执行入口。所以这里只做「查 + 摆出来」：
 *
 *   - 查到的是**这一步要动什么**（动作、目标文字、相对位置、等待条件），
 *   - 模型照它写成一串 `phone_steps` 调用，**走的还是原来那十几个动作**，
 *   - 付款 / 不可逆那一步照旧被 `phone_steps` 与 `phone_tap` 的熔断拦下。
 *
 * 换句话说：这是 `phone_route_hint` 的升级版 —— 那个给的是人话摘要，这个给的是能直接
 * 落成动作的目标描述，但两者都**不自动执行**。
 *
 * 与 `phone_route_hint` 的分工：那个读的是「成功过的路线摘要」（每个 App 最多 20 条，人读的），
 * 在还没学成技能时仍然有用；这个读的是学成并收下的**技能路线**（带定位骨架），更精确。
 */

const routeStore = require('../route-store.js');

/** 一条路线最多回几步给模型，多了一眼看不完。 */
const MAX_RENDER_STEPS = 20;

/** 注册方式与 `route-hint.js` 一致：走 `ctx.inject(['tools'])`，缺注入就静默跳过。 */
function installSkillRecall(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return;
  let defineTool;
  try {
    ({ defineTool } = require('@deepseek-ai/dsh-tools'));
  } catch {
    return;
  }

  ctx.inject(['tools'], (scoped) => {
    if (!scoped || !scoped.tools || typeof scoped.tools.register !== 'function') return;
    scoped.tools.register(defineTool({
      name: 'phone_skill_recall',
      description: 'Look up a phone route that was learned earlier for this app and goal, as concrete step targets. This does NOT execute anything: read the screen, then drive the same phone_* tools yourself, one step at a time. Each step tells you what to act on (text/role/relative position) and what to wait for. If the screen does not match, stop and say so — never fire blind at a stale position.',
      parameters: {
        packageName: {
          type: 'string',
          required: true,
          description: 'Android package name of the app, e.g. "com.tencent.mm".',
        },
        intent: {
          type: 'string',
          description: 'What the user wants to do in that app, in their own words. Used to pick the closest learned route.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            found: { type: 'boolean' },
            name: { type: 'string' },
            steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.found) return [{ type: 'text', text: value.note || '没有学过这个 App 里这件事的路线。' }];
          const lines = [
            `找到一条已收下的路线「${value.name}」。`,
            '照着它走，但每一步都先 phone_screen 看当前屏、按当前屏的 ref 动作；对不上就停下如实说，不要按旧位置硬点：',
          ];
          for (const step of value.steps || []) lines.push(step.line);
          if (value.note) lines.push(value.note);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      execute: async (args) => {
        const pkg = typeof args.packageName === 'string' ? args.packageName.trim() : '';
        if (!pkg) throw new Error('要给一个包名（例如 com.tencent.mm）才能查学过的路线。');
        const intent = typeof args.intent === 'string' ? args.intent.trim() : '';

        let found = null;
        try {
          found = routeStore.recall({ packageName: pkg, intentText: intent });
        } catch {
          found = null;
        }
        if (!found) {
          return {
            ok: true,
            found: false,
            steps: [],
            note: '这个 App 里这件事还没有收下的路线。自己按当前屏想办法做；跑成一批之后会自动学成一条草稿，要用户在手机上的「学到的路线」里收下才会出现在这里。',
          };
        }

        const route = found.route;
        const steps = route.steps.slice(0, MAX_RENDER_STEPS).map((step) => ({
          index: step.i + 1,
          action: step.action,
          line: renderStep(step),
          ...(step.mustConfirmLive ? { mustConfirmLive: true } : {}),
        }));
        const value = { ok: true, found: true, name: found.name, steps };
        if (steps.some((s) => s.mustConfirmLive)) {
          value.note = '这条路线里有一步是付款 / 下单类：那一步必须单独做、当场让用户确认，不能并进批量。';
        } else if (route.steps.length > MAX_RENDER_STEPS) {
          value.note = `这条路线比这里露出来的长（共 ${route.steps.length} 步），后面几步先按当前屏自己判断。`;
        }
        return value;
      },
    }));
  });
}

/**
 * `phone_skill_keep`：把一条学成的路线**收下**（或丢掉）。
 *
 * 学成之后一律先是待收下的草稿 —— 这是「学歪了不会被立刻用上」的保证。收下要人来点，
 * 所以做成两步：先看清单，再按名字收下 / 丢掉，不按 id —— id 是随机串，用户看不见。
 */
function installSkillKeep(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return;
  let defineTool;
  try {
    ({ defineTool } = require('@deepseek-ai/dsh-tools'));
  } catch {
    return;
  }

  ctx.inject(['tools'], (scoped) => {
    if (!scoped || !scoped.tools || typeof scoped.tools.register !== 'function') return;
    scoped.tools.register(defineTool({
      name: 'phone_skill_keep',
      description: 'List phone routes learned from past successful runs that are waiting for the user to accept them, or accept/discard one by name. Learning never takes effect on its own: a route stays a draft until accepted here, and only then can phone_skill_recall serve it. Listing and discarding are always safe; accepting is the one step that makes a learned route live, so do it only after the user says to keep that one.',
      parameters: {
        action: {
          type: 'string',
          description: 'list (default), accept, or discard.',
        },
        name: {
          type: 'string',
          description: 'Route name from the list, e.g. "phone-tencent-mm-ryysm9". Required for accept and discard.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            routes: { type: 'array', items: { type: 'object', additionalProperties: true } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const rows = Array.isArray(value.routes) ? value.routes : [];
          if (rows.length === 0) return [{ type: 'text', text: value.note || '现在没有等着收下的路线。' }];
          const lines = [`${rows.length} 条学成、还没收下的路线：`];
          for (const row of rows) lines.push(`- ${row.name}：${row.summary}`);
          if (value.note) lines.push(value.note);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      execute: async (args) => {
        const action = typeof args.action === 'string' && args.action.trim() ? args.action.trim().toLowerCase() : 'list';
        if (action === 'list') {
          const rows = listPending();
          const value = { ok: true, routes: rows };
          if (rows.length === 0) value.note = '现在没有等着收下的路线。跑成一批手机操作之后会自动学下来，等你确认。';
          return value;
        }
        if (action !== 'accept' && action !== 'discard') {
          throw new Error('action 只能是 list / accept / discard。');
        }
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) throw new Error('要收下或丢掉哪一条？给名字（先用 list 看有哪些）。');
        const target = listPending().find((row) => row.name === name);
        if (!target) throw new Error(`没有叫「${name}」的待收下路线。先用 list 看现在有哪些。`);
        const result = action === 'accept'
          ? routeStore.accept(target.id)
          : (routeStore.discard(target.id) ? { ok: true } : { ok: false, problem: 'not_found' });
        if (!result || result.ok !== true) {
          const problem = (result && result.problem) || 'failed';
          throw new Error(problem === 'sensitive'
            ? '这条路线里有像账号 / 卡号这类敏感内容，没有收下。'
            : `这条路线没能${action === 'accept' ? '收下' : '丢掉'}（${problem}）。`);
        }
        const left = listPending();
        return {
          ok: true,
          routes: left,
          note: action === 'accept'
            ? `收下了「${name}」，下次在同一个 App 里做同一件事时就能查到它。`
            : `丢掉了「${name}」。`,
        };
      },
    }));
  });
}

/** 待收下的路线，压成「名字 + 一句话」。 */
function listPending() {
  let rows = [];
  try { rows = routeStore.pending(); } catch { rows = []; }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    summary: routeStore.describeRoute(row.route) || '这条路线没有可读的步骤摘要',
  }));
}

/** 一步 → 一句能直接落成 phone_* 调用的话。 */function renderStep(step) {
  const loc = step.locator || {};
  const anchors = [];
  if (loc.text) anchors.push(`文字「${loc.text}」`);
  if (loc.role) anchors.push(`role ${loc.role}`);
  if (loc.resourceId) anchors.push(`id ${loc.resourceId}`);
  if (loc.relPos) anchors.push(`位置约 ${loc.relPos.x}% / ${loc.relPos.y}%`);
  const bits = [`${step.i + 1}. ${step.action}`];
  if (anchors.length > 0) bits.push(`：${anchors.join('，')}`);
  const args = step.args || {};
  if (typeof args.text === 'string') bits.push(`；输入 ${args.text}`);
  if (typeof args.packageName === 'string' && step.action.startsWith('app.')) bits.push(`；包名 ${args.packageName}`);
  if (typeof args.key === 'string') bits.push(`；按键 ${args.key}`);
  if (typeof args.direction === 'string') bits.push(`；方向 ${args.direction}`);
  if (step.until) bits.push(`；等 ${describeUntil(step.until)}`);
  if (step.mustConfirmLive) bits.push('；付款类，单独一步并当场确认');
  return bits.join('');
}

function describeUntil(until) {
  const parts = [];
  if (until.appears) parts.push(`出现「${until.appears}」`);
  if (until.gone) parts.push(`「${until.gone}」消失`);
  if (until.app) parts.push(`前台是 ${until.app}`);
  if (until.stable === true) parts.push('界面稳定');
  return parts.join(' + ') || '稍等';
}

module.exports = {
  installSkillRecall,
  installSkillKeep,
  renderStep,
  MAX_RENDER_STEPS,
};
