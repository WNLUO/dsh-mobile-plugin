'use strict';

/**
 * 「桌面页面里的客户端半边」活体台账。
 *
 * 绿点的两条同步通道都是**单向轮询 + 无回执**：客户端半边每 2s 一次 GET/POST，宿主
 * 只管收下，收没收到、跑没跑，宿主侧一点痕迹都没有。2026-10-10 的绿点不同步故障里，
 * 正是这一点把排查卡住了 —— 桌面看得见绿点、手机看得见绿点，却没人能说出「桌面那一半
 * 到底有没有来敲过门」，于是「通道断了」和「通道通了但没清掉」两种可能一直分不开。
 *
 * 这里只记**计数与最近时刻**（不含任何会话内容、不含 id），经 `/api/relay/status` 的
 * `desktopHalf` 字段暴露。三个计数是一组对照：
 *   - `readReceiptGets`：方向二（手机读过 → 桌面灭灯）的输入，**无条件 2s 轮询**，
 *     所以它只要在涨，就说明这条 effect 真的在跑；
 *   - `desktopReadPosts`：方向一（桌面读过 → 手机灭灯）的输出，只在「桌面绿点刚掉出去」
 *     时才会发，所以它不涨既可能是「没人读过」也可能是「没检测出来」；
 *   - `desktopViewPosts`：同一个半边、同一套 fetch 的**已知可用**对照组（侧栏展开态），
 *     它涨而别的两个不涨，等于「半边活着，是那两条 effect 没跑」。
 *
 * 刻意不做上限/轮转：三个整数加三个时刻，涨到天荒地老也只是几个数字。
 */

const state = {
  /** 宿主进程起算的时刻，便于判断「计数很老」还是「刚重启过」。 */
  since: Date.now(),
  readReceiptGets: 0,
  readReceiptLastAt: 0,
  desktopReadPosts: 0,
  desktopReadLastAt: 0,
  /** 累计上报过的会话 id 数（不是条数：一次 POST 可以带多个 id）。 */
  desktopReadIds: 0,
  /** 累计真正清掉的设备维度条目数（0 说明上报的 id 在宿主这边本来就没亮）。 */
  desktopReadCleared: 0,
  desktopViewPosts: 0,
  desktopViewLastAt: 0,
  /** 客户端半边自检上报：次数 / 最近一次时刻 / 第一次时刻 / 最近一份内容。 */
  clientReports: 0,
  clientLastAt: 0,
  clientSeenAt: 0,
  client: null,
};

/** 客户端半边拉了一次已读回执台账（方向二的输入侧）。 */
function noteReadReceiptGet() {
  state.readReceiptGets += 1;
  state.readReceiptLastAt = Date.now();
}

/** 客户端半边报了一次「桌面读过了」。 */
function noteDesktopRead({ ids = 0, cleared = 0 } = {}) {
  state.desktopReadPosts += 1;
  state.desktopReadLastAt = Date.now();
  state.desktopReadIds += Number.isFinite(ids) ? ids : 0;
  state.desktopReadCleared += Number.isFinite(cleared) ? cleared : 0;
}

/** 客户端半边推了一次桌面侧栏展开态（对照组）。 */
function noteDesktopViewPost() {
  state.desktopViewPosts += 1;
  state.desktopViewLastAt = Date.now();
}

/**
 * 客户端半边的**自检上报**：它在页面里能不能看见那两个服务、两条同步各跑了几轮。
 *
 * 这是唯一能回答「那半边到底看见了什么」的通道 —— 宿主能数出「它没来敲门」，但数不出
 * 「它为什么没来」。字段全部白名单收敛到布尔/短字符串/整数：这份体是页面递进来的，
 * 入口已经限长，这里再挡一道，免得把任意对象灌进 status 视图。
 */
const CLIENT_REPORT_KEYS = [
  'loaded', 'effectUiSession', 'effectSessions',
  'getUiSession', 'getSessions', 'getRetain', 'injectUiSession', 'injectSessions',
  'receiptGets', 'readPosts', 'unreadCount', 'lastError',
];

function noteClientHalf(report) {
  const clean = {};
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    for (const key of CLIENT_REPORT_KEYS) {
      const value = report[key];
      if (typeof value === 'boolean' || typeof value === 'number') {
        clean[key] = typeof value === 'number' && !Number.isFinite(value) ? null : value;
      } else if (typeof value === 'string') {
        clean[key] = value.slice(0, 120);
      }
    }
  }
  state.clientReports += 1;
  state.clientLastAt = Date.now();
  state.clientSeenAt = state.clientSeenAt || state.clientLastAt;
  state.client = clean;
  return clean;
}

/** 当前计数副本；status 视图只读它，绝不改。 */
function snapshot() {
  const { client, ...counters } = state;
  return { ...counters, client: client ? { ...client } : null };
}

module.exports = { noteReadReceiptGet, noteDesktopRead, noteDesktopViewPost, noteClientHalf, snapshot };
