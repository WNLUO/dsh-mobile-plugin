'use strict';

/**
 * 手机端那两个「在用户自己电脑上跑东西」的服务：远程终端与 CLI 对话。
 *
 * 为什么有这一层：装配层（`impl.js`）有行数上限，那一层只该出现「把东西接上」的代码，不该
 * 为了两个 require 各占一行。这里把两份放一起，装配层少一行就够用。
 *
 * 两者是并列的两条口子，不是一回事：终端把 CLI 的 TUI 字节原样搬给手机，CLI 对话让 CLI
 * 以 ACP 的方式跑、交结构化事件给对话页。
 */

module.exports = {
  ...require('./terminal.js'),
  ...require('./cli/service.js'),
};
