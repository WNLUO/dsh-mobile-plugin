'use strict';

/**
 * 守卫：宿主进程死掉之后，sidecar worker 必须自己退出。
 *
 * 真机故障（2026-10-10）：用户把桌面 DSH 连同后台进程一起关掉，手机侧栏里的设备
 * 「在线」标志再也没灭过。根因是 worker 是 `fork()` 出来的子进程，而 Node 的子进程
 * **不会**随父进程退出（实测：父进程被 SIGKILL 后子进程被 init 收养成 ppid=1，继续
 * 活着）。孤儿 worker 照样握着那条已经注册好的中转隧道、照样答 `/api/mobile/v1/status`
 * —— 中转的 `instances` 里那条记录于是永不删除，手机看到的「在线」是一具尸体在替宿主
 * 回答。只会死得慢一点，不会自己好。
 *
 * 这里钉的不是「怎么实现」，而是那条外部可观测的后果：**宿主进程没了 → worker 进程消失**。
 * 实现写在 lib/sidecar-facade-worker.cjs 的父进程看护里。
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
/** 父进程死亡看护的巡检间隔；退出发生在 1~2 拍之内。 */
const WATCHDOG_INTERVAL_MS = 2000;
/** 留足两拍 + 收尾：超过这个时间还在跑就是「孤儿还活着」。 */
const ORPHAN_EXIT_BUDGET_MS = WATCHDOG_INTERVAL_MS * 3 + 4000;

/**
 * 参考父进程：fork worker、把 worker 的环回口报给测试，然后一直活着等被强杀。
 * 它刻意不转发 worker 的消息——worker 的真实宿主是这么做的，但本用例只关心生命周期。
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

test('宿主进程死掉之后，sidecar worker 自己退出（不再挂着一具尸体显示在线）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-orphan-'));
  // worker 要一个「父端口」；给一个根本不会被调用的端口，本用例不建隧道、不下发配置，
  // 只验证生命周期——所以「它起来了」就等于「它本来会一直活着」。
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
      const timer = setTimeout(() => reject(new Error('worker 没在规定时间内上报 ready')), 8000);
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
    assert.equal(await ping(ready.port, token), true, 'worker 的 /health 应当可用（它确实在正常服务）');

    // 宿主进程被强杀：真机上的 Cmd+Q / 被系统内存压力清掉都是这一类，不给清理机会。
    proxy.kill('SIGKILL');
    proxy = null;

    const gone = await waitForExit(workerPid, ORPHAN_EXIT_BUDGET_MS);
    assert.equal(
      gone,
      true,
      `宿主进程已经死了，worker（pid ${workerPid}）还在跑：它会握着中转隧道继续替宿主报「在线」`,
    );
  } finally {
    try { proxy?.kill('SIGKILL'); } catch { /* 已经死了 */ }
    // 守卫红了也要收尸，别把孤儿留给下一轮。
    if (workerPid && isAlive(workerPid)) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* ignore */ } }
    await new Promise((resolve) => parentProbe.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
