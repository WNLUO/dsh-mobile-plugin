'use strict';

/**
 * 插件发版说明的守卫：校验与压缩。
 *
 * 这一格错了，后果很安静：说明缺了一门语言、繁体没转、某一门是中文照搬，用户照样看到更新窗，
 * 只是他看不懂那段字；或者压进包清单的形状变了，App 那边就读不到说明。所以这里用纯函数直接
 * 跑真实现，不碰文件系统。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'pt', 'ru', 'tr'];

let mod;
test.before(async () => { mod = await import('../scripts/plugin-release-notes.mjs'); });

/** 造一份十门齐全、能过校验的说明。`overrides` 覆盖顶层字段。 */
function goodNotes(overrides = {}) {
  const notes = {};
  for (const lang of LANGS) notes[lang] = `${lang} summary`;
  // 这几门放能过「译文自检」的字形：拉丁门不放中文、日文有假名、韩文有谚文、繁简不同。
  notes.en = 'Fixed a reconnect glitch';
  notes.de = 'Verbindungsfehler behoben';
  notes.ja = '再接続の問題を修正しました';
  notes.ko = '재연결 문제를 수정했습니다';
  notes['zh-Hans'] = '- 修复更新时的短暂断连';
  notes['zh-Hant'] = '- 修復更新時的短暫斷連';
  return {
    version: '0.5.105',
    from: { version: '0.5.104', ref: 'abc1234' },
    changes: [{ kind: 'security', 'zh-Hans': '修复更新时的短暂断连' }],
    notes,
    ...overrides,
  };
}

test('十门齐全、坐标一致的说明：通过', () => {
  const problems = mod.validatePluginReleaseNotes(goodNotes(), { version: '0.5.105' });
  assert.deepEqual(problems, []);
});

test('缺一门语言 / 空串：点名列出来', () => {
  const data = goodNotes();
  delete data.notes.ja;
  data.notes.ko = '';
  const problems = mod.validatePluginReleaseNotes(data, { version: '0.5.105' });
  assert.ok(problems.some((p) => p.includes('ja')));
  assert.ok(problems.some((p) => p.includes('ko')));
});

test('版本对不上本次要发的：报出来', () => {
  const problems = mod.validatePluginReleaseNotes(goodNotes(), { version: '0.5.106' });
  assert.ok(problems.some((p) => p.includes('version')));
});

test('译文事故：拉丁门混中文 / 日文没假名 / 繁体等同简体 都拦', () => {
  const data = goodNotes();
  data.notes.en = '修复了问题';
  data.notes.ja = '再接続の問題を修正'; // 去掉假名仍含汉字，构造「无假名」
  data.notes.ja = '問題修正';           // 纯汉字
  data.notes['zh-Hant'] = data.notes['zh-Hans'];
  const problems = mod.validatePluginReleaseNotes(data, null);
  assert.ok(problems.some((p) => p.includes('notes.en')));
  assert.ok(problems.some((p) => p.includes('notes.ja')));
  assert.ok(problems.some((p) => p.includes('zh-Hant')));
});

test('改动类型只允许 feature/fix/security/other', () => {
  const data = goodNotes({ changes: [{ kind: 'bugfix', 'zh-Hans': 'x' }] });
  const problems = mod.validatePluginReleaseNotes(data, null);
  assert.ok(problems.some((p) => p.includes('kind')));
});

test('压缩成随包形状：version + kinds 去重 + 十门 notes', () => {
  const data = goodNotes({
    changes: [
      { kind: 'security', 'zh-Hans': 'a' },
      { kind: 'feature', 'zh-Hans': 'b' },
      { kind: 'security', 'zh-Hans': 'c' },
    ],
  });
  const compact = mod.compactReleaseNotes(data);
  assert.equal(compact.version, '0.5.105');
  assert.deepEqual(compact.kinds, ['security', 'feature']);
  assert.equal(compact.notes.en, 'Fixed a reconnect glitch');
  assert.equal(Object.keys(compact.notes).length, 11);
});

test('草稿：提交按类型映射，notes 只有 zh-Hans 有内容、其余留空', () => {
  const draft = mod.buildPluginDraft({
    commits: ['feat: 新增更新总览页', 'fix: 修复断连', 'chore: 构建脚本'],
    from: { version: '0.5.104', ref: 'abc' },
    version: '0.5.105',
  });
  assert.equal(draft.version, '0.5.105');
  assert.equal(draft.changes[0].kind, 'feature');
  assert.ok(draft.notes['zh-Hans'].includes('新增更新总览页'));
  assert.equal(draft.notes.en, '', '其余九门必须留空，不许拿中文冒充翻译');
});
