'use strict';

/**
 * 项目级单写者队列：同一个项目目录同一时刻只让一个写任务落盘，只读不排队。
 *
 * 由来：手机能一口气派几条会话，落在同一个项目里就会同时改同一批文件 —— 插件的写接口
 * 如果并发跑，后写的会把先写的覆盖掉。这里按「项目目录」串行。
 *
 * 排在这条队上的写有三处，key 是同一份算法（见 `queueKeyOf`，调用方不许各自抄一份）：
 *  - `file-ops.js` 的新建文件 / 删除 / 改名；
 *  - `uploads.js` 的 `finish` 落盘那一段（带 `destPath` 落进项目里，以及落进收件箱）；
 *  - `directory-browse.js` 的 `createDirectory`（宿主只服务 native 选择器时那份自带实现）。
 * 判重（同名文件、候选名）与真正落盘必须在同一个独占窗口里：分开判的话两条并发会都判
 * 「不存在」，然后后落盘的那条把先落盘的覆盖掉。
 *
 * git 写**不在这条队上**：`lib/git/exec.js` 的 `withRepoLock` 是另一把按仓库根的锁。两把锁
 * 独立、键的粒度也不同（仓库根 vs 项目目录），互不排队。
 *
 * 能力边界说清楚：真正改文件的是**模型在宿主里跑的工具**，那层插件拦不到、也不在这里排队；
 * 这里只保证**插件自己发起的写**按项目串行。想对模型写做强互斥做不到（见交付说明）。
 * 同理，宿主服务 browse 能力时「新建文件夹」由宿主那份目录选择器落盘，这条队也管不到。
 *
 * 暂停语义：`pauseProjectWrites(key)` 之后，同 key 后续排到的写会先停在门口，
 * `resumeProjectWrites(key)` 放行；只对「还在队列里没落盘」的任务有效 —— 已经在跑的那一个
 * 过了门口，不会被打断；还没排到的那个会一直等，直到恢复或进程重载。
 *
 * 暂停的**用户出口**是 `POST /api/mobile/v1/project/writes`（见 `project-writes.js`），
 * App 侧入口在右栏文件浏览器的工具栏上 —— 那一页就是这些写的发生地。暂停状态只在进程内存着：
 * 插件重载之后一律回到「不暂停」，不落盘。
 */

const path = require('node:path');

const { inAllowedZone } = require('./allowed-zone.js');

const chains = new Map();   // key → 队列尾巴（永远是个已收敛的 Promise）
const paused = new Map();   // key → true 表示暂停
const gates = new Map();    // key → { promise, resolve } 暂停等待门

function keyOf(key) {
  return String(key || '');
}

/**
 * 写队列的 key：目标所在的那一个允许区根；一个根都不占时退到目标所在的目录。
 *
 * 取「包含目标的根」而不是写死的项目路径，是为了让同一条会话的项目目录与它自己那棵工作树
 * 各自成队（工作树是另一条根），而落在同一个项目里的并发写自然排到同一条队上。
 *
 * 三处调用方共用这一份：同一个项目算出的键一旦不一样，两种写就排到两条队上，等于没排队。
 *
 * @param {string[]} [roots] 允许区根（绝对路径）；拿不到就传空数组，走下面那条兜底
 * @param {string} target 落点（绝对路径）
 * @returns {string}
 */
function queueKeyOf(roots, target) {
  const hit = (roots || []).find((root) => inAllowedZone([root], target));
  return hit || path.dirname(target);
}

function waitIfPaused(key) {
  if (!paused.get(key)) return Promise.resolve();
  let gate = gates.get(key);
  if (!gate) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    gate = { promise, resolve };
    gates.set(key, gate);
  }
  return gate.promise;
}

/**
 * 在某个项目的独占队列里跑一段写。读操作不要走这里（读可以并行）。
 *
 * @template T
 * @param {string} key 项目目录（绝对路径）
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withProjectWrite(key, task) {
  const k = keyOf(key);
  const previous = chains.get(k) || Promise.resolve();
  const run = () => waitIfPaused(k).then(task);
  // 队尾吞掉失败：一次失败不能把后续排队的活一起带走。
  const next = previous.then(run, run);
  chains.set(k, next.then(() => undefined, () => undefined));
  return next;
}

function pauseProjectWrites(key) {
  paused.set(keyOf(key), true);
}

function resumeProjectWrites(key) {
  const k = keyOf(key);
  paused.delete(k);
  const gate = gates.get(k);
  if (gate) {
    gates.delete(k);
    gate.resolve();
  }
}

function isProjectPaused(key) {
  return !!paused.get(keyOf(key));
}

module.exports = {
  withProjectWrite,
  queueKeyOf,
  pauseProjectWrites,
  resumeProjectWrites,
  isProjectPaused,
};
