'use strict';

/**
 * 任务账的守卫：原子写回环、读坏当空、只加不删、按会话进度更新、给总管念的那几行。
 *
 * 每条断言对着一个真会出事的写法：
 *
 *  1. **写一半被杀，账不能整本没**：临时文件 + rename 是这一条的唯一保证，所以先写一个
 *     半截临时文件，再读账，账必须还是上一份完整的那本。
 *  2. **读坏当空、不抛**：文件读不动 / JSON 坏 / 形状不对，一律回空账 —— 账本是旁路，
 *     不能因为它把一通电话拦在门外。
 *  3. **挂着的条目永不删**：存储兜底只挤掉「已完成」里最老的，挂着的越攒越多也不行删。
 *  4. **按会话进度更新只改账上已有的那条**：没记过的会话不会自己长出一条来，否则这本账
 *     两三天就变成会话清单。
 *  5. **等人与做完分开**：`waiting` 与 `status` 两格一起动，别让它们对不上。
 *
 * 跑法：node --test test/task-ledger.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../lib/mobile/task-ledger.js');
const { mount, progressPatchOf, callMemory } = require('../lib/mobile/supervisor-memory/index.js');

/**
 * 在临时库根里跑一段。`DSH_MOBILE_TASK_LEDGER` 是整份文件的路径（不是目录），
 * 与 `knowledge-base.js` 的库根分开，测完删掉。
 */
function withLedger(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-ledger-'));
  const previous = process.env.DSH_MOBILE_TASK_LEDGER;
  process.env.DSH_MOBILE_TASK_LEDGER = path.join(dir, 'task-ledger.json');
  try {
    return run(process.env.DSH_MOBILE_TASK_LEDGER);
  } finally {
    if (previous === undefined) delete process.env.DSH_MOBILE_TASK_LEDGER;
    else process.env.DSH_MOBILE_TASK_LEDGER = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('记一笔再读回来：编号、时间、档位都在，落盘路径就在给定的那个文件上', () => {
  withLedger((file) => {
    const created = ledger.upsertTask({ title: '修侧栏的绿点', step: '还没开工', sessionId: 's1' });
    assert.ok(created && created.created);
    assert.match(created.item.id, /^t[0-9a-f]{8}$/);
    assert.ok(created.item.createdAt > 0);
    assert.equal(created.item.status, 'open');
    assert.ok(fs.existsSync(file), '账应该落在指定的那个文件上');

    const book = ledger.readLedger();
    assert.equal(book.items.length, 1);
    assert.equal(book.items[0].title, '修侧栏的绿点');
    assert.equal(book.items[0].sessionId, 's1');
  });
});

test('原子写回环：写完只剩最终文件，没有留下 .tmp', () => {
  withLedger((file) => {
    ledger.upsertTask({ title: '第一件' });
    ledger.upsertTask({ title: '第二件' });
    const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '临时文件必须在 rename 之后消失');
    // 文件本身是一份能解析的完整 JSON（写一半被杀的话这里就红了）。
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.items.length, 2);
  });
});

test('读坏当空：半截 JSON / 形状不对 / 文件不存在，一律回空账且不抛', () => {
  withLedger((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 文件不存在
    assert.equal(ledger.readLedger().items.length, 0);
    assert.equal(ledger.openItems().length, 0);
    assert.deepEqual(ledger.briefLines(), []);
    assert.equal(ledger.briefText(), '');

    // 半截 JSON（宿主写到一半被杀）
    fs.writeFileSync(file, '{"version":1,"items":[{"title":"写到一半');
    assert.equal(ledger.readLedger().items.length, 0);

    // 形状不对：items 不是数组
    fs.writeFileSync(file, JSON.stringify({ version: 1, items: { nope: true } }));
    assert.equal(ledger.readLedger().items.length, 0);

    // 条目坏的那条丢掉，好的那条留下（不整本丢，也不让坏的占位）
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      items: [{ title: '好的那条', status: 'open' }, { nope: true }, { title: '' }],
    }));
    const book = ledger.readLedger();
    assert.equal(book.items.length, 1);
    assert.equal(book.items[0].title, '好的那条');
  });
});

test('只加不删：一条做完之后仍在账上，只是不再进「挂着的」与报账那几行', () => {
  withLedger(() => {
    const created = ledger.upsertTask({ title: '把绿点改成红色', sessionId: 's2' });
    const id = created.item.id;

    const settled = ledger.settleTask(id);
    assert.equal(settled.item.status, 'done');
    assert.ok(settled.item.doneAt > 0);

    const book = ledger.readLedger();
    assert.equal(book.items.length, 1, '做完的事不许从账上消失');
    assert.equal(ledger.openItems().length, 0, '做完的事不该再算「挂着的」');
    assert.deepEqual(ledger.briefLines(), [], '做完的事不占电话里的时间');
  });
});

