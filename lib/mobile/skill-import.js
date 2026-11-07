'use strict';

/**
 * 技能导入 / 分享：把别人分享来的一份 SKILL.md（或一包技能目录）当**不可信外来输入**收进来。
 *
 * ## 规则
 *
 *  · 外来内容不经过模型、也不直接启用：校验通过后只产出「待收下的草稿」，由用户在「待确认」
 *    里看过、点收下才落盘（落盘归 `skill-store.js`）。这一步强制 pending，不能直接 active。
 *  · frontmatter 必填（`name` + `description`），名字 kebab、目录名将来 == name；正文五节齐全。
 *  · 路径穿越一律拒绝：附件相对路径只许落在 `references/` 或 `scripts/` 下，不许绝对路径、
 *    不许 `..`、不许反斜杠。
 *  · 大小 / 文件数上限：单文件、整包、文件数各有一道线。
 *  · 外来内容全部标 `untrusted`；脚本另外给「能不能跑」的标记（只有包内 `scripts/manifest.json`
 *    里显式 `runnable: true` 的才算候选，且导入侧默认不信任，要用户点头）。
 *  · 敏感信息关卡与自学草稿共用同一份（见 `memory.js` 的 `sensitiveHit`）：草稿里带密码 / 卡号 /
 *    验证码 / api key 就整条拒收。
 *
 * ## 与 Mika 的对应
 *
 * `SkillImport.prepare`：`shareable`（分享时剥掉本机专用字段）+ 同名内置拒绝 + 同名个人技能变
 * 更新草稿 + 强制 pending。这里把它的判据搬成纯 JS，少了模型那一段。
 */

const crypto = require('node:crypto');

const { sensitiveHit } = require('./memory.js');

/** 一份技能正文的上限（字符）。与 Mika `SkillDrafter.MAX_CHARS` 一致。 */
const MAX_SKILL_CHARS = 4000;
/**
 * 导入时允许的原始长度上限（字符）：外来文本可能夹带围栏、注释，给正文上限的两倍。
 */
const MAX_IMPORT_CHARS = 8000;
/** 导入包的文件数上限。 */
const MAX_FILES = 100;
/** 单个附件上限。 */
const MAX_FILE_BYTES = 1024 * 1024;
/** 整包附件总字节上限。 */
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/** 技能名：小写字母、数字、连字符，同时也是目录名。 */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 正文五节（顺序不强求，但都要在）。 */
const SECTIONS = Object.freeze(['入口', '步骤', '容易出错的地方', '怎样算办成', '什么时候停下交给用户']);
/** 本机才有意义的字段：分享出去时剥掉，导入时由代码重写。 */
const LOCAL_FIELDS = Object.freeze(['updates', 'learned_from', 'source']);
/** 反引号里形如工具名的标识符。 */
const TOOL_MENTION = /`([a-z][a-z0-9_]*)`/g;
/** 文中的技能脚本路径，如 `scripts/extract_pdf.py`。 */
const SCRIPT_PATH = /[A-Za-z0-9_./-]*scripts\/[A-Za-z0-9_./-]+\.(?:py|mjs|js|sh)(?![A-Za-z0-9_])/g;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unquote(text) {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
  }
  return text;
}

/**
 * 解析一份 Markdown 的 frontmatter（只认简单一层 `key: value`，数组用 JSON）。
 * 返回 { hasFrontMatter, meta, body }。解析不出的一律留默认值，不抛。
 */
function parseFrontMatter(markdown) {
  const text = String(markdown == null ? '' : markdown).replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { hasFrontMatter: false, meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (value.startsWith('[')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = [];
      }
    } else {
      value = unquote(value);
    }
    if (key) meta[key] = value;
  }
  return { hasFrontMatter: true, meta, body: match[2] || '' };
}

function isField(line, key) {
  const colon = line.indexOf(':');
  return colon > 0 && line.slice(0, colon).trim() === key;
}

/** 把头部 `key: value` 换掉（没有就加、重复只留一个）；没有 frontmatter 原样返回。 */
function withField(markdown, key, value) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  if (lines[0] === undefined || lines[0].trimEnd() !== '---') return markdown;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (end < 0) return markdown;
  const matches = [];
  for (let i = 1; i < end; i += 1) if (isField(lines[i], key)) matches.push(i);
  if (matches.length === 0) lines.splice(end, 0, `${key}: ${value}`);
  else {
    lines[matches[0]] = `${key}: ${value}`;
    for (let i = matches.length - 1; i >= 1; i -= 1) lines.splice(matches[i], 1);
  }
  return lines.join('\n');
}

