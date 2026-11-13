'use strict';

// 回答下面那一行「来源」的挑选口径：从一轮的工具调用里挑出「读过的材料」。
//
// 这里钉三件事，都是口径而不是实现细节：
//  ① **只挑读材料的三种工具**（web_fetch / read / read_image / web_search），别的工具
//     （grep、glob、bash、write）一条都不出 —— 挑出来也回不到任何一份材料；
//  ② **失败的那一次不算读过**：抓取报错、读文件被拒没留下材料；
//  ③ **只给指针不带正文**：返回里没有一分正文，标题按类别取（网页给域名、文件给文件名）；
//  ④ **读过的材料照单全出**：折叠成几条是手机侧的事，插件只在极端条数上兜底。
//  ⑤ **来源指针完整保留**：长路径 / 网址不拿截短摘要代替，实时与历史两条端点都真跑。

const test = require('node:test');
const assert = require('node:assert/strict');

const { answerSourcesOf, handleAnswerSources, MAX_SOURCES } = require('../lib/mobile/answer-sources.js');
const { toolStepSummary } = require('../lib/mobile/step-index.js');
const { noteLiveEvent, liveStepsOf } = require('../lib/mobile/live-steps.js');

/** 造一步：原始参数只在宿主内供来源提取，过程摘要仍截到原来的上限。 */
function step(name, place, extra) {
  const key = name === 'web_fetch' ? 'url' : name === 'web_search' ? 'query' : 'file_path';
  const argsRaw = JSON.stringify({ [key]: place });
  return {
    key: `tool:${name}-${place}`,
    argsRaw,
    step: { kind: 'tool', name, summary: toolStepSummary(name, argsRaw), state: 'ok', ...(extra || {}) },
  };
}
const think = { key: 'think:0', step: { kind: 'think', summary: '先想想', state: 'ok' } };

test('网页 / 文件 / 搜索各出一条，标题按类别取（网页给域名、文件给文件名、搜索给查询词）', () => {
  const hits = answerSourcesOf([
    think,
    step('web_fetch', 'https://example.com/a/b?q=1'),
    step('read', '/work/repo/README.md'),
    step('web_search', 'dsh mobile 来源卡片'),
  ]);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((hit) => hit.kind), ['web', 'file', 'search']);
  assert.equal(hits[0].title, 'example.com');
  assert.equal(hits[0].place, 'https://example.com/a/b?q=1');
  assert.equal(hits[1].title, 'README.md');
  assert.equal(hits[2].title, 'dsh mobile 来源卡片');
  // 指回具体步骤（第几步），不是 0。
  assert.deepEqual(hits.map((hit) => hit.step), [2, 3, 4]);
});