test('只加不删：存储兜底只挤已完成的最老条目，挂着的条数再多一条都不动', () => {
  withLedger(() => {
    // 挂着的超出了上限的一半以上，再塞一批已完成的把总条数顶过 MAX_ITEMS。
    const liveCount = Math.floor(ledger.MAX_ITEMS * 0.75);
    for (let i = 0; i < liveCount; i += 1) ledger.upsertTask({ title: `挂着的事 ${i}` });
    const doneTotal = ledger.MAX_ITEMS + 10 - liveCount;
    for (let i = 0; i < doneTotal; i += 1) {
      const created = ledger.upsertTask({ title: `做完的事 ${i}`, status: 'done' });
      assert.ok(created, '新建已完成条目应当成功');
    }

    const book = ledger.readLedger();
    const live = book.items.filter((item) => item.status !== 'done');
    assert.equal(live.length, liveCount, '挂着的条目一条都不许被存储兜底删掉');
    assert.ok(book.items.length <= ledger.MAX_ITEMS, `总条数应收回上限内，实际 ${book.items.length}`);
  });
});

test('按会话进度更新：只改账上已有的那条，没记过的会话不会自己长出一条', () => {
  withLedger(() => {
    assert.equal(ledger.updateFromSession('s3', { step: '正在跑' }), null, '没记过的会话不该被自动记账');

    ledger.upsertTask({ title: '改侧栏', sessionId: 's3', sessionTitle: '侧栏那条会话' });
    const updated = ledger.updateFromSession('s3', { step: '在改缓存', status: 'waiting', waiting: 'approval' });
    assert.equal(updated.item.step, '在改缓存');
    assert.equal(updated.item.status, 'waiting');
    assert.equal(updated.item.waiting, 'approval');

    // 同一个会话再更新一次，仍然只有一条 —— 按 sessionId 合并。
    ledger.updateFromSession('s3', { step: '批准了，接着改' });
    assert.equal(ledger.readLedger().items.length, 1);

    // 显式要求才新建。
    const created = ledger.updateFromSession('s4', { create: true, title: '新冒出的一件事' });
    assert.ok(created && created.item.title === '新冒出的一件事');
    assert.equal(ledger.readLedger().items.length, 2);
  });
});

test('给什么改什么：只改标题不动步骤，只动步骤不动标题', () => {
  withLedger(() => {
    const { item } = ledger.upsertTask({ title: '第一版', step: '在写', sessionId: 's5' });
    ledger.upsertTask({ id: item.id, title: '改过的标题' });
    let current = ledger.readLedger().items[0];
    assert.equal(current.title, '改过的标题');
    assert.equal(current.step, '在写');

    ledger.upsertTask({ id: item.id, step: '写完了' });
    current = ledger.readLedger().items[0];
    assert.equal(current.title, '改过的标题');
    assert.equal(current.step, '写完了');
  });
});

test('等人与做完两格一起动：标 done 时「在等谁」必须被清掉', () => {
  withLedger(() => {
    const { item } = ledger.upsertTask({ title: '等你拍板颜色', sessionId: 's6' });
    const waiting = ledger.markWaiting('s6', 'approval');
    assert.equal(waiting.item.status, 'waiting');
    assert.equal(waiting.item.waiting, 'approval');

    const cleared = ledger.clearWaiting('s6');
    assert.equal(cleared.item.status, 'open');
    assert.equal(cleared.item.waiting, null);

    ledger.markWaiting('s6', 'question');
    ledger.settleTask(item.id);
    const done = ledger.readLedger().items[0];
    assert.equal(done.status, 'done');
    assert.equal(done.waiting, null, '做完的事不该还写着「在等谁」');
  });
});

test('给总管念的那几行：等人在前、按更新时间倒序、空账什么都不念', () => {
  withLedger(() => {
    assert.deepEqual(ledger.briefLines(), []);

    ledger.upsertTask({ title: '早一点的活', sessionId: 'a' });
    ledger.upsertTask({ title: '在等你审批的那件', sessionId: 'b' });
    ledger.markWaiting('b', 'approval');

    const lines = ledger.briefLines();
    assert.equal(lines.length, 2);
    assert.match(lines[0], /在等你审批的那件/);
    assert.match(lines[0], /在等你审批/);
    assert.match(lines[1], /早一点的活/);

    const text = ledger.briefText();
    assert.match(text, /手上有 2 件事/);
    assert.match(text, /其中 1 件在等人答/);
  });
});

