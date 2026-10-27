'use strict';

/**
 * 手机端能读、能写的目录范围：宿主已登记的工作区 ∪ 当前会话的项目目录。
 *
 * 读（`file-read.js` 的按路径取字节）与写（`uploads.js` 的 `destPath`）共用这一份判据 ——
 * 抄两份一定会漂，而漂出来的组合最难解释：同一个目录里的文件「能打开、却存不回去」。
 *
 * 判的是 **resolve 之后的落点**，不是输入字符串：`a/../../x` 这类写法按最终指向算，`..`
 * 爬出允许区的路径一律不认。
 *
 * 能力面的口径是「这台电脑上我自己登记过的目录，加上这条会话正在干活的那一个」，
 * **不是**整台电脑。要再放宽（任意绝对路径、任意路径前缀）先改设计，别在这里顺手加分支。
 *
 * 工作区清单取法与 `workspaces.js` 同一处（`callWorkspace(ctx,'list')`）：宿主**报错或形状
 * 不对都要如实抛出去**，绝不当成「没有工作区」—— 那样每个路径都会变成 403，用户看到的
 * 是「我的目录突然不能看了」，而不是「宿主那边出错了」。
 */

const path = require('node:path');

const { unwrap } = require('./envelope.js');
const { cwdOf } = require('./session-cwd.js');

/** 调宿主 apiProxy.workspace.*（与 `workspaces.js` 的 `callWorkspace` 同一形状）。 */
function callWorkspace(ctx, method, payload) {
  return ctx.apiProxy.workspace[method]({ rpcId: 'mobile', method: `workspace.${method}`, payload });
}

/** 允许区判据统一抛这一种错：调用方按 `code` 转成 502，把宿主那句话原样回给手机。 */
function zoneError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 宿主已登记的、能当根用的目录（绝对路径，去重、保持宿主的顺序）。
 *
 * 没有 `path` 的条目直接跳过：它在宿主侧连目录都没有，拿来当根只会把每次判定都拖成
 * 「看起来在工作区里」。宿主的两种回执形状（裸数组 / `{ items }`）都要认，与
 * `buildWorkspacesBody` 同口径。
 */
async function workspaceRoots(ctx) {
  const { value, error } = unwrap(await callWorkspace(ctx, 'list', {}));
  if (error) {
    throw zoneError(error.code || 'workspace-list-failed', error.message || '读工作区清单失败');
  }
  const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : null);
  if (items === null) {
    throw zoneError('host-workspace-list-degraded', '宿主工作区清单形状异常：响应里没有 items 数组');
  }
  const roots = [];
  for (const item of items) {
    const raw = item && typeof item.path === 'string' ? item.path.trim() : '';
    if (!raw || !path.isAbsolute(raw)) continue;
    const root = path.resolve(raw);
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * 这一次请求的允许区。
 *
 * @param {object} ctx 插件上下文
 * @param {string} [sessionId] 给了才把这条会话的项目目录并进来（右栏那份「当前目录」
 *   未必是登记过的工作区，比如直接从会话进的文件树）
 * @returns {Promise<string[]>} 绝对路径形式的根目录
 */
async function allowedRoots(ctx, sessionId) {
  const roots = await workspaceRoots(ctx);
  if (!sessionId) return roots;
  // cwd 取不到（会话没工作区、或宿主那边读失败）就只剩工作区那几个根：
  // 这是缩小范围，不是扩大，按「不认」处理是安全的。
  const cwd = await cwdOf(ctx, sessionId);
  if (!cwd || !path.isAbsolute(cwd)) return roots;
  const root = path.resolve(cwd);
  if (!roots.includes(root)) roots.push(root);
  return roots;
}

/**
 * target 在不在 root 里面（含 root 本身）。
 *
 * `path.relative` 出来是 `..`、`../x` 或以 `..` + 分隔符开头就是爬出去了；绝对路径说明
 * 两者不在同一棵树（Windows 换盘符）。`..foo` 这种**名字**以两点开头的目录不算越界 ——
 * 判据是整段，不是前缀字符串。
 */
function isWithin(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** target 在不在允许区里的任意一个根之下。 */
function inAllowedZone(roots, target) {
  return Array.isArray(roots) && roots.some((root) => isWithin(root, target));
}

module.exports = { workspaceRoots, allowedRoots, isWithin, inAllowedZone };
