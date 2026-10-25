'use strict';

/**
 * 面板多语言的守卫：字典对称性 + 「界面不再直接写中文」。
 *
 * 面板（`React/src`）与手机 App 是两套构建，各有各的字典，但**规矩一样**：
 *   · `zh-Hans` 是键集真源，其余四门逐键对齐，多一个少一个都算错；
 *   · 每条文案里的 `{占位符}` 集合必须与源语言一致 —— 漏一个占位符不会报错，
 *     只会在界面上少一块字；
 *   · 不许有空串（空串等于静默丢文案）；
 *   · 同一个键不许落在两个领域文件里（那会让「这页的文案跑到那页去」）。
 *
 * 另外钉一条「不留硬编码中文」：组件里再冒出中文，海外用户就会在那一处看到中文。
 * 只查**字符串字面量**，不查注释 —— 这个仓库的注释全是中文，查了就是一片红。
 *
 * 为什么这条守卫值得存在：面板的字典是 2026-10-11 删过一次、2026-10-24 整页重建的。
 * 重建之后最容易发生的退化是「新加一行文案时直接写中文」，而它不会有任何报错。
 */

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', 'React', 'src');
const I18N = path.join(SRC, 'lib', 'i18n');
const MESSAGES = path.join(I18N, 'messages');

const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'];

/** 读一个领域文件，返回 `{ 键: { 语言: 文案 } }`。 */
function loadDomain(file) {
  const text = fs.readFileSync(path.join(MESSAGES, file), 'utf8');
  // 不引 TS 运行时：用正则把「语言块 → 键值对」抽出来，够这条守卫用。
  const out = {};
  const blocks = [...text.matchAll(/^  (?:'([\w-]+)'|(\w+)): \{\n([\s\S]*?)^  \},$/gm)];
  for (const block of blocks) {
    const language = block[1] || block[2];
    if (!LANGUAGES.includes(language)) continue;
    for (const line of block[3].matchAll(/^\s+'([\w.]+)': '((?:[^'\\]|\\.)*)',$/gm)) {
      const key = line[1];
      out[key] = out[key] || {};
      out[key][language] = line[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
  }
  return out;
}

const DOMAIN_FILES = fs
  .readdirSync(MESSAGES)
  .filter((name) => name.endsWith('.ts') && name !== 'shell.ts')
  .sort();

/** 所有领域文件合起来：键 → 语言 → 文案。 */
const ALL = {};
const OWNER = {};
for (const file of DOMAIN_FILES) {
  for (const [key, byLang] of Object.entries(loadDomain(file))) {
    ALL[key] = byLang;
    OWNER[key] = OWNER[key] || [];
    OWNER[key].push(file);
  }
}

