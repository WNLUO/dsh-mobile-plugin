'use strict';

/**
 * 商店素材接收端（本机那个 Mac-to-eagle 桌面程序）的坐标。
 *
 * 为什么由插件来报：用户在手机 App 里不该填任何东西（2026-11-07 明确要求）。而「这台电脑的
 * 局域网地址 + 桌面程序的配对密钥」只有插件这一侧知道 —— 它本来就跑在这台电脑上，局域网候选
 * 地址（`lan-network`）和桌面程序写下的密钥文件都在本机，读一下就能把两样一起交给手机。
 *
 * 桌面程序不在跑 / 没装 / 还没生成密钥，就回 null：App 那边据此什么也不做（原图照旧留相册），
 * 不会因为「这台电脑上没有它」而报错。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 桌面程序的默认端口（见 Mac-to-eagle `LocalAPIServer.preferredPort`）。 */
const DESKTOP_PORT = 47291;

/** 密钥文件：桌面程序用 owner-only 权限写在应用数据目录里。 */
function accessKeyFile() {
  // 与 Mac-to-eagle `AppPaths.appSupport` 同一套规则：环境变量优先，其次用户应用数据目录。
  const override = process.env.MACTOEAGLE_DATA_DIR;
  const base = override && override.startsWith('/')
    ? override
    : path.join(os.homedir(), 'Library', 'Application Support', 'MacToEagle');
  return path.join(base, 'mobile-access-key');
}

/** 读配对密钥；读不到就 null（不是错误，只说明这台电脑上没有那个程序）。 */
function readAccessKey() {
  try {
    const value = fs.readFileSync(accessKeyFile(), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * 这台电脑上、手机能拨到的那个局域网地址。
 *
 * 直接用 `lan-network` 那套候选（它已经滤掉了 VPN / 虚拟网卡、把私网排在前面），取第一条的
 * 主机部分 —— 素材回传只需要一个能连通的地址，不需要像会话通道那样挨个试。
 */
function pickLanHost(lanCandidates) {
  const first = Array.isArray(lanCandidates) ? lanCandidates.find((item) => item && item.url) : null;
  if (!first) return null;
  try {
    return new URL(first.url).hostname;
  } catch {
    return null;
  }
}

/**
 * 组装给 App 的那一格。
 *
 * @param {{ lanCandidates?: Array<{url?: string}> }} options 与 `/connection-info` 同一份候选
 * @returns {{ url: string, key: string } | null}
 */
function promoReceiver({ lanCandidates } = {}) {
  const key = readAccessKey();
  if (!key) return null;
  const host = pickLanHost(lanCandidates);
  if (!host) return null;
  return { url: `http://${host}:${DESKTOP_PORT}`, key };
}

module.exports = {
  DESKTOP_PORT,
  accessKeyFile,
  readAccessKey,
  pickLanHost,
  promoReceiver,
};
