// 2026-11-28：客户端换代：新版下到 <bin>.next，校验过版本才在空档里换上去，起不来就换回旧版。
// ZeroNews 客户端换代层：下载新版、验版本、就地换、可回滚。全新版绝不在老版还在跑的时候覆盖它。
'use strict';

/**
 * 第三方客户端自己不会升级：这台机器装的是哪一版，就一直卡在哪一版。厂商发了新版（4.1.1 起才有
 * `tunnel set-local`、`show traffic`），旧版用户拿不到新能力，也不该让用户自己去下载安装。
 *
 * 做法与「蓝绿」的思路一致，只是换的那一层是**同一个文件名的可执行文件**：
 *   ① 预热：新版下到 `<bin>.next`，旁边正在跑的那份原样不动，线路一秒都不受影响；
 *   ② 验货：拿 `.next` 跑一次 `--version`，版本低于目标就当失败，直接删掉，不进入切换；
 *   ③ 切换：客户端停下来之后才动盘 —— 旧版改名 `<bin>.prev`，`.next` 改名 `<bin>`，两次 rename
 *      在同一个文件系统里，不存在「换到一半」的中间态；真断在中间，下次启动 `recover` 会认出来；
 *   ④ 回滚：新起来没连上 / 没拿到隧道地址，就把 `.prev` 换回来、用旧版重新起，绝不让用户留在
 *      「升完反而用不了」的状态。
 *
 * 所有进程调用、文件系统都可注入，守卫用假体走完整条分支。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { VERSION, downloadClientTo } = require('./provision.cjs');

/** 新版落在这个后缀上预热，旧版仍原样在 `<bin>` 上跑。 */
const NEXT_SUFFIX = '.next';
/** 切换时旧版挪到这里，回滚用。 */
const PREV_SUFFIX = '.prev';

/** 从 `zeronews version zeronews 4.1.1` 里取出版本号；取不到就给空串。 */
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
}