/** 去掉头部全部 `key:` 行；没有就原样返回。 */
function withoutField(markdown, key) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  if (lines[0] === undefined || lines[0].trimEnd() !== '---') return markdown;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (end < 0) return markdown;
  const matches = [];
  for (let i = 1; i < end; i += 1) if (isField(lines[i], key)) matches.push(i);
  if (matches.length === 0) return markdown;
  for (let i = matches.length - 1; i >= 0; i -= 1) lines.splice(matches[i], 1);
  return lines.join('\n');
}

/** 分享出去用的全文：剥掉本机专用字段（出处 / 学自哪次 / 更新指向）。 */
function shareable(markdown) {
  let out = String(markdown).replace(/\r\n/g, '\n');
  for (const key of LOCAL_FIELDS) out = withoutField(out, key);
  return out;
}

/** 去掉模型回复外面包着的代码块围栏。 */
function stripFence(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t.startsWith('```')) return t;
  return t.slice(t.indexOf('\n') + 1).replace(/```\s*$/, '').trim();
}

/**
 * 技能正文的格式与安全校验；通过返回 null，否则返回原因码：
 * `missing_frontmatter` / `invalid_name` / `missing_description` / `missing_section` /
 * `too_long` / `unknown_tool` / `unrunnable_script` / `sensitive`。
 *
 * opts.toolNames 给了才校验反引号工具名；opts.scriptTool + opts.runnableScripts 给了、且
 * opts.enforceRunnable !== false 时才校验脚本可运行。导入侧不强制脚本可运行（外来脚本默认不信任）。
 */
function validateSkill(markdown, opts = {}) {
  const md = String(markdown == null ? '' : markdown);
  const { hasFrontMatter, meta, body } = parseFrontMatter(md);
  if (!hasFrontMatter) return 'missing_frontmatter';
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!NAME_RE.test(name) || name.length > 64) return 'invalid_name';
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (!description) return 'missing_description';
  const headings = body.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());
  if (SECTIONS.some((section) => !headings.some((h) => h.startsWith(section)))) return 'missing_section';
  if (md.length > MAX_SKILL_CHARS) return 'too_long';

  const toolNames = opts.toolNames instanceof Set ? opts.toolNames : null;
  if (toolNames) {
    TOOL_MENTION.lastIndex = 0;
    let m = TOOL_MENTION.exec(md);
    while (m) {
      if (!toolNames.has(m[1])) return 'unknown_tool';
      m = TOOL_MENTION.exec(md);
    }
  }
  if (opts.scriptTool && opts.enforceRunnable !== false) {
    const runnable = opts.runnableScripts instanceof Set ? opts.runnableScripts : new Set();
    const mentionsScriptTool = new RegExp(`\`${opts.scriptTool}\``).test(md);
    if (mentionsScriptTool) {
      SCRIPT_PATH.lastIndex = 0;
      const paths = md.match(SCRIPT_PATH) || [];
      const runnableOf = (p) => [...runnable].some((r) => r === p || r.endsWith(`/${p}`));
      if (paths.length === 0 || !paths.every(runnableOf)) return 'unrunnable_script';
    }
  }
  if (sensitiveHit(md)) return 'sensitive';
  return null;
}

/**
 * 附件相对路径是否安全：只许 `references/...` 或 `scripts/...`，不含绝对路径 / `..` / 反斜杠。
 * 这一条同时是「路径穿越」的判据。
 */
