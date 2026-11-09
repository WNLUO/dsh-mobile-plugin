'use strict';

/**
 * 学到的手机路线：在手机上**看草稿、收下、丢掉**（`GET/POST /api/mobile/v1/phone/skill/*`）。
 *
 * ## 为什么要这条路由
 *
 * `phone_skill_keep` 那个工具能做这三件事，但工具只能由模型在会话里调 —— 也就是说
 * 「用户收下才知道能不能用」这条承诺的实际确认人一直是模型。用户手上没有出口，那这道
 * 关卡就等于由 AI 自己盖章。这里把同一份 `route-store` 的读写接成一条人能点的路由。
 *
 * ## 与路由「/phone/*」那组的分工
 *
 * `phone/routes.js` 那三条是「这台电脑认识的手机、现在连着没有」这类**设备状态**；
 * 这一条是**学到的内容**。分开放是因为它们的权限位不同：看草稿是只读（view），
 * 收下会真的写进技能目录（files.write）。
 *
 * ## 收下 / 丢掉之后
 *
 * 收下 = `route-store.accept`，草稿落进技能目录，从那以后 `recall()` 才会把这条路线交给
 * 模型；丢掉 = `route-store.discard`，草稿文件里删掉，不会「下次又冒出来」。两个动作都按
 * 名字而不是 id 认目标 —— id 是随机串，用户看不见（与 `phone_skill_keep` 同一口径）。
 */

const { sendJson, readJsonBody } = require('../../shared/http-util');
const routeStore = require('../route-store.js');

/** 一条草稿压成界面上要的一行。 */
function rowOf(draft) {
  const route = draft.route || {};
  return {
    id: draft.id,
    name: draft.name,
    summary: routeStore.describeRoute(route) || '',
    packageName: (route.app && typeof route.app.package === 'string') ? route.app.package : '',
    intent: (route.intent && typeof route.intent.raw === 'string') ? route.intent.raw : '',
    stepCount: Array.isArray(route.steps) ? route.steps.length : 0,
    createdAt: draft.createdAt || 0,
  };
}

/**
 * GET /api/mobile/v1/phone/skill/routes（token）
 * → { ok, routes: [...], accepted: N }
 *
 * 两半都回：`routes` 是等着收下的草稿（用户真正要处理的），`accepted` 是已收下的条数 ——
 * 界面上要能回答「我现在一共攒了几条能用的」，那件事只能看技能目录。
 */
async function handleSkillRoutes(_ctx, _req, res) {
  let drafts = [];
  try { drafts = routeStore.pending(); } catch { drafts = []; }
  let accepted = 0;
  try { accepted = routeStore.scan().length; } catch { accepted = 0; }
  sendJson(res, 200, { ok: true, routes: drafts.map(rowOf), accepted });
}

/**
 * POST /api/mobile/v1/phone/skill/keep（token）{ name, action: 'accept' | 'discard' }
 * → { ok, routes: [...], accepted: N }
 *
 * 按名字认目标：界面上显示的就是名字。收下会落进技能目录、从那以后进召回池；
 * 丢掉只删草稿。两种都是幂等语义的正常失败（找不到就 404），不会把别的草稿带走。
 */
async function handleSkillKeep(_ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const action = body && typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';
  const name = body && typeof body.name === 'string' ? body.name.trim() : '';
  if (action !== 'accept' && action !== 'discard') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: "action 只能是 'accept' 或 'discard'" } });
  }
  if (!name) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 name（哪一条）' } });
  }

  let target = null;
  try { target = routeStore.pending().find((row) => row.name === name) || null; } catch { target = null; }
  if (!target) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `没有叫「${name}」的待收下路线` } });
  }

  if (action === 'accept') {
    const result = routeStore.accept(target.id);
    if (!result || result.ok !== true) {
      const problem = (result && result.problem) || 'failed';
      return sendJson(res, problem === 'sensitive' ? 400 : 409, {
        ok: false,
        error: {
          code: problem === 'sensitive' ? 'sensitive' : 'accept-failed',
          message: problem === 'sensitive'
            ? '这条路线里有像账号 / 卡号这类敏感内容，没有收下。'
            : `这条路线没能收下（${problem}）。`,
        },
      });
    }
  } else if (!routeStore.discard(target.id)) {
    return sendJson(res, 409, { ok: false, error: { code: 'discard-failed', message: '这条路线没能丢掉，请再试一次' } });
  }

  let routes = [];
  try { routes = routeStore.pending(); } catch { routes = []; }
  let accepted = 0;
  try { accepted = routeStore.scan().length; } catch { accepted = 0; }
  sendJson(res, 200, { ok: true, action, name, routes: routes.map(rowOf), accepted });
}

module.exports = { handleSkillRoutes, handleSkillKeep };
