'use strict';

/**
 * 插件与中转共用的 DSH 数据目录路径。
 *
 * 原先这里还包含内置浏览器、桌面更新器、配对授权弹窗握手的落盘路径，
 * 那些都属于已删除的桌面端外壳，本模块已收窄为插件真正使用的两处。
 * 均为纯函数（按调用时 env 解析，测试可注入 DSH_HOME）。
 */

const os = require('node:os');
const path = require('node:path');

/** DSH 数据目录：DSH_HOME 可覆盖，缺省 ~/.dsh。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 远程连接（relay）插件状态文件：~/.dsh/relay.json */
function relayStateFile() {
  return path.join(dshHome(), 'relay.json');
}

module.exports = {
  dshHome,
  relayStateFile,
};
