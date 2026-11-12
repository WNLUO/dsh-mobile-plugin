'use strict';

/**
 * 读文件元信息（size / mtime）的唯一入口。
 *
 * 产出清单的批量 stat（`session-artifacts.js`）与交付声明的投影补格
 * （`presented-file-stats.js`）读的是同一件事，所以 stat 这个动作只留一份实现。
 *
 * 平铺成一个变量而不是直接调 `stat`，是为了让守卫能喂「假的尺寸」与「假的慢」：
 * 512MB 那条上限不可能真写一个大文件去测，而「磁盘慢 / 网络盘」那条要的是一份永远不回来的
 * stat。真跑时它一直是 `node:fs/promises` 的 `stat`，没有别的分支。
 *
 * **它不判放行面**：谁能被 stat 由调用方用 `createSessionFileScope` 先判过。绕过作用域直接
 * 拿这个函数去读任意路径，等于把移动 API 的读口子开到整台机器上。
 */

const fs = require('node:fs');

let statOf = (target) => fs.promises.stat(target);

/** stat 一条路径（抛错交给调用方，那一条要不要降级由它决定）。 */
function statFile(target) {
  return statOf(target);
}

/** 测试注入：假的 stat（真跑时一直是 `node:fs/promises` 的 stat）。 */
function setStatForTests(next) {
  statOf = next || ((target) => fs.promises.stat(target));
}

module.exports = { statFile, setStatForTests };
