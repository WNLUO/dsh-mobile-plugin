'use strict';

/**
 * 知识库的守卫：只追加不改写、关键词检索命中、原子写回环、读坏当空、通话结束整理。
 *
 * 每条断言对着一个真会出事的写法：
 *
 *  1. **已存条目不许被改写**：追加之后再追加同样的事，旧条目的字节一个都不变（编号也不变）。
 *     这是这一整块最要紧的一条 —— 记忆被悄悄改掉没人发现得了。
 *  2. **原子写**：一条一个文件，写完不留 `.tmp`；文件写坏只影响那一条，读出来当「没有」。
 *  3. **关键词检索**：中文双字 + 英文小写，不去引向量库。不相干的查询必须回空，不能因为
 *     「库里有东西」就随便回一条。
 *  4. **通话里攒、结束再整理**：草稿不落盘；`flushCall` 才写，且同一通里重复的那句只写一条。
 *  5. **索引坏 / 缺了能重建**：索引是派生数据，丢了不该让「想起来」整块失效。
 *
 * 跑法：node --test test/knowledge-base.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const knowledge = require('../lib/mobile/knowledge-base.js');
const { mount } = require('../lib/mobile/supervisor-memory/index.js');

/** 在临时库根里跑一段，测完删掉。 */
function withRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-knowledge-'));
  const previous = process.env.DSH_MOBILE_KNOWLEDGE;
  process.env.DSH_MOBILE_KNOWLEDGE = root;
  knowledge.resetDraftsForTest();
  try {
    return run(root);
  } finally {
    if (previous === undefined) delete process.env.DSH_MOBILE_KNOWLEDGE;
    else process.env.DSH_MOBILE_KNOWLEDGE = previous;
    knowledge.resetDraftsForTest();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withRootAsync(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-knowledge-'));
  const previous = process.env.DSH_MOBILE_KNOWLEDGE;
  process.env.DSH_MOBILE_KNOWLEDGE = root;
  knowledge.resetDraftsForTest();
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.DSH_MOBILE_KNOWLEDGE;
    else process.env.DSH_MOBILE_KNOWLEDGE = previous;
    knowledge.resetDraftsForTest();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('追加一条再读回来：编号形状、正文、关键词、来源都在', () => {
  withRoot((root) => {
    const entry = knowledge.appendEntry({ text: '部署走十堰那台中转', keywords: ['部署', '中转'] });
    assert.ok(entry);
    assert.match(entry.id, /^kb[0-9a-f]{8}$/);
    assert.equal(entry.text, '部署走十堰那台中转');
    assert.deepEqual(entry.keywords, ['部署', '中转']);
    assert.equal(entry.source, 'call');

    // 一条一个文件，就落在 entries/<id>.json。
    const file = path.join(root, 'entries', `${entry.id}.json`);
    assert.ok(fs.existsSync(file));
    const read = knowledge.readEntry(entry.id);
    assert.equal(read.text, entry.text);
  });
});

test('只追加不改写：再追加一条同文的，旧条目字节一个都不变（也不改编号）', () => {
  withRoot((root) => {
    const first = knowledge.appendEntry({ text: '绿点改成红色', sessionId: 's1' });
    const file = path.join(root, 'entries', `${first.id}.json`);
    const before = fs.readFileSync(file, 'utf8');
    const statBefore = fs.statSync(file);

    const second = knowledge.appendEntry({ text: '绿点改成红色', sessionId: 's1' });
    assert.ok(second);
    assert.notEqual(second.id, first.id, '同文再追加也是新条目，不是覆写旧的那条');

    // 旧文件逐字节没变（含 mtime 之外的内容）。
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(fs.statSync(file).mtimeMs >= statBefore.mtimeMs);
    assert.equal(knowledge.listEntries().length, 2, '两条都在，谁也没被顶掉');
  });
});

test('模型侧只有追加：没有改写入口；删除只给人（removeEntry 有，但不进工具）', () => {
  // 2026-11-09 决策变了：知识库要在 App 里由人删掉记错的一条，所以 removeEntry 有了。
  // 「只追加」这条约束的是**模型**（工具层只调 appendEntry），不是人 —— 别把 removeEntry 当漏口子。
  for (const name of ['updateEntry', 'writeEntry', 'deleteEntry', 'overwriteEntry']) {
    assert.equal(knowledge[name], undefined, `不许有 ${name}：模型手上不能有改 / 删已存条目的口子`);
  }
  assert.equal(typeof knowledge.removeEntry, 'function', '人删那条得在（App 的 DELETE 走它）');
});

test('原子写回环：写完不留 .tmp，文件是一份能解析的完整 JSON', () => {
  withRoot((root) => {
    knowledge.appendEntry({ text: '第一件事' });
    knowledge.appendEntry({ text: '第二件事' });
    const dir = path.join(root, 'entries');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
    for (const name of fs.readdirSync(dir)) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      assert.ok(typeof raw.text === 'string' && raw.text.length > 0);
    }
  });
});

test('读坏当空：半截 JSON / 编号不合规矩 / 目录不存在，一律回空且不抛', () => {
  withRoot((root) => {
    // 目录还不存在
    assert.deepEqual(knowledge.listEntries(), []);
    assert.equal(knowledge.readEntry('kb00000000'), null);
    assert.deepEqual(knowledge.search('随便'), []);

    // 半截 JSON 那条当「没有」，旁边好的那条照常读得出来
    knowledge.appendEntry({ text: '好的那条' });
    fs.writeFileSync(path.join(root, 'entries', 'kbdeadbeef.json'), '{"text":"写到一半');
    assert.equal(knowledge.readEntry('kbdeadbeef'), null);
    const rows = knowledge.listEntries();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '好的那条');

    // 编号形状不对的一律不读（这条同时是路径校验）。
    for (const bad of ['../etc/passwd', 'kb1234', '', 'kb-deadbeef', '']) {
      assert.equal(knowledge.readEntry(bad), null, `${bad} 不该被读到`);
    }
  });
});

