'use strict';

/**
 * 移动端「技能」API：把宿主当前会话可用的技能目录转给手机。
 *
 * 桌面端在输入框里敲「/」时，候选菜单除了宿主命令还会列出技能
 * （@deepseek-ai/dsh-client-ui-skill 注册的 inputTriggers source：trigger "/"、order 2、
 * 按 `startsWith(query)` 前缀过滤、选中后插入 `/<name> `）。手机端此前只有
 * commands.list 的命令目录，技能一个也看不到：用户既不知道这台宿主有哪些技能，
 * 也没法像桌面那样直接选中插入。
 *
 * skill.list 是只读接口，且宿主自己已经过滤掉「非用户可调用」的技能
 * （apiproxy 里 `.filter(isUserInvocable)`），所以可以原样转给手机；
 * 这里只做形状收敛、限长与限条数，避免异常宿主把手机端菜单撑爆。
 *
 * 宿主 skills.list 的签名是 `list(request)`（没有 signal 形参），
 * 与 settings.describe 一样不接受取消信号，故只传信封。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./sessions.js');

const SKILL_MAX_ITEMS = 200;        // 技能条数上限（正常宿主只有个位数）
const SKILL_NAME_MAX = 120;         // 技能名长度上限
const SKILL_DESCRIPTION_MAX = 400;  // 单条说明截断长度

/** 技能名：必须是非空字符串；超长截断（斜杠命令名不可能这么长，纯防御异常宿主）。 */
function normalizeSkillName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name) return '';
  return name.length > SKILL_NAME_MAX ? name.slice(0, SKILL_NAME_MAX) : name;
}

/** 说明文本：非字符串当空串；超长截断补省略号，避免菜单行被超长说明撑开。 */
function normalizeSkillDescription(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length > SKILL_DESCRIPTION_MAX ? `${text.slice(0, SKILL_DESCRIPTION_MAX)}…` : text;
}

/**
 * 把 skill.list 的一条技能压成手机需要的形状；缺名字的条目丢掉。
 *
 * modelInvocable 用严格比较：宿主漏字段时按「不可被模型调用」处理（桌面端也只是
 * 拿它决定菜单里要不要加「仅用户」前缀，猜真值反而会误导用户）。
 * whenToUse 不透传：手机端菜单只显示 name + description，不需要它。
 */
function normalizeSkill(item) {
  if (!item || typeof item !== 'object') return null;
  const name = normalizeSkillName(item.name);
  if (!name) return null;
  return {
    name,
    description: normalizeSkillDescription(item.description),
    modelInvocable: item.modelInvocable === true,
  };
}

/** GET /api/mobile/v1/skills?sessionId=… —— 本会话可用的技能目录（只读）。 */
async function handleSkills(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 sessionId' } });

  const { value, error } = unwrap(await ctx.apiProxy.skills.list({
    rpcId: 'mobile',
    method: 'skill.list',
    payload: { sessionId },
  }));
  if (error) return sendJson(res, 400, { ok: false, error });

  const list = Array.isArray(value && value.skills) ? value.skills : [];
  const skills = list.map(normalizeSkill).filter(Boolean).slice(0, SKILL_MAX_ITEMS);

  sendJson(res, 200, { ok: true, skills });
}

module.exports = { handleSkills, normalizeSkill };
