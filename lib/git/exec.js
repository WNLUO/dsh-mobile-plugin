'use strict';

/**
 * 跑 git、按仓库排队：移动端 Git 能力的唯一进程入口。
 *
 * 三条前提：
 *   1. **不接受外部传进来的命令**。这里只收参数数组，可执行文件写死 `git`，参数由调用方
 *      拼、值一律走白名单校验（`--` 之后才是路径），所以移动 API 那条「不暴露 shell」的
 *      边界仍然成立；
 *   2. **失败不当异常抛**。非零退出是常态（没有上游、坏分支名、钩子拒绝），调用方要拿退出码
 *      和 stderr 判断，所以一律 resolve 成 `{ code, stdout, stderr }`，只有「git 根本没装」
 *      与「超时被杀」单独立成 `error` 字段；
 *   3. **按仓库串行**。手机上一次点两下就会并发两次写，撞上 `.git/index.lock` 会互相踩死；
 *      锁的粒度是仓库根，主仓库与它下面的独立子仓库各排各的队。
 *
 * 环境变量按「别挂住、别落锁、别本地化」设：`GIT_TERMINAL_PROMPT=0` 挡住凭据提示（移动请求
 * 没有 stdin，挂住就只能等超时），`GIT_OPTIONAL_LOCKS=0` 让纯读不顺手刷新索引，
 * `GIT_PAGER=cat` 免得哪天接了分页器就一直等，`LC_ALL=C` 只是让 stderr 进日志时统一。
 */

const { execFile } = require('node:child_process');

const BASE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ASKPASS: '',
  LC_ALL: 'C',
  LANG: 'C',
};

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** 仓库根的串行队列：root → 这条链的尾巴（永远是个已收敛的 Promise）。 */
const chains = new Map();

/**
 * 在某个仓库的独占队列里跑一段活。读也排队：写操作进行到一半时去读索引，拿到的是半成品。
 *
 * @template T
 * @param {string} root 仓库根（绝对路径）
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withRepoLock(root, task) {
  const previous = chains.get(root) || Promise.resolve();
  const next = previous.then(task, task);
  // 队列尾巴吞掉失败：一次失败不能把后续排队的活一起带走。
  chains.set(root, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * 跑一次 git。
 *
 * @param {string} root 工作目录（仓库根）
 * @param {string[]} args 参数数组（不含 `git` 本身）
 * @param {{ timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ code: number, error: string|null, stdout: string, stderr: string, truncated: boolean }>}
 *   `error`：`GIT_UNAVAILABLE`（这台机器没有 git）/ `TIMEOUT` / `TOO_LARGE`；否则为 null。
 */
function runGit(root, args, options = {}) {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: root,
      env: BASE_ENV,
      timeout,
      maxBuffer,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : '';
      const err = typeof stderr === 'string' ? stderr : '';
      if (!error) {
        resolve({ code: 0, error: null, stdout: out, stderr: err, truncated: false });
        return;
      }
      if (error.code === 'ENOENT') {
        resolve({ code: -1, error: 'GIT_UNAVAILABLE', stdout: out, stderr: err, truncated: false });
        return;
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        resolve({ code: -1, error: 'TOO_LARGE', stdout: out, stderr: err, truncated: true });
        return;
      }
      if (error.killed) {
        resolve({ code: -1, error: 'TIMEOUT', stdout: out, stderr: err, truncated: false });
        return;
      }
      const code = typeof error.code === 'number' ? error.code : -2;
      resolve({ code, error: null, stdout: out, stderr: err, truncated: false });
    });
  });
}

/** 跑一次 git 并要求成功；失败时带上退出码与 stderr（调用方据此映射错误码）。 */
async function runGitStrict(root, args, options) {
  const result = await runGit(root, args, options);
  if (result.error === 'GIT_UNAVAILABLE') {
    const failure = new Error('这台电脑上没有可用的 git');
    failure.code = 'GIT_UNAVAILABLE';
    throw failure;
  }
  if (result.error === 'TIMEOUT') {
    const failure = new Error('git 超时');
    failure.code = 'TIMEOUT';
    throw failure;
  }
  if (result.code !== 0) {
    const failure = new Error((result.stderr || '').trim() || `git 退出码 ${result.code}`);
    failure.code = 'GIT_FAILED';
    failure.exitCode = result.code;
    failure.stderr = result.stderr;
    throw failure;
  }
  return result;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  BASE_ENV,
  runGit,
  runGitStrict,
  withRepoLock,
};