test('只挑读材料的工具：grep / glob / bash / write 一条都不出', () => {
  const hits = answerSourcesOf([
    step('grep', 'answerSources'),
    step('glob', '**/*.ts'),
    step('bash', 'ls -la'),
    step('write', '/work/repo/x.ts'),
    step('read_image', '/work/shot.png'),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'file');
  assert.equal(hits[0].title, 'shot.png');
});

test('失败的那一次不算读过（报错 / 被停止都不出）', () => {
  const hits = answerSourcesOf([
    step('web_fetch', 'https://broken.example/x', { state: 'error' }),
    step('read', '/work/a.md', { state: 'stopped' }),
    step('read', '/work/b.md'),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].place, '/work/b.md');
});

test('同一个网址读两次只占一条，位置按最后一次', () => {
  const hits = answerSourcesOf([
    step('web_fetch', 'https://example.com/x'),
    step('web_search', '别的'),
    step('web_fetch', 'https://example.com/x'),
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits[1].place, 'https://example.com/x');
  assert.equal(hits[1].step, 3);
});

test('一轮读九份材料就出九条：手机侧自己折叠，插件不再按 6 条截断', () => {
  const entries = [];
  for (let i = 0; i < 9; i += 1) entries.push(step('web_fetch', `https://s${i}.example/x`));
  const hits = answerSourcesOf(entries);
  assert.equal(hits.length, 9);
  assert.deepEqual(
    hits.map((hit) => hit.place),
    Array.from({ length: 9 }, (_, i) => `https://s${i}.example/x`),
  );
});

test('至多 MAX_SOURCES 条，取最近读的那几条', () => {
  const entries = [];
  for (let i = 0; i < MAX_SOURCES + 3; i += 1) entries.push(step('web_fetch', `https://e${i}.example/x`));
  const hits = answerSourcesOf(entries);
  assert.equal(hits.length, MAX_SOURCES);
  // 留下的是最后读的那几条。
  assert.equal(hits[hits.length - 1].place, `https://e${MAX_SOURCES + 2}.example/x`);
  assert.equal(hits.some((hit) => hit.place === 'https://e0.example/x'), false);
});

test('超过兜底上限时恰好留 MAX_SOURCES 条，且是从末尾往前数的那些', () => {
  const total = MAX_SOURCES + 5;
  const entries = [];
  for (let i = 0; i < total; i += 1) entries.push(step('read', `/work/m${i}.md`));
  const hits = answerSourcesOf(entries);
  assert.equal(hits.length, MAX_SOURCES);
  assert.equal(hits[0].place, '/work/m5.md');
  assert.equal(hits[hits.length - 1].place, `/work/m${total - 1}.md`);
  assert.equal(hits.some((hit) => hit.place === '/work/m4.md'), false);
});

test('返回的是指针形状：有 obsId / mediaIds，正文一个字都不带', () => {
  const hits = answerSourcesOf([step('web_fetch', 'https://example.com/page')]);
  const hit = hits[0];
  assert.equal(typeof hit.obsId, 'number');
  assert.deepEqual(hit.mediaIds, []);
  assert.equal(hit.source, 'web_fetch');
  assert.equal(Object.keys(hit).sort().join(','), 'kind,mediaIds,obsId,place,source,step,title');
  assert.equal(Object.values(hit).some((value) => typeof value === 'string' && value.length > 200), false);
});

test('没有步骤 / 形状不对 / 指针为空时不出条目', () => {
  assert.deepEqual(answerSourcesOf([]), []);
  assert.deepEqual(answerSourcesOf(null), []);
  assert.deepEqual(answerSourcesOf([{ key: 'x' }, null, 3]), []);
  assert.deepEqual(answerSourcesOf([step('web_fetch', '')]), []);
  assert.deepEqual(answerSourcesOf([{ key: 'y', step: { kind: 'think', summary: '想想' } }]), []);
});

const longDirectory = `/Volumes/移动硬盘/code/项目/${'资料目录/'.repeat(12)}`;
const longPath = `${longDirectory}方案说明.md`;
const longUrl = `https://example.com/${'chapter/'.repeat(15)}reference?section=conclusion`;

test('长路径保留完整文件名与地址，不拿 72 字摘要当来源', () => {
  const entry = step('read', longPath);
  assert.notEqual(entry.step.summary, longPath, '用例必须覆盖路径已被过程摘要截短的情况');
  const [hit] = answerSourcesOf([entry]);
  assert.equal(hit.title, '方案说明.md');
  assert.equal(hit.place, longPath);
  assert.equal(Object.hasOwn(hit, 'argsRaw'), false, '原始参数不下发');
});

test('同一长目录的两个文件各自保留，不会被相同的截短摘要合并', () => {
  const first = step('read', longPath);
  const second = step('read_image', `${longDirectory}参考截图.jpg`);
  assert.equal(first.step.summary, second.step.summary);
  const hits = answerSourcesOf([first, second]);
  assert.deepEqual(hits.map((hit) => hit.title), ['方案说明.md', '参考截图.jpg']);
});

test('长网址与多个搜索词完整保留', () => {
  const queries = ['长路径显示 '.repeat(15).trim(), '来源与输出的区别'];
  const hits = answerSourcesOf([
    step('web_fetch', longUrl),
    { ...step('web_search', ''), argsRaw: { queries } },
  ]);
  assert.equal(hits[0].place, longUrl);
  assert.equal(hits[0].title, 'example.com');
  assert.deepEqual(hits.slice(1).map((hit) => hit.place), queries);
});

/** 端点用与一步详情相同的响应假体，直接核对真实返回。 */
function call(ctx, query) {
  return new Promise((resolve, reject) => {
    const res = {
      req: { headers: {} },
      writeHead(status) { this.status = status; },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    handleAnswerSources(ctx, { url: `/api/mobile/v1/session/answer-sources?${new URLSearchParams(query)}` }, res).catch(reject);
  });
}

function assistantCall(path) {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: JSON.stringify({ file_path: path }) }] },
    },
  };
}

test('实时端点从已有详情副本提取完整路径，清单摘要仍保持短文本', async () => {
  const ctx = { apiProxy: { sessions: { history: async () => { throw new Error('不应回拉历史'); } } } };
  noteLiveEvent(ctx, 'live', { type: 'turn/start', data: { turn: 1 } });
  noteLiveEvent(ctx, 'live', assistantCall(longPath));
  const summary = liveStepsOf(ctx, 'live')[0].step.summary;
  assert.notEqual(summary, longPath);
  const result = await call(ctx, { sessionId: 'live', turn: '1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.sources[0].title, '方案说明.md');
  assert.equal(result.body.sources[0].place, longPath);
  assert.equal(liveStepsOf(ctx, 'live')[0].step.summary, summary);
});

test('历史端点从原始工具参数提取完整路径', async () => {
  const ctx = {
    apiProxy: { sessions: { history: async () => ({
      result: { ok: true, value: { events: [{ type: 'event', event: assistantCall(longPath) }], hasMore: false } },
    }) } },
  };
  const result = await call(ctx, { sessionId: 'history', turn: '1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.sources[0].title, '方案说明.md');
  assert.equal(result.body.sources[0].place, longPath);
});