/** 一条文案里的占位符集合。 */
function placeholders(text) {
  return [...new Set([...String(text || '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
}

test('字典里至少有一批键（守卫本身没读空）', () => {
  assert.ok(Object.keys(ALL).length > 100, `只读到 ${Object.keys(ALL).length} 个键，抽取逻辑可能坏了`);
});

test('每门语言都有全部键，且没有空串', () => {
  for (const language of LANGUAGES) {
    const missing = [];
    const empty = [];
    for (const [key, byLang] of Object.entries(ALL)) {
      const value = byLang[language];
      if (value === undefined) missing.push(key);
      else if (value.length === 0) empty.push(key);
    }
    assert.deepEqual(missing, [], `${language} 缺这些键`);
    assert.deepEqual(empty, [], `${language} 这些键是空串`);
  }
});

test('占位符集合与源语言一致', () => {
  const mismatched = [];
  for (const [key, byLang] of Object.entries(ALL)) {
    const want = placeholders(byLang['zh-Hans']).join(',');
    for (const language of LANGUAGES) {
      if (placeholders(byLang[language]).join(',') !== want) {
        mismatched.push(`${key}[${language}: ${placeholders(byLang[language]).join(' ')} vs ${want}]`);
      }
    }
  }
  assert.deepEqual(mismatched.slice(0, 20), [], '占位符对不上（漏一个就是运行期少一块字）');
});

test('同一个键不许落在两个领域文件里', () => {
  const dupes = Object.entries(OWNER).filter(([, files]) => files.length > 1);
  assert.deepEqual(dupes.map(([key, files]) => `${key}: ${files.join(' + ')}`), []);
});

test('键名带 panel. 前缀（与 App 的 key 不会撞）', () => {
  const stray = Object.keys(ALL).filter((key) => !key.startsWith('panel.'));
  assert.deepEqual(stray.slice(0, 20), []);
});

/** 组件与 lib 里的源码（排除字典自身）。 */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'i18n' || entry.name === 'demo') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

/** 这个文件接过取词没有：组件从字典拿词，或外壳订阅了语言。 */
function usesI18n(text) {
  return /i18n\/(index|use-language)\.ts/.test(text);
}

test('已经接过字典的文件里不许残留中文（注释不算，JSX 正文也算）', () => {
  // 判据是「这个文件已经接过取词出口」：那种文件里再冒出中文，就是「同一页里一半
  // 跟着语言走、一半钉死中文」—— 这是最难发现的一种退化。
  //
  // **2026-10-26 收紧**：原来只扫**带引号的字符串**，于是 JSX 正文里那种裸中文
  // （`<Button>查看</Button>`）整片漏网 —— 上一轮「整页翻完」其实有二十来处还钉在中文上，
  // 守卫却是全绿的。现在按「去掉注释之后还剩不剩汉字」判，正文、模板串、属性一视同仁。
  // 注释不算：这个仓库的注释本来就全是中文。
  //
  // 还没接字典的文件不在这里判：面板是**整页分批搬**的，新加的文件可能属于
  // 另一条在途工作（本仓有多个对话并行改同一个工作区）。它们列在下面那份
  // 未迁移清单里，谁接手谁搬，别让这条守卫替别人拍板。
  const migrated = [];
  const strays = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!usesI18n(text)) continue;
    migrated.push(file);
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    stripped.split('\n').forEach((line, index) => {
      if (/[\u4e00-\u9fff]/.test(line)) {
        strays.push(`${path.relative(SRC, file)}:${index + 1}: ${line.trim().slice(0, 60)}`);
      }
    });
  }
  assert.ok(migrated.length > 8, `只有 ${migrated.length} 个文件接了字典`);
  assert.deepEqual(strays.slice(0, 20), [], '这些已接字典的文件还写着中文，那一处会永远是中文');
});

test('未接字典的文件登记在册（新加的界面文案要有人接手）', () => {
  // 只报不判：列出还没接过取词出口的界面文件。清单是给人看的，
  // 用来确认「新加的那一屏有没有人负责翻」。
  const pending = sourceFiles()
    .filter((file) => !usesI18n(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file))
    .sort();
  if (pending.length > 0) {
    console.log(`  还没接字典的界面文件（${pending.length}）：${pending.join(', ')}`);
  }
  assert.ok(Array.isArray(pending));
});

test('组件里取词走统一的出口', () => {
  const files = sourceFiles();
  const usingT = files.filter((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes("from '../lib/i18n/index.ts'") || text.includes("from './i18n/index.ts'")
      || text.includes("from './lib/i18n/index.ts'");
  });
  assert.ok(usingT.length > 8, `只有 ${usingT.length} 个文件接了字典，看起来没接完`);
});

// ── 手动切换语言（2026-10-26）────────────────────────────────────────────────
//
// 这一段**真跑** `core.ts`：语言偏好是模块级状态，读盘 / 落盘 / 通知三件事全在里面，
// 用源码文本断言钉不住「选了没生效」这种退化。Node 26 能直接加载 .ts（类型擦除），
// 所以每个用例都 `import` 一份新模块，再往 `globalThis` 上装一套假的浏览器环境。

const { pathToFileURL } = require('node:url');

const CORE = path.join(I18N, 'core.ts');
const LANGUAGE_KEY = 'dsh-mobile-panel-language';

/** 一份全新的模块：模块级状态（选择 / 探测结果）因此不串用例。 */
function freshCore() {
  return import(`${pathToFileURL(CORE).href}?case=${Math.random()}`);
}

/** 假的浏览器：localStorage 走内存，navigator 只给语言列表。 */
function fakeBrowser({ languages = [], stored = null } = {}) {
  const memory = new Map();
  if (stored !== null) memory.set(LANGUAGE_KEY, stored);
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: (key) => memory.delete(key),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { languages },
    configurable: true,
    writable: true,
  });
  return memory;
}