test('关键词检索命中：中文双字、英文小写、显式关键词，不相干的查询回空', () => {
  withRoot(() => {
    knowledge.appendEntry({ text: '侧栏的小红点改成红色，绿点不要再亮' });
    knowledge.appendEntry({ text: 'Deploy goes through the Shiyan relay' });
    knowledge.appendEntry({ text: '每周五下午整理一次收件目录', keywords: ['收件', '周五'] });

    const green = knowledge.search('绿点');
    assert.equal(green.length, 1);
    assert.match(green[0].text, /绿点不要再亮/);

    const english = knowledge.search('relay');
    assert.equal(english.length, 1);
    assert.match(english[0].text, /Shiyan relay/);

    const keywordOnly = knowledge.search('收件');
    assert.equal(keywordOnly.length, 1);
    assert.match(keywordOnly[0].text, /收件目录/);

    // 一个词都不对上的查询必须回空，不能因为「库里有东西」就回一条。
    assert.deepEqual(knowledge.search('量子计算'), []);
    assert.deepEqual(knowledge.search(''), []);
    assert.deepEqual(knowledge.search('   '), []);
  });
});

test('检索带 limit 与命中说明：matched 写清靠哪几个词对上的', () => {
  withRoot(() => {
    for (let i = 0; i < 6; i += 1) knowledge.appendEntry({ text: `绿点相关第 ${i} 条` });
    knowledge.appendEntry({ text: '跟绿点没关系的话' });

    const rows = knowledge.search('绿点', { limit: 3 });
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.ok(Array.isArray(row.matched) && row.matched.includes('绿点'));
      assert.ok(row.score >= 1);
    }
    // 上限是 20，传个离谱的数不许把整库扫穿。
    assert.ok(knowledge.search('绿点', { limit: 1000 }).length <= 20);
  });
});

test('索引丢了 / 坏了能重建：检索照样想得起来', () => {
  withRoot((root) => {
    const entry = knowledge.appendEntry({ text: '部署走十堰那台中转' });
    const indexFile = path.join(root, 'index.json');
    assert.ok(fs.existsSync(indexFile));

    fs.writeFileSync(indexFile, '{"version":1,"terms":'); // 半截
    const rows = knowledge.search('十堰');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, entry.id);
    // 重建之后索引文件又是一份能解析的。
    assert.ok(JSON.parse(fs.readFileSync(indexFile, 'utf8')).terms);
  });
});

test('通话里攒、结束再整理：草稿不落盘，flush 才写，同一通里重复的只写一条', () => {
  withRoot((root) => {
    assert.equal(knowledge.noteForCall('call-1', '绿点改成红色'), true);
    knowledge.noteForCall('call-1', '绿点改成红色'); // 同一句说了两遍
    knowledge.noteForCall('call-1', '每周五整理收件目录');
    // 说的时候还不落盘：这一通聊完才算数。
    assert.equal(knowledge.listEntries().length, 0, '通话中不该往库里写');
    assert.equal(fs.existsSync(path.join(root, 'entries')), false);

    const written = knowledge.flushCall('call-1');
    assert.equal(written.length, 2, '重复的那句只写一条');
    assert.equal(written[0].sessionId, 'call-1');
    assert.equal(knowledge.listEntries().length, 2);
    assert.match(knowledge.search('绿点')[0].text, /绿点改成红色/);

    // 通完之后草稿清空，再 flush 一次什么都不写。
    assert.deepEqual(knowledge.flushCall('call-1'), []);
  });
});