function isSafeResourcePath(relPath) {
  if (typeof relPath !== 'string') return false;
  const p = relPath.trim();
  if (!p || p.length > 200) return false;
  if (p.includes('\\')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  if (!(p.startsWith('references/') || p.startsWith('scripts/'))) return false;
  const parts = p.split('/');
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return true;
}

/** 附件字节数：优先 content（utf8）/ base64，其次声明的 size。 */
function bytesOf(file) {
  if (typeof file.content === 'string') return Buffer.byteLength(file.content, 'utf8');
  if (typeof file.base64 === 'string') return Math.floor((file.base64.length * 3) / 4);
  if (Number.isFinite(file.size)) return file.size;
  return 0;
}

/**
 * 校验一份外来技能（文本或「已解出文件列表的包」）。返回：
 *   { ok: true, name, markdown, files, untrusted: true, scriptRunnable: string[] }
 * 或 { ok: false, problem }
 *
 * input: `{ markdown, files? }`；files 每条 `{ path, content? , base64?, size? }`。
 * opts: `{ builtinNames?: Set<string> }`。
 *
 * 说明：zip 的「解包」不在这里做（要额外依赖），handler 解出文件列表后把 `content` 传进来即可；
 * 文本分享直接传 markdown。
 */
function validateImport(input, opts = {}) {
  const payload = typeof input === 'string' ? { markdown: input } : (isRecord(input) ? input : null);
  if (!payload) return { ok: false, problem: 'bad_input' };
  const rawMarkdown = typeof payload.markdown === 'string' ? stripFence(payload.markdown) : '';
  if (!rawMarkdown) return { ok: false, problem: 'missing_markdown' };
  if (rawMarkdown.length > MAX_IMPORT_CHARS) return { ok: false, problem: 'too_long' };

  const format = validateSkill(rawMarkdown, { enforceRunnable: false });
  if (format) return { ok: false, problem: format };
  const { meta } = parseFrontMatter(rawMarkdown);
  const name = String(meta.name).trim();
  const builtinNames = opts.builtinNames instanceof Set ? opts.builtinNames : new Set();
  if (builtinNames.has(name)) return { ok: false, problem: 'builtin_name' };

  const rawFiles = payload.files == null ? [] : payload.files;
  if (!Array.isArray(rawFiles)) return { ok: false, problem: 'bad_files' };
  if (rawFiles.length > MAX_FILES) return { ok: false, problem: 'too_many_files' };

  const files = [];
  const seen = new Set();
  let total = 0;
  for (const file of rawFiles) {
    if (!isRecord(file) || !isSafeResourcePath(file.path)) return { ok: false, problem: 'bad_path' };
    const rel = file.path.trim();
    if (seen.has(rel)) return { ok: false, problem: 'duplicate_path' };
    seen.add(rel);
    const bytes = bytesOf(file);
    if (bytes > MAX_FILE_BYTES) return { ok: false, problem: 'file_too_large' };
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return { ok: false, problem: 'package_too_large' };
    const entry = { path: rel, size: bytes, untrusted: true, runnable: false };
    if (typeof file.content === 'string') entry.content = file.content;
    else if (typeof file.base64 === 'string') entry.base64 = file.base64;
    files.push(entry);
  }

  // 脚本能否运行：只看包内 scripts/manifest.json 里显式 runnable:true 且路径确实提供的。
  const scriptRunnable = [];
  const manifest = files.find((f) => f.path === 'scripts/manifest.json');
  if (manifest && typeof manifest.content === 'string') {
    try {
      const parsed = JSON.parse(manifest.content);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!isRecord(item) || item.runnable !== true || typeof item.file !== 'string') continue;
          const file = item.file.trim();
          if (!isSafeResourcePath(file)) continue;
          if (!files.some((f) => f.path === file)) continue;
          scriptRunnable.push(file);
        }
      }
    } catch {
      // manifest 坏了：当作没有任何可运行脚本，不拒收整包。
    }
  }
  for (const f of files) if (f.path.startsWith('scripts/') && scriptRunnable.includes(f.path)) f.runnable = true;

  return { ok: true, name, markdown: rawMarkdown, files, untrusted: true, scriptRunnable };
}

/**
 * 把外来技能变成一份**待收下草稿**（不落盘，落盘交给 skill-store）。
 * 返回 `{ status: 'ready', draft }` 或 `{ status: 'rejected', problem }`。
 *
 * opts: `{ builtinNames?, personalNames?, pendingNames?, id?, now? }`
 *  · 命中内置技能名 → 拒；
 *  · 同名已有一份待确认草稿 → 拒（`draft_pending`）；
 *  · 同名已有个人技能 → 变成它的「更新草稿」（`isUpdateOf`）。
 */
function importSkill(input, opts = {}) {
  const builtinNames = opts.builtinNames instanceof Set ? opts.builtinNames : new Set();
  const personalNames = opts.personalNames instanceof Set ? opts.personalNames : new Set();
  const pendingNames = opts.pendingNames instanceof Set ? opts.pendingNames : new Set();

  const result = validateImport(input, { builtinNames });
  if (!result.ok) return { status: 'rejected', problem: result.problem };

  const { name } = result;
  if (pendingNames.has(name)) return { status: 'rejected', problem: 'draft_pending' };
  const isUpdateOf = personalNames.has(name) ? name : null;
  const id = typeof opts.id === 'string' && opts.id ? opts.id : crypto.randomUUID();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  return {
    status: 'ready',
    draft: {
      id,
      name,
      markdown: result.markdown,
      files: result.files,
      untrusted: true,
      source: 'imported',
      isUpdateOf,
      createdAt: now,
    },
  };
}

module.exports = {
  MAX_SKILL_CHARS,
  MAX_IMPORT_CHARS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  NAME_RE,
  SECTIONS,
  LOCAL_FIELDS,
  parseFrontMatter,
  withField,
  withoutField,
  shareable,
  stripFence,
  validateSkill,
  isSafeResourcePath,
  validateImport,
  importSkill,
};
