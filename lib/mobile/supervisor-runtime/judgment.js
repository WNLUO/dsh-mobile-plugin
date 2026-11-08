'use strict';

/**
 * 「这一通电话现在有没有活干」的判据。
 *
 * 总管这条会话有两种处境：手上有事挂着（账上有条目、或者某条对话正在跑 / 在等人答），
 * 那就得先报活；什么都没有，那就是闲聊，陪它聊，**绝不主动翻旧账**。
 *
 * 这个判断刻意放在插件侧、不交给模型自己拍：模型看到一本账就只能凭感觉决定要不要念，
 * 而「没活的时候别提昨天那件事」是一条产品口径，得有一个写死的地方。
 *
 * 判据只吃两样现成的账：
 *   · 任务账的挂起条目（`task-ledger` 的 `openItems()`，`done` 的不算）；
 *   · `/monitor` 的状态位投影（`running` / `pendingInteraction`）。
 * 两样都不在这一侧重算：账本与监控各自是唯一来源，重造一份只会跟它们走偏。
 */

const ledger = require('../task-ledger.js');
const { buildMonitorState } = require('../monitor.js');

/** 一笔读不到就当没有：判断是旁路，读失败不该把这一轮的「有没有活」判成有。 */
function readTasks(deps) {
  try {
    const read = deps && typeof deps.openItems === 'function' ? deps.openItems : ledger.openItems;
    const items = read();
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/** 同上。宿主忙时 `/monitor` 这一发会扫日志，所以它是并发发出去的，不是串行两遍。 */
async function readSessions(ctx, deps) {
  try {
    const read = deps && typeof deps.monitor === 'function' ? deps.monitor : defaultMonitor;
    const built = await read(ctx);
    return built && Array.isArray(built.items) ? built.items : [];
  } catch {
    return [];
  }
}

/** 默认的监控投影：总管不是某台手机，给它一个专用设备键，别污染真手机那份提醒账。 */
function defaultMonitor(ctx) {
  return buildMonitorState(ctx, 'supervisor-runtime');
}

/**
 * 一条监控条目算不算「有活」。
 *
 * 只看两格：正在跑、或者停下来等人答。`completed` 不算 —— 上一轮跑完正好是「没事干」，
 * 把完成也当活就会变成「每跑完一轮就翻一次旧事」。
 */
function busySession(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.running === true) return true;
  return Boolean(row.pendingInteraction);
}

/**
 * 判据本体：纯函数，真值表直接跑。
 *
 * 输入缺席（`undefined` / 不是数组）一律当空：读不到账就是没活，宁可漏报也不无中生有。
 *
 * @param {{tasks?: Array<{status?: string}>, sessions?: Array<object>}} [input]
 */
function workDecision(input) {
  const source = input && typeof input === 'object' ? input : {};
  const tasks = Array.isArray(source.tasks)
    ? source.tasks.filter((item) => item && typeof item === 'object' && item.status !== 'done')
    : [];
  const sessions = Array.isArray(source.sessions) ? source.sessions.filter(busySession) : [];
  return {
    busy: tasks.length > 0 || sessions.length > 0,
    tasks,
    sessions,
    waiting: tasks.filter((item) => item.status === 'waiting').length,
  };
}

/**
 * 现读一次「有没有活」。
 *
 * 两笔账并发发出去：`rpc.js` 会把同一时刻在飞的会话 list 合流掉，宿主实际只扫一遍日志。
 * 失败方向刻意选「没活」：它只会少报一次活，绝不会凭一份读坏的账去翻旧事。
 *
 * @param {object} ctx 宿主上下文（`/monitor` 投影要用）
 * @param {{openItems?: Function, monitor?: Function}} [deps] 可注入的读数（守卫用）
 */
async function judgeWork(ctx, deps) {
  const [tasks, sessions] = await Promise.all([readTasks(deps), readSessions(ctx, deps)]);
  return workDecision({ tasks, sessions });
}

/** 一条监控条目念出来是什么样。 */
function sessionLine(row) {
  const raw = row && typeof row.title === 'string' ? row.title.trim() : '';
  const title = raw || '未命名';
  if (row && row.pendingInteraction) {
    const label = row.pendingInteraction === 'approval' ? '在等你审批' : '在等你回答';
    return `· 《${title}》${label}`;
  }
  return `· 《${title}》正在跑`;
}

module.exports = {
  workDecision,
  judgeWork,
  busySession,
  sessionLine,
  readTasks,
  readSessions,
};