/** 只比三段数字，够用且不引依赖；读不出的版本一律算 0，别因此判成「已经是新版」。 */
function compareVersions(a, b) {
  const pick = (value) => String(value || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = pick(a);
  const right = pick(b);
  for (let i = 0; i < 3; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 新版 / 旧版的路径：与可执行文件同目录，rename 才落不到别的文件系统上。 */
function pathsOf(binary) {
  return { next: `${binary}${NEXT_SUFFIX}`, prev: `${binary}${PREV_SUFFIX}` };
}

function isFile(target, fsImpl = fs) {
  try { return fsImpl.statSync(target).isFile(); } catch { return false; }
}

/** 等一小会儿（改名重试用，测试可注入）。 */
function defaultWait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function defaultRun(binary, args, opts = {}) {
  return new Promise((resolve) => {
    // cwd 跟客户端自己的运行目录走：`start` / `shutdown` 都按它找配置与运行状态。
    execFile(binary, args, { timeout: opts.timeoutMs || 15_000, cwd: path.dirname(binary), maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * @param {object} options
 * @param {string} [options.desiredVersion] 目标版本，默认就是 provision 里钉的那一版。
 * @param {(bin:string,args:string[],opts:object)=>Promise<{code:number,stdout:string,stderr:string}>} [options.run] 跑一次命令（测试注入）
 * @param {(dest:string,options:object)=>Promise<{ok:boolean,code?:string}>} [options.download] 下载（测试注入）
 * @param {object} [options.fsImpl] 文件系统注入
 * @param {(message:string)=>void} [options.log]
 */
function createClientUpdater(options = {}) {
  const desiredVersion = options.desiredVersion || VERSION;
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const download = typeof options.download === 'function' ? options.download : downloadClientTo;
  const fsImpl = options.fsImpl || fs;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const wait = typeof options.wait === 'function' ? options.wait : defaultWait;

  /** 这个可执行文件自己是哪一版（读 `--version`；跑不起来就是空串）。 */
  async function versionOf(binary) {
    if (!binary || !isFile(binary, fsImpl)) return '';
    try {
      const result = await run(binary, ['--version'], { timeoutMs: 10_000 });
      return parseVersion(`${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`);
    } catch { return ''; }
  }

  /** 已经预热好的新版版本号；没有 `.next` 就是空串。 */
  async function stagedVersion(binary) {
    const { next } = pathsOf(binary);
    if (!isFile(next, fsImpl)) return '';
    return versionOf(next);
  }

  /**
   * 预热：下到 `<target>.next` 再验货。版本不高于基准的、验不出版本的，当场删掉，
   * 让下一次启动仍用手里这份能跑的，而不是一个来路不明的文件。
   *
   * @param {string} target 最终要顶上去的可执行文件路径（`.next` 落在它旁边）
   * @param {string} [baseline] 拿来比版本的当前版本，默认就是 target 现在的版本
   */
  async function stageAt(target, baseline) {
    if (!target) return { ok: false, version: '', error: '没有可换代的客户端路径', code: '' };
    const next = `${target}${NEXT_SUFFIX}`;
    const current = baseline !== undefined ? baseline : await versionOf(target);
    let got;
    try {
      got = await download(next, {});
    } catch (error) {
      return { ok: false, version: '', error: error && error.message ? error.message : String(error), code: '' };
    }
    if (!got || got.ok !== true) {
      return { ok: false, version: '', error: (got && got.code) || 'download-failed', code: (got && got.code) || '' };
    }
    const version = await versionOf(next);
    if (!version) {
      fsImpl.rmSync(next, { force: true });
      return { ok: false, version: '', error: '新版运行不起来', code: '' };
    }
    if (compareVersions(version, current) <= 0) {
      // 官方下载地址在 macOS / Windows 上不带版本号，拿回来的可能仍是同一版：不值当为它切一次。
      fsImpl.rmSync(next, { force: true });
      return { ok: false, version, error: 'not-newer', code: '' };
    }
    log(`ZeroNews 客户端新版 ${version} 已下载，等空档切换`);
    return { ok: true, version, error: '', code: '' };
  }

  /** 预热到 `<bin>.next`：旁边正在跑的那份一个字节都不动。 */
  function stage(binary) {
    if (!binary) return Promise.resolve({ ok: false, version: '', error: '没有可换代的客户端路径', code: '' });
    // 本机这份都找不到就别去下载：拿回来也没法比对，只会在盘上留一个来路不明的文件。
    if (!isFile(binary, fsImpl)) return Promise.resolve({ ok: false, version: '', error: 'no-binary', code: '' });
    return stageAt(binary);
  }

  /** 预热到插件自己的目录（那块一定可写）：只读安装位置只能走这条路换版本。 */
  function stageInto(target, baseline) {
    return stageAt(target, baseline);
  }

  /** 把 `.next` 顶到正式位置（插件目录里没人占用，直接改名即可）。 */
  function commitStaged(target) {
    const next = `${target}${NEXT_SUFFIX}`;
    if (!isFile(next, fsImpl)) return { ok: false, error: 'no-staged' };
    try {
      if (isFile(target, fsImpl)) fsImpl.rmSync(target, { force: true });
      fsImpl.renameSync(next, target);
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  /**
   * 换上去：`bin` → `bin.prev`，`bin.next` → `bin`。调用方必须已经停掉客户端（Windows 上
   * 占用中的可执行文件改名会失败）。旧 `.prev` 先清掉，只留一代能回滚的。
   *
   * Windows 上客户端刚退出时文件句柄可能还没释放（杀毒软件也会短占），改名会报 EBUSY / EPERM：
   * 这种情况重试几秒再放弃，别一次失败就让所有人退回旧版本。
   */
  async function apply(binary) {
    const { next, prev } = pathsOf(binary);
    if (!isFile(binary, fsImpl) || !isFile(next, fsImpl)) return { ok: false, error: 'no-staged' };
    try {
      fsImpl.rmSync(prev, { force: true });
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
    const moved = await retryRename(binary, prev);
    if (!moved.ok) return moved;
    const placed = await retryRename(next, binary);
    if (!placed.ok) {
      // 第二步没成：先把旧版挪回来，别留下一个没有可执行文件的位置。
      await retryRename(prev, binary);
      return { ok: false, error: placed.error };
    }
    return { ok: true, error: '' };
  }

  /** 改名重试：句柄刚释放那一下最容易失败，等一小会儿再试，别让一次抖动定成败。 */
  async function retryRename(from, to) {
    const attempts = 12;
    let last = '';
    for (let i = 0; i < attempts; i += 1) {
      try {
        fsImpl.renameSync(from, to);
        return { ok: true, error: '' };
      } catch (error) {
        last = error && error.message ? error.message : String(error);
        const code = error && typeof error.code === 'string' ? error.code : '';
        const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
        if (!retryable || i === attempts - 1) break;
        await wait(200);
      }
    }
    return { ok: false, error: last };
  }

  /** 换回来：`.prev` 顶回原位，`.next` 丢掉。 */
  function rollback(binary) {
    const { next, prev } = pathsOf(binary);
    if (!isFile(prev, fsImpl)) return { ok: false, error: 'no-previous' };
    try {
      if (isFile(binary, fsImpl)) fsImpl.rmSync(binary, { force: true });
      fsImpl.renameSync(prev, binary);
      fsImpl.rmSync(next, { force: true });
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  /** 切换成功、新版确实连上之后才删旧版：留着它除了占几十兆没有别的用处。 */
  function cleanup(binary) {
    try { fsImpl.rmSync(pathsOf(binary).prev, { force: true }); } catch { /* 删不掉不影响线路 */ }
  }

  /**
   * 上次换代断在中间（旧版已经改名、新版还没顶上）时把旧版挪回原位。
   * 每次启动前跑一次，宁可回到能跑的旧版，也不留一个空位。
   * @returns {'restored'|''}
   */
  function recover(binary) {
    if (!binary) return '';
    const { prev } = pathsOf(binary);
    if (isFile(binary, fsImpl) || !isFile(prev, fsImpl)) return '';
    try {
      fsImpl.renameSync(prev, binary);
      return 'restored';
    } catch { return ''; }
  }

  /** 让正在跑的客户端自己退出：官方 `shutdown` 是优雅停止，比直接杀进程干净。 */
  async function shutdown(binary) {
    if (!binary) return '';
    try {
      const result = await run(binary, ['shutdown'], { timeoutMs: 10_000 });
      return String((result && (result.stderr || result.stdout)) || '').trim();
    } catch { return ''; }
  }

  return {
    desiredVersion, versionOf, stagedVersion, stage, stageInto, commitStaged,
    apply, rollback, cleanup, recover, shutdown, pathsOf,
  };
}

module.exports = {
  NEXT_SUFFIX, PREV_SUFFIX, parseVersion, compareVersions, pathsOf, createClientUpdater,
};
