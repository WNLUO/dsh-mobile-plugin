'use strict';

/**
 * 守卫：控制台退出事件不该带走 sidecar worker，父进程没了才该退出。
 *
 * 真机故障（2026-11-26）：worker 与 DSH 共用 Windows 控制台，宿主换代重启时
 * 广播的 Ctrl+C 会一起打到刚 fork 出来的 worker 上。信号处理器写在文件末尾，
 * 启动期间还没注册就中招，Windows 以 STATUS_CONTROL_C_EXIT（3221225786）收掉
 * 进程，宿主只看到一句 `sidecar facade exited 3221225786`。
 *
 * 这里钉的是两个外部可观测的后果：收到控制台事件后 worker 还在、还在服务；
 * 父进程真的没了，它自己退出（不能因为忽略事件就变成一具尸体）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const WORKER = path.join(__dirname, '..', 'lib', 'sidecar-facade-worker.cjs');
/** 父进程看护的巡检间隔；退出发生在 1~2 拍之内。 */
const WATCHDOG_INTERVAL_MS = 2000;
/** 留足两拍 + 收尾：超过这个时间还在跑就是「孤儿还活着」。 */
const ORPHAN_EXIT_BUDGET_MS = WATCHDOG_INTERVAL_MS * 3 + 4000;
/** SIGINT 之后的观察窗口：老实现在这段时间里会 shutdown 并退出。 */
const CONSOLE_EVENT_OBSERVE_MS = 1500;

/**
 * 参考父进程：fork worker、把环回口报给测试，然后一直活着等被强杀。
 * 与 sidecar-orphan.test.cjs 同一套假体，本用例只关心生命周期。
 */
const PROXY_PARENT_SOURCE = `
const { fork } = require('node:child_process');
const child = fork(process.env.PROBE_WORKER, [], {
  env: process.env,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
child.on('message', (message) => {
  if (message && message.type === 'ready') process.send({ workerPid: child.pid, port: message.port });
});
setInterval(() => {}, 60000);
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程还在，只是不归我们管。
    return error && error.code === 'EPERM';
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(100);
  }
  return !isAlive(pid);
}

function ping(port, token) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { authorization: `Bearer ${token}` }, timeout: 1000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

test('控制台退出事件不带走 worker；父进程没了才退出', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-console-'));
  // 不建隧道、不下发配置：只验证生命周期，所以假父端口不会被调用。
  const parentProbe = http.createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise((resolve) => parentProbe.listen(0, '127.0.0.1', resolve));
  const token = randomBytes(32).toString('hex');
  let proxy = null;
  let workerPid = 0;
  try {
    proxy = fork('-e', [PROXY_PARENT_SOURCE], {
      env: {
        ...process.env,
        DSH_HOME: home,
        PROBE_WORKER: WORKER,
        DSH_SIDECAR_PARENT_PORT: String(parentProbe.address().port),
        DSH_SIDECAR_TOKEN: token,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker 没在规定时间内上报 ready')), 10000);
      proxy.on('message', (message) => {
        if (message && typeof message.workerPid === 'number' && typeof message.port === 'number') {
          clearTimeout(timer);
          resolve(message);
        }
      });
      proxy.once('error', (error) => { clearTimeout(timer); reject(error); });
      proxy.once('exit', (code) => { clearTimeout(timer); reject(new Error(`参考父进程提前退出 ${code}`)); });
    });
    workerPid = ready.workerPid;
    assert.equal(await ping(ready.port, token), true, 'worker 的 /health 应当可用');

    // Ctrl+C 打到共用控制台的整组进程时，worker 不能跟着退出。
    process.kill(workerPid, 'SIGINT');
    await delay(CONSOLE_EVENT_OBSERVE_MS);
    assert.equal(isAlive(workerPid), true, '控制台退出事件把 worker 带走了');
    assert.equal(await ping(ready.port, token), true, '收到控制台事件后 worker 不再服务');

    // 宿主真没了，看护仍要收掉它：忽略事件不能留下一具握着隧道的尸体。
    proxy.kill('SIGKILL');
    proxy = null;
    const gone = await waitForExit(workerPid, ORPHAN_EXIT_BUDGET_MS);
    assert.equal(gone, true, `父进程已经死了，worker（pid ${workerPid}）还在跑`);
  } finally {
    try { proxy?.kill('SIGKILL'); } catch { /* 已经死了 */ }
    if (workerPid && isAlive(workerPid)) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* ignore */ } }
    await new Promise((resolve) => parentProbe.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
