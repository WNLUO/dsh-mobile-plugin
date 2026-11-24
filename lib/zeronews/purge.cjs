// 2026-11-24：macOS 上彻底清理改走系统授权框跑 reset，不再把手动敲命令丢给用户。
// ZeroNews 本机彻底清理：跑官方 reset 清身份与本地配置，再删插件自己下载的客户端缓存。
'use strict';

/**
 * 「断开」只停隧道、撤域名，本机客户端的登录身份与配置都还在——本机反复测试时这不是干净起点。
 * 这里做官方认可的一次性清理：`zeronews reset` 把 Token、config.yml、运行时状态、日志与系统服务
 * 一并清掉，客户端回到全新安装状态；随后删掉插件从官方地址下载的缓存二进制（系统安装的那一
 * 份不在我们的目录里，不碰）。所有命令、定位与文件系统都可注入，守卫用假体走完整条分支。
 *
 * reset 只影响本机，不删控制台里的客户端记录与云端隧道。macOS 上它要管理员权限，这里照节点小宝
 * 安装那套走系统授权框（用户点一下确认即以 root 跑），不让用户自己开终端；其它平台维持直接执行。
 * 失败或取消都如实回，且**保留**缓存二进制，让人能重新点按钮再试，不把最后一条退路也删掉。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { locateZeroNews, runDir } = require('./provision.cjs');

/** 卸载系统服务 + 删配置可能比普通命令慢，给足一分半。 */
const RESET_TIMEOUT_MS = 90_000;

/** 默认执行器：不经过 shell，拿到 stdout / stderr / 退出码。 */
function defaultRun(binary, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, {
      timeout: opts.timeoutMs || RESET_TIMEOUT_MS,
      cwd: path.dirname(binary),
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * macOS 上以管理员权限跑官方 reset。系统自带的授权框会弹 Touch ID / 密码，用户确认后脚本才以
 * root 执行——和节点小宝安装同一套机制，不让用户自己开终端敲 sudo。脚本写到用户自己的临时目录
 * （0700），内容只是 ` '<binary>' reset`，路径按 shell 单引号规则转义；跑完即删。
 *
 * 命令执行器可注入，守卫用假体钉住「必须走系统授权、不能绕过」。
 */
function runElevatedReset(binary, opts = {}) {
  const run = typeof opts.run === 'function' ? opts.run : defaultRun;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zeronews-'));
  const file = path.join(dir, 'reset.sh');
  // 单引号包住路径，内部的单引号拆成 '\''，别让空格和引号把命令打乱。
  const quoted = `'${String(binary).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(file, `${quoted} reset\n`, { mode: 0o700 });
  // AppleScript 字符串里只需处理反斜杠与双引号；临时路径是我们自己造的，没有怪字符。
  const escaped = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return run('osascript', ['-e', `do shell script "sh ${escaped}" with administrator privileges`], {
    timeoutMs: opts.timeoutMs || RESET_TIMEOUT_MS,
  }).finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时脚本删不掉不挡结果 */ }
  });
}

/**
 * @param {object} [options]
 * @param {object} [options.fsImpl] 文件系统注入
 * @param {(bin:string,args:string[],opts:object)=>Promise<{code:number,stdout:string,stderr:string}>} [options.run] 命令注入
 * @param {(opts:object)=>Promise<{ok:boolean,path:string}>} [options.locate] 客户端定位注入
 * @param {object} [options.platform] { platform, arch }
 * @param {string} [options.root] 插件运行目录（缓存二进制所在处）
 * @returns {Promise<{ok:boolean, reset:{attempted:boolean,ok:boolean,error:string}, cacheRemoved:boolean, error:string}>}
 */
async function purgeZeroNews(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const locate = typeof options.locate === 'function' ? options.locate : locateZeroNews;
  const plat = options.platform || {};
  const dir = runDir(options.root);
  const binName = (plat.platform || process.platform) === 'win32' ? 'zeronews.exe' : 'zeronews';
  const cached = path.join(dir, binName);
  const result = { ok: true, reset: { attempted: false, ok: false, error: '' }, cacheRemoved: false, error: '' };

  let found = null;
  try { found = await locate(options); } catch { /* 定位失败不挡清理，下面仍尝试删缓存 */ }
  if (found && found.ok && found.path) {
    result.reset.attempted = true;
    const isMac = (plat.platform || process.platform) === 'darwin';
    let res;
    try {
      // macOS 走系统授权框跑官方 reset，不让用户开终端敲 sudo；其它平台维持直接执行。
      res = isMac
        ? await runElevatedReset(found.path, { run, timeoutMs: RESET_TIMEOUT_MS })
        : await run(found.path, ['reset'], { timeoutMs: RESET_TIMEOUT_MS });
    } catch (error) {
      res = { code: 1, stdout: '', stderr: String(error && error.message ? error.message : error) };
    }
    const detail = String((res && (res.stderr || res.stdout)) || '').trim();
    if (!res || res.code !== 0) {
      result.ok = false;
      // 用户点了取消授权：osascript 回 -128，别报成「reset 失败」，说清是他取消了。
      const cancelled = isMac && /-128|User canceled|authorization (?:denied|declined)/i.test(detail);
      result.reset.error = cancelled ? '用户在系统授权框点了取消' : (detail || `zeronews reset 退出码 ${res && res.code}`);
      result.error = cancelled
        ? '你取消了系统授权，ZeroNews 没有重置；缓存的客户端已保留，重新点「彻底清理」再确认一次就行。'
        : `本机 ZeroNews 没能重置：${result.reset.error}。缓存的客户端已保留，重新点「彻底清理」再试一次。`;
      return result;
    }
    result.reset.ok = true;
  }

  // 只删插件自己下载的缓存二进制；系统安装 / PATH 上那份不归我们管。
  try {
    fsImpl.rmSync(cached, { force: true });
    result.cacheRemoved = true;
  } catch (error) {
    result.ok = false;
    const why = error && error.message ? error.message : String(error);
    result.error = `${result.error ? `${result.error}；` : ''}缓存的 ZeroNews 客户端没删掉：${why}`;
  }
  return result;
}

module.exports = { RESET_TIMEOUT_MS, purgeZeroNews, runElevatedReset };