test('通话结束整理：与库里已存条目雷同的丢掉，已存条目一个字都不改', () => {
  withRoot((root) => {
    const existing = knowledge.appendEntry({ text: '部署走十堰那台中转' });
    const file = path.join(root, 'entries', `${existing.id}.json`);
    const before = fs.readFileSync(file, 'utf8');

    knowledge.noteForCall('call-2', '部署走十堰那台中转！'); // 只差一个标点
    knowledge.noteForCall('call-2', '顺便把首页的标语改短一点');
    const written = knowledge.flushCall('call-2');
    assert.equal(written.length, 1);
    assert.match(written[0].text, /标语改短/);

    assert.equal(fs.readFileSync(file, 'utf8'), before, '已存条目不许因为「整理」被改写');
  });
});

test('草稿按龄清掉：没正常收尾的通话不会把半截内容留到下次', () => {
  withRoot(() => {
    knowledge.noteForCall('call-3', '说了一半就断线了');
    const dropped = knowledge.sweepDrafts(Date.now() + knowledge.DRAFT_TTL_MS + 1000);
    assert.equal(dropped, 1);
    assert.deepEqual(knowledge.flushCall('call-3'), []);
    assert.equal(knowledge.listEntries().length, 0, '半通电话攒的东西不成条目');
  });
});

test('一条路径按方法分派：GET 是检索、POST 是追加（宿主注册器不按方法分派）', async () => {
  await withRootAsync(async () => {
    const { handlers } = mount(null);
    const server = http.createServer((req, res) => {
      if (String(req.url || '').split('?')[0] !== '/knowledge') {
        res.writeHead(404).end('{}');
        return;
      }
      void handlers.handleKnowledge({}, req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const post = await fetch(`${base}/knowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '首页标语改短一点' }),
      }).then((r) => r.json());
      assert.equal(post.ok, true);

      const get = await fetch(`${base}/knowledge?q=${encodeURIComponent('标语')}`).then((r) => r.json());
      assert.equal(get.ok, true);
      assert.equal(get.items.length, 1);
      assert.match(get.items[0].text, /标语改短/);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('mount 的路由 handler：追加 / 检索 / 人删走真 req/res', async () => {
  await withRootAsync(async () => {
    const { handlers } = mount(null);
    const server = http.createServer((req, res) => {
      const route = String(req.url || '').split('?')[0];
      if (route !== '/knowledge') {
        res.writeHead(404).end('{}');
        return;
      }
      const handler = req.method === 'POST' ? handlers.handleKnowledgeAppend : handlers.handleKnowledgeList;
      if (req.method === 'DELETE') void handlers.handleKnowledge({}, req, res);
      else void handler({}, req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const appended = await fetch(`${base}/knowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '部署走十堰那台中转', keywords: ['部署'] }),
      }).then((r) => r.json());
      assert.equal(appended.ok, true);
      assert.match(appended.entry.id, /^kb[0-9a-f]{8}$/);

      const listed = await fetch(`${base}/knowledge`).then((r) => r.json());
      assert.equal(listed.ok, true);
      assert.equal(listed.items.length, 1);

      const searched = await fetch(`${base}/knowledge?q=${encodeURIComponent('十堰')}`).then((r) => r.json());
      assert.equal(searched.ok, true);
      assert.equal(searched.items.length, 1);
      assert.equal(searched.items[0].text, '部署走十堰那台中转');

      // 空正文 → 400，且库里不多一条。
      const bad = await fetch(`${base}/knowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keywords: ['没有正文'] }),
      });
      assert.equal(bad.status, 400);
      assert.equal(knowledge.listEntries().length, 1);

      // 人删一条：DELETE + ?id= 真删掉，索引里也搜不到了；删不存在的回 404。
      const removed = await fetch(`${base}/knowledge?id=${appended.entry.id}`, { method: 'DELETE' }).then((r) => r.json());
      assert.equal(removed.ok, true);
      assert.equal(knowledge.listEntries().length, 0);
      const gone = await fetch(`${base}/knowledge?q=${encodeURIComponent('十堰')}`).then((r) => r.json());
      assert.equal(gone.items.length, 0, '删掉之后索引也得摘干净');
      const missing = await fetch(`${base}/knowledge?id=kb00000000`, { method: 'DELETE' });
      assert.equal(missing.status, 404);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
