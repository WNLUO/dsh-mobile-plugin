'use strict';

/**
 * 手机每次请求顺带上来的身份：设备名、机型、平台、系统版本、App 版本。
 *
 * ## 为什么要有这几个头
 *
 * 这几格以前**只在配对那一刻写一次**（见 `dsh-mobile-credentials/lib/credentials.js` 的
 * `deviceMeta`），之后谁都不碰。后果是三件事一起出现（2026-10-26 用户报的就是它们）：
 *
 *  1. **App 升级之后面板还报配对时的旧版本** —— 那一格永远不变；
 *  2. **旧会话升级进来的记录没有名字** —— 面板只能画「未知设备」；
 *  3. 面板把「加密」读成「已是最新」，其实那只说明这枚凭据带设备密钥。
 *
 * 身份属于「每一次请求都顺手知道」的信息，不该是一张一次性的照片。现在手机在统一的鉴权头
 * 里带上这几样，宿主在鉴权通过那一刻（`lib/impl.js` 的 `onAuthorized`）把它们写回凭据记录。
 *
 * ## 口径
 *
 *  - **缺一个就少写一个**：老版本 App 根本不带这些头，那时必须保持记录里原来的值，
 *    绝不能把已经有的名字冲成空串（那会把一个好好的设备变成「未知设备」）。
 *  - 头的值是手机自报的，长度交给凭据库的 `truncate` 截断，这里不重复做校验。
 *  - 名字是**用户自己起的**，不参与任何判断，只用于显示；机型是手机自己报的，同理只用于显示。
 *    认一台手机靠的是它自带的 `deviceId`（`X-Dsh-Device` 那条），不是这几格里的任何一样。
 */

/**
 * 手机自报身份用的头名（App 侧在 `app/src/services/viewmodels/authHeaders.ts` 里写）。
 *
 * 新版 App 只发机型 / 平台 / 系统版本 / App 版本四个；名字那一格留给还带它的老版本。
 */
const DEVICE_NAME_HEADER = 'x-dsh-device-name';
const DEVICE_MODEL_HEADER = 'x-dsh-device-model';
const PLATFORM_HEADER = 'x-dsh-platform';
const OS_VERSION_HEADER = 'x-dsh-os-version';
const APP_VERSION_HEADER = 'x-dsh-app-version';

/** 一个头拿成字符串（重复头会是数组，只认第一个）。 */
function headerText(headers, name) {
  const value = headers && headers[name];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

/**
 * 这次请求带上来的身份。**没带的格子不出现在返回对象里**（不是空串）——
 * 凭据库那边按「有哪几格就写哪几格」合并，空串会变成「把名字清掉」。
 */
function deviceMetaFromHeaders(req) {
  const headers = req?.headers || {};
  const meta = {};
  const name = headerText(headers, DEVICE_NAME_HEADER);
  if (name) meta.name = name;
  // 机型号只在这个位置补得回来：它跟名字不一样，不随用户改，所以只在**配对之后第一次
  // 请求**时真正写进去 —— 但老记录（这一格出生前配的对）不会有第二次配对，全靠这条头
  // 自愈。缺了就不写，别把已经记下的机型冲成空。
  const model = headerText(headers, DEVICE_MODEL_HEADER);
  if (model) meta.model = model;
  const platform = headerText(headers, PLATFORM_HEADER);
  if (platform) meta.platform = platform;
  const osVersion = headerText(headers, OS_VERSION_HEADER);
  if (osVersion) meta.osVersion = osVersion;
  const appVersion = headerText(headers, APP_VERSION_HEADER);
  if (appVersion) meta.appVersion = appVersion;
  return meta;
}

module.exports = {
  APP_VERSION_HEADER,
  DEVICE_MODEL_HEADER,
  DEVICE_NAME_HEADER,
  OS_VERSION_HEADER,
  PLATFORM_HEADER,
  deviceMetaFromHeaders,
};
