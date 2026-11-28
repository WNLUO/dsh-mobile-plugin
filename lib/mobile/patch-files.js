'use strict';

/**
 * `apply_patch` 的补丁正文 → 这次要改哪些文件。
 *
 * 宿主从 0.2.3 起把 `apply_patch` 默认摆到模型面前：一次调用能改好几个文件，路径写在补丁头
 * 里（`*** Add File:` / `*** Update File:` / `*** Move to:`），参数里没有 `file_path`。手机
 * 这边凡是「按路径说话」的地方（步骤摘要、审批卡的类别键）都得从补丁正文里读，否则那一行
 * 只剩工具名。
 *
 * 规矩：删文件不算产出（点开也没有东西可看），移动只留落点（源文件已经没了）。路径相对会话
 * 工作目录，显示前由调用方自己取最后一段。
 */

/** 补丁头里那三种会留下文件的写法；`*** Update File:` 可能跟着 `*** Move to:` 改落点。 */
const FILE_HEADER = /^\*\*\* (?:Add|Update) File:\s*(.+)$/;
const MOVE_HEADER = /^\*\*\* Move to:\s*(.+)$/;

/**
 * @param {unknown} patch 补丁正文（`apply_patch` 的 `input`）。
 * @returns {string[]} 去重后的路径，按补丁里的出现顺序。
 */
function patchFilePaths(patch) {
  if (typeof patch !== 'string' || patch === '') return [];
  const out = [];
  /** 上一行落下的是不是「可能被 Move to 改掉的更新目标」。 */
  let movable = false;
  for (const raw of patch.split(/\r?\n/)) {
    const line = raw.trim();
    const file = FILE_HEADER.exec(line);
    if (file) {
      out.push(file[1].trim());
      movable = line.startsWith('*** Update');
      continue;
    }
    const move = MOVE_HEADER.exec(line);
    if (move) {
      if (movable && out.length > 0) out.pop();
      out.push(move[1].trim());
      movable = false;
    }
  }
  return [...new Set(out.filter(Boolean))];
}

module.exports = { patchFilePaths };