test('语言标签归一：繁体的四种写法与认不出', async () => {
  const core = await freshCore();
  const cases = [
    ['zh-Hans-CN', 'zh-Hans'],
    ['zh', 'zh-Hans'],
    ['zh_TW', 'zh-Hant'],
    ['zh-Hant-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['zh-MO', 'zh-Hant'],
    ['en-GB', 'en'],
    ['ja', 'ja'],
    ['ko-KR', 'ko'],
    ['fr-FR', null],
    ['', null],
  ];
  for (const [tag, want] of cases) assert.equal(core.normalizeLocale(tag), want, `认错了：${tag}`);
});

test('默认跟着浏览器走，认不出落英文', async () => {
  const japanese = await freshCore();
  fakeBrowser({ languages: ['ja-JP', 'en-US'] });
  assert.equal(japanese.panelLanguage(), 'ja');

  const russian = await freshCore();
  fakeBrowser({ languages: ['ru-RU'] });
  assert.equal(russian.panelLanguage(), 'en', '系统语言不是这五门时该给英文');
});

test('手动选的那一门压过浏览器，并且写进 localStorage', async () => {
  const core = await freshCore();
  const memory = fakeBrowser({ languages: ['en-US'] });
  assert.equal(core.panelLanguagePreference(), 'system');

  let notified = 0;
  const off = core.subscribePanelLanguage(() => { notified += 1; });
  core.setPanelLanguagePreference('ko');

  assert.equal(core.panelLanguage(), 'ko', '选完没生效');
  assert.equal(core.panelLanguagePreference(), 'ko');
  assert.equal(memory.get(LANGUAGE_KEY), 'ko', '没有落盘，下次打开就忘了');
  assert.ok(notified >= 1, '没有通知订阅者，页面不会重绘');

  off();
  core.setPanelLanguagePreference('ja');
  assert.equal(notified, 1, '退订之后还在通知');
});

test('「跟随浏览器」会把盘上的键删掉，并回到浏览器那门', async () => {
  const core = await freshCore();
  const memory = fakeBrowser({ languages: ['ja-JP'], stored: 'en' });
  assert.equal(core.panelLanguage(), 'en', '盘上那条没压过浏览器');

  core.setPanelLanguagePreference('system');
  assert.equal(memory.has(LANGUAGE_KEY), false, '选回默认时应当把键删掉，否则下次又被它盖住');
  assert.equal(core.panelLanguagePreference(), 'system');
  assert.equal(core.panelLanguage(), 'ja');
});

test('盘上存的是认不出的值时，当作跟随浏览器', async () => {
  const core = await freshCore();
  fakeBrowser({ languages: ['ko-KR'], stored: 'klingon' });
  assert.equal(core.panelLanguagePreference(), 'system');
  assert.equal(core.panelLanguage(), 'ko');
});

test('右上角两颗按钮：同一处渲染，两个入口共用一份外壳', () => {
  const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

  // 外壳：页面本体 + 那组按钮，并且**订阅了语言**（不订阅就换不动语言）。
  const shell = read('Shell.tsx');
  assert.match(shell, /<Root \/>/, '外壳里要渲染页面本体');
  // 右下角那颗「加入交流群」也归外壳（2026-10-26 用户要求引导页也放一颗）：
  // 挂在外壳里渲染一次，引导页与主页都有，两处不会各写一个坐标。
  assert.match(shell, /<JoinGroupButton \/>/, '外壳里要渲染「加入交流群」');
  assert.match(shell, /<TopRightActions \/>/, '外壳里要渲染右上角那组按钮');
  assert.match(shell, /usePanelLanguage\(\)/, '外壳必须订阅语言状态，否则切语言整页不重绘');

  // 两个入口都只渲染外壳，谁也不许自己再挂一颗（那就成了两处坐标）。
  for (const entry of [['main.tsx'], ['demo', 'main.tsx']]) {
    const text = read(...entry);
    assert.match(text, /from '\.{1,2}\/Shell\.tsx'/, `${entry.join('/')} 应当从 Shell 进来`);
    assert.match(text, /<Shell \/>/, `${entry.join('/')} 应当渲染 Shell`);
    assert.equal((text.match(/<ThemeToggle|<LanguageMenu|<JoinGroupButton/g) ?? []).length, 0,
      `${entry.join('/')} 里别再单独挂按钮，位置归 TopRightActions`);
  }

  // 按钮组：两颗都在，坐标只在这一层。
  const actions = read('components', 'TopRightActions.tsx');
  assert.match(actions, /<LanguageMenu \/>/, '按钮组里缺语言按钮');
  assert.match(actions, /<ThemeToggle \/>/, '按钮组里缺日夜切换');
  for (const file of ['ThemeToggle.tsx', 'LanguageMenu.tsx']) {
    assert.doesNotMatch(read('components', file), /fixed /, `${file} 不许自己钉坐标，位置归 TopRightActions`);
  }

  // 语言清单只能来自 PANEL_LANGUAGES：手写一份五门等于第二处真源。
  const menu = read('components', 'LanguageMenu.tsx');
  assert.match(menu, /PANEL_LANGUAGES\.map/, '语言清单必须来自 PANEL_LANGUAGES');
  assert.match(menu, /LANGUAGE_LABELS\[/, '语言自称必须来自 LANGUAGE_LABELS');
  assert.match(menu, /setPanelLanguagePreference/, '选了要落到偏好上');
});