test('进度折算：开工、报错、在等人、等人答完了各折成什么', () => {
  assert.deepEqual(progressPatchOf({ type: 'turn/start' }), { step: '正在跑' });
  assert.deepEqual(progressPatchOf({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), { step: '这一轮跑完了' });
  assert.equal(progressPatchOf({ type: 'turn/end', data: { reason: { kind: 'error' } } }).status, 'open');
  assert.match(progressPatchOf({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }).step, /没跑完/);
  assert.equal(progressPatchOf({ type: 'approval/asked' }).waiting, 'approval');
  assert.equal(progressPatchOf({ type: 'question/requested' }).waiting, 'question');
  assert.equal(progressPatchOf({ type: 'question/resolved' }).status, 'open');
  assert.equal(progressPatchOf({ type: 'tool/start' }), null, '不相干的动作不该动账');
  assert.equal(progressPatchOf(null), null);
});

test('mount 的路由 handler：真的读写那本账（走 req/res，不碰宿主）', async () => {
  await withAsyncLedger(async (file) => {
    const { handlers } = mount(null);
    const server = require('node:http').createServer((req, res) => {
      const route = String(req.url || '').split('?')[0];
      const handler = {
        '/tasks': req.method === 'POST' ? handlers.handleTaskWrite : handlers.handleTaskList,
      }[route];
      if (!handler) {
        res.writeHead(404).end('{}');
        return;
      }
      void handler({}, req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const created = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '手机上记的一件事', sessionId: 's7' }),
      }).then((r) => r.json());
      assert.equal(created.ok, true);
      assert.equal(created.created, true);

      const list = await fetch(`${base}/tasks`).then((r) => r.json());
      assert.equal(list.ok, true);
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].title, '手机上记的一件事');
      assert.equal(list.counts.open, 1);
      assert.match(list.brief.join('\n'), /手机上记的一件事/);

      // 新建却缺标题 → 400，且账上不多一条。
      const bad = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: '只有步骤没有名字' }),
      });
      assert.equal(bad.status, 400);
      assert.equal(ledger.readLedger().items.length, 1);

      assert.ok(fs.existsSync(file));
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('mount 装的监听：会话在等人时账上的条目跟着变成 waiting，一轮结束不清账', () => {
  withLedger(() => {
    // 假 ctx：只提供 ctx.on，把监听捞出来手工喂事件。
    const listeners = [];
    const ctx = { on: (name, fn) => { listeners.push({ name, fn }); return () => {}; } };
    const mounted = mount(ctx);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].name, 'session/event');

    ledger.upsertTask({ title: '改侧栏', sessionId: 's8' });
    const fire = (session, event) => listeners[0].fn(session, event);
    fire({ id: 's8' }, { type: 'turn/start', data: {} });
    assert.equal(ledger.readLedger().items[0].step, '正在跑');

    fire({ id: 's8' }, { type: 'approval/asked', data: {} });
    assert.equal(ledger.readLedger().items[0].status, 'waiting');
    assert.equal(ledger.readLedger().items[0].waiting, 'approval');

    fire({ id: 's8' }, { type: 'approval/decided', data: {} });
    assert.equal(ledger.readLedger().items[0].status, 'open');

    // 没记过的会话走一遍事件也不会凭空长出一条。
    fire({ id: 's9' }, { type: 'turn/start', data: {} });
    assert.equal(ledger.readLedger().items.length, 1);

    mounted.dispose();
  });
});

test('callMemory：任务账在前，有线索时把知识库里对得上的那条也带上', () => {
  withLedger(() => {
    ledger.upsertTask({ title: '把绿点改成红色', sessionId: 's10' });
    const text = callMemory();
    assert.match(text, /【任务账】/);
    assert.match(text, /把绿点改成红色/);
  });
});

/** `withLedger` 的异步版：断言里起 HTTP 服务，必须等 promise 落地再还原环境。 */
async function withAsyncLedger(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-ledger-'));
  const previous = process.env.DSH_MOBILE_TASK_LEDGER;
  process.env.DSH_MOBILE_TASK_LEDGER = path.join(dir, 'task-ledger.json');
  try {
    return await run(process.env.DSH_MOBILE_TASK_LEDGER);
  } finally {
    if (previous === undefined) delete process.env.DSH_MOBILE_TASK_LEDGER;
    else process.env.DSH_MOBILE_TASK_LEDGER = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
