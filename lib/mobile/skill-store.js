'use strict';

/**
 * 自建技能：把办成的一件事沉淀成技能草稿 → 用户确认 → 落进技能目录；并提供「技能正文 /
 * references / scripts」的读取通道。
 *
 * ## 为什么要有这一层
 *
 * 宿主里的技能是工作区 `.dsh/skills/<name>/SKILL.md` 这类 Markdown，手机端此前只能拿到
 * `name` + `description`（见 `skills.js`），正文与附件读不到、更写不进去。这一层补两块：
 *  1. **写入闭环**：一段办成的任务 → 五节结构的 `SKILL.md` 草稿（脱敏后）→ 待用户确认 →
 *     按 skill-authoring 约定落盘（name kebab、目录名 == name、长资料进 `references/`、
 *     能跑的脚本进 `scripts/` 并登记 `manifest.json`）。
 *  2. **读取通道**：`getSkillContent` 读全文，`listResources` 列附件，`readResource` 按相对
 *     路径读一个附件（resolve 后必须在技能目录内、只读、限大小）。
 *
 * ## 目录与状态
 *
 *  · 技能根：`<rootDir>`（缺省 `$DSH_HOME/storages/mobile-plugin/skills`，可用 `DSH_MOBILE_SKILLS`
 *    覆盖）。装配层可以把 rootDir 指向某工作区的 `.dsh/skills`，让宿主 `skills.list` 直接收进去；
 *    本模块只认 rootDir，不猜工作区。
 *  · 待确认草稿：`<dshHome>/storages/mobile-plugin/skill-drafts.json`（`DSH_MOBILE_SKILL_DRAFTS`
 *    覆盖），跨重启不丢。
 *
 * 草稿一律 `pending`，用户 `approveDraft` 才真正写盘；同名已有技能默认拒（`name_taken`），
 * 只有明确是它的「更新草稿」才覆盖。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');
const { sensitiveHit } = require('./memory.js');
const {
  NAME_RE,
  SECTIONS,
  parseFrontMatter,
  withField,
  validateSkill,
  isSafeResourcePath,
} = require('./skill-import.js');

/** 单份技能正文读取上限。 */
const MAX_SKILL_BYTES = 256 * 1024;
/** 单个附件读取上限：references / scripts 都是小文本，别让一次读取把内存顶爆。 */
const MAX_RESOURCE_BYTES = 512 * 1024;
/** 草稿带附件的文件数 / 单文件 / 整包上限。 */
const MAX_DRAFT_FILES = 100;
const MAX_DRAFT_FILE_BYTES = 1024 * 1024;
const MAX_DRAFT_TOTAL_BYTES = 5 * 1024 * 1024;
/** 脱敏占位。 */
const PLACEHOLDER = '<参数>';
const DIGITS = /\d{2,}/g;
const AMOUNT = /[¥$]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|块钱|块|万元|万|美元)/g;

/** 技能根。`DSH_MOBILE_SKILLS` 只给测试用 / 装配层覆盖。 */
function skillsRoot() {
  return process.env.DSH_MOBILE_SKILLS || path.join(dshHome(), 'storages', 'mobile-plugin', 'skills');
}

/** 待确认草稿的状态文件。 */
function draftsStateFile() {
  return process.env.DSH_MOBILE_SKILL_DRAFTS || path.join(dshHome(), 'storages', 'mobile-plugin', 'skill-drafts.json');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把这次的具体值（引号里的人名、金额、2 位以上数字）换成 `<参数>`；纯数字只换整段。 */
function redact(text, literals) {
  const source = String(text == null ? '' : text).normalize('NFKC');
  const list = [...new Set(
    (Array.isArray(literals) ? literals : [])
      .map((s) => String(s == null ? '' : s).trim())
      .filter((s) => s.length >= 2 || /^\d+$/.test(s)),
  )].sort((a, b) => b.length - a.length);
  let out = source;
  for (const lit of list) {
    if (/^\d+$/.test(lit)) out = out.replace(new RegExp(`(?<!\\d)${escapeRegExp(lit)}(?!\\d)`, 'g'), PLACEHOLDER);
    else out = out.split(lit).join(PLACEHOLDER);
  }
  return out;
}

/** 正文里剩下的一次性数字（单号、电话、价格）一律换掉；frontmatter 与 keepDigits 里的豁免。 */
function scrubNumbers(markdown, keepDigits) {
  const lines = String(markdown == null ? '' : markdown).split('\n');
  const frontEnd = lines[0] && lines[0].trimEnd() === '---'
    ? lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---')
    : -1;
  const keep = keepDigits instanceof Set ? keepDigits : new Set(Array.isArray(keepDigits) ? keepDigits : []);
  return lines.map((line, i) => {
    if (frontEnd >= 0 && i <= frontEnd) return line;
    return line
      .replace(AMOUNT, (m) => (keep.has(m.replace(/[^0-9.]/g, '')) ? m : PLACEHOLDER))
      .replace(DIGITS, (m) => (keep.has(m) ? m : PLACEHOLDER));
  }).join('\n');
}

/** 从结构化分节拼出一份 `SKILL.md`（五节都必须给）。拼不全就抛 `missing_section`。 */
function composeMarkdown(input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!NAME_RE.test(name)) throw new Error('invalid_name');
  if (!description) throw new Error('missing_description');
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : name;
  const sections = input.sections && typeof input.sections === 'object' ? input.sections : {};
  const chunks = ['---', `name: ${name}`, `description: ${description}`, '---', '', `# ${title}`, ''];
  for (const section of SECTIONS) {
    const body = typeof sections[section] === 'string' ? sections[section].trim() : '';
    if (!body) throw new Error('missing_section');
    chunks.push(`## ${section}`, '', body, '');
  }
  return `${chunks.join('\n').trim()}\n`;
}

/** 把一串动作整理成「步骤」节（编号列表）。 */
function stepsSection(steps) {
  const list = (Array.isArray(steps) ? steps : [])
    .map((step) => (typeof step === 'string' ? step.trim() : (step && typeof step.text === 'string' ? step.text.trim() : '')))
    .filter(Boolean);
  if (list.length === 0) return '按用户这次说的目标一步步操作，每步做完确认画面确有变化。';
  return list.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

/** 把一串要点整理成节（项目符号），空时给一句兜底。 */
function bullets(values, fallback) {
  const list = (Array.isArray(values) ? values : []).map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
  if (list.length === 0) return fallback;
  return list.map((line) => `- ${line}`).join('\n');
}

/** 从一段办成的任务（结构化）起草五节正文：供装配层把模型给出的步骤/坑/验收喂进来。 */
function draftFromTask(task = {}, opts = {}) {
  const sections = {
    入口: typeof task.entry === 'string' && task.entry.trim() ? task.entry.trim() : '从用户指定的 App / 网站开始；不确定用哪个就先问用户。',
    步骤: stepsSection(task.steps),
    容易出错的地方: bullets(task.pitfalls, '界面改版、弹窗、登录墙会让入口对不上；找不到就如实说，不要硬猜。'),
    怎样算办成: bullets(task.done, '用户看到预期的结果，且关键信息（名称、金额、对象）与确认时一致。'),
    什么时候停下交给用户: bullets(task.stop, '涉及付款、发送、删除、授权这些不可逆动作前停下，让用户确认。'),
  };
  return composeMarkdown({
    name: task.name,
    description: task.description,
    title: task.title,
    sections,
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 建一个技能库。
 *
 * @param {object} [options]
 * @param {string} [options.rootDir] 技能根，缺省 {@link skillsRoot}。
 * @param {string} [options.draftsFile] 草稿状态文件，缺省 {@link draftsStateFile}。
 * @param {() => number} [options.clock] 时钟。
 * @param {() => string} [options.ids] id 生成器。
 */
function createSkillStore(options = {}) {
  const root = options.rootDir || skillsRoot();
  const draftsFile = options.draftsFile || draftsStateFile();
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const makeId = typeof options.ids === 'function' ? options.ids : () => crypto.randomUUID();

  function skillDir(name) {
    return path.join(root, name);
  }

  // ── 草稿状态 ──────────────────────────────────────────────────────────────

  function readDrafts() {
    let raw;
    try {
      raw = fs.readFileSync(draftsFile, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return { version: 1, drafts: {} };
      throw new Error('drafts_unavailable');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('drafts_unavailable');
    }
    if (!parsed || typeof parsed !== 'object' || !isRecord(parsed.drafts)) throw new Error('drafts_unavailable');
    return parsed;
  }

  function writeDrafts(state) {
    fs.mkdirSync(path.dirname(draftsFile), { recursive: true });
    const payload = `${JSON.stringify({ version: 1, drafts: state.drafts }, null, 2)}\n`;
    const tmp = `${draftsFile}.${process.pid}.${clock()}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, draftsFile);
  }

  function summarize(draft) {
    return {
      id: draft.id,
      name: draft.name,
      status: draft.status,
      source: draft.source,
      untrusted: draft.untrusted === true,
      isUpdateOf: draft.isUpdateOf || null,
      createdAt: draft.createdAt,
      fileCount: Array.isArray(draft.files) ? draft.files.length : 0,
    };
  }

  // ── 附件校验与落盘 ────────────────────────────────────────────────────────

  function normalizeFiles(files) {
    if (files == null) return { ok: true, files: [] };
    if (!Array.isArray(files)) return { ok: false, problem: 'bad_files' };
    if (files.length > MAX_DRAFT_FILES) return { ok: false, problem: 'too_many_files' };
    const out = [];
    const seen = new Set();
    let total = 0;
    for (const file of files) {
      if (!isRecord(file) || !isSafeResourcePath(file.path)) return { ok: false, problem: 'bad_path' };
      const rel = file.path.trim();
      if (seen.has(rel)) return { ok: false, problem: 'duplicate_path' };
      seen.add(rel);
      const bytes = typeof file.content === 'string'
        ? Buffer.byteLength(file.content, 'utf8')
        : (typeof file.base64 === 'string' ? Math.floor((file.base64.length * 3) / 4) : 0);
      if (bytes > MAX_DRAFT_FILE_BYTES) return { ok: false, problem: 'file_too_large' };
      total += bytes;
      if (total > MAX_DRAFT_TOTAL_BYTES) return { ok: false, problem: 'package_too_large' };
      const entry = { path: rel, size: bytes, runnable: file.runnable === true, untrusted: file.untrusted === true };
      if (typeof file.content === 'string') entry.content = file.content;
      else if (typeof file.base64 === 'string') entry.base64 = file.base64;
      out.push(entry);
    }
    return { ok: true, files: out };
  }

  /** resolve 后必须仍在技能目录内；只写 references/ 或 scripts/ 下的相对路径。 */
  function resolveInside(dir, relPath) {
    const target = path.resolve(dir, relPath);
    const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
    if (!target.startsWith(prefix)) return null;
    return target;
  }

  function writeSkillDir(dir, markdown, files) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8');
    for (const file of files || []) {
      const target = resolveInside(dir, file.path);
      if (!target) throw new Error('bad_path');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (typeof file.content === 'string') fs.writeFileSync(target, file.content, 'utf8');
      else fs.writeFileSync(target, Buffer.from(file.base64 || '', 'base64'));
    }
  }

  // ── 草稿写入 ──────────────────────────────────────────────────────────────

  /**
   * 生成 / 收下一份待确认草稿。
   * input: `{ markdown }` 或 `{ name, description, title, sections }`；可选 `files`、`literals`、
   * `keepDigits`、`source`（`'imported'` 时来自外部）、`untrusted`、`isUpdateOf`、`toolNames`、
   * `scriptTool`、`runnableScripts`、`enforceRunnable`。
   * 返回 `{ ok:true, draft:<摘要> }` 或 `{ ok:false, problem }`。
   */
  function prepareDraft(input = {}) {
    let markdown;
    try {
      markdown = typeof input.markdown === 'string' ? input.markdown : composeMarkdown(input);
    } catch (err) {
      return { ok: false, problem: err.message || 'bad_draft' };
    }
    if (Array.isArray(input.literals) && input.literals.length > 0) markdown = redact(markdown, input.literals);
    if (input.keepDigits !== undefined) markdown = scrubNumbers(markdown, input.keepDigits);

    const problem = validateSkill(markdown, {
      toolNames: input.toolNames,
      scriptTool: input.scriptTool,
      runnableScripts: input.runnableScripts,
      enforceRunnable: input.enforceRunnable === true,
    });
    if (problem) return { ok: false, problem };

    const files = normalizeFiles(input.files);
    if (!files.ok) return { ok: false, problem: files.problem };

    const name = String(parseFrontMatter(markdown).meta.name || '').trim();
    const id = makeId();
    const draft = {
      id,
      name,
      markdown,
      files: files.files,
      status: 'pending',
      source: input.source === 'imported' ? 'imported' : 'drafted',
      untrusted: input.untrusted === true,
      isUpdateOf: typeof input.isUpdateOf === 'string' && input.isUpdateOf ? input.isUpdateOf : null,
      createdAt: clock(),
    };
    const state = readDrafts();
    state.drafts[id] = draft;
    writeDrafts(state);
    return { ok: true, draft: summarize(draft) };
  }

  function listDrafts() {
    const state = readDrafts();
    return Object.values(state.drafts).map(summarize).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function getDraft(id) {
    const state = readDrafts();
    const draft = state.drafts[String(id)];
    return draft ? { ...draft, files: Array.isArray(draft.files) ? draft.files.map((f) => ({ ...f })) : [] } : null;
  }

  function rejectDraft(id) {
    const state = readDrafts();
    const key = String(id);
    if (!state.drafts[key]) return false;
    delete state.drafts[key];
    writeDrafts(state);
    return true;
  }

  /**
   * 用户确认：把草稿落成真正的技能。
   * opts: `{ editedMarkdown?, name?, replace? }`。默认同名已有技能拒 `name_taken`，除非是它的
   * 更新草稿或显式 replace。
   * 返回 `{ ok:true, name, dir, files }` 或 `{ ok:false, problem }`。
   */
  function approveDraft(id, opts = {}) {
    const state = readDrafts();
    const draft = state.drafts[String(id)];
    if (!draft) return { ok: false, problem: 'not_found' };

    let markdown = typeof opts.editedMarkdown === 'string' ? opts.editedMarkdown : draft.markdown;
    const problem = validateSkill(markdown, { enforceRunnable: false });
    if (problem) return { ok: false, problem };
    if (sensitiveHit(markdown)) return { ok: false, problem: 'sensitive' };

    const meta = parseFrontMatter(markdown).meta;
    const name = String(opts.name != null && String(opts.name).trim() ? opts.name : meta.name).trim();
    if (!NAME_RE.test(name)) return { ok: false, problem: 'invalid_name' };
    markdown = withField(markdown, 'name', name);

    const dir = skillDir(name);
    const exists = fs.existsSync(dir);
    const isUpdate = draft.isUpdateOf === name || opts.replace === true;
    if (exists && !isUpdate) return { ok: false, problem: 'name_taken' };

    try {
      writeSkillDir(dir, markdown, draft.files);
    } catch (err) {
      return { ok: false, problem: err && err.message ? err.message : 'write_failed' };
    }
    delete state.drafts[String(id)];
    writeDrafts(state);
    return { ok: true, name, dir, files: (draft.files || []).map((f) => f.path) };
  }

  // ── 读取通道 ──────────────────────────────────────────────────────────────

  function listSkills() {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'SKILL.md');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      let meta = {};
      try {
        meta = parseFrontMatter(fs.readFileSync(file, 'utf8')).meta;
      } catch {
        // 读坏了就只报目录名。
      }
      out.push({
        name: typeof meta.name === 'string' && meta.name ? meta.name : entry.name,
        description: typeof meta.description === 'string' ? meta.description : '',
        dir: entry.name,
        nameMatchesDir: meta.name === entry.name,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function getSkillContent(name) {
    const skill = String(name == null ? '' : name).trim();
    if (!NAME_RE.test(skill)) return { ok: false, problem: 'invalid_name' };
    const file = path.join(skillDir(skill), 'SKILL.md');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return { ok: false, problem: 'not_found' };
    }
    if (!stat.isFile()) return { ok: false, problem: 'not_found' };
    if (stat.size > MAX_SKILL_BYTES) return { ok: false, problem: 'too_large' };
    try {
      return { ok: true, name: skill, content: fs.readFileSync(file, 'utf8') };
    } catch {
      return { ok: false, problem: 'unreadable' };
    }
  }

  function walkResources(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(...walkResources(abs, rel));
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        out.push({ path: rel, bytes: stat.size });
      }
    }
    return out;
  }

  function listResources(name) {
    const skill = String(name == null ? '' : name).trim();
    if (!NAME_RE.test(skill)) return { ok: false, problem: 'invalid_name' };
    const dir = skillDir(skill);
    try {
      if (!fs.statSync(path.join(dir, 'SKILL.md')).isFile()) return { ok: false, problem: 'not_found' };
    } catch {
      return { ok: false, problem: 'not_found' };
    }
    const resources = [
      ...walkResources(path.join(dir, 'references'), 'references'),
      ...walkResources(path.join(dir, 'scripts'), 'scripts'),
    ].sort((a, b) => a.path.localeCompare(b.path));
    return { ok: true, name: skill, resources };
  }

  function readResource(name, relPath) {
    const skill = String(name == null ? '' : name).trim();
    if (!NAME_RE.test(skill)) return { ok: false, problem: 'invalid_name' };
    if (!isSafeResourcePath(relPath)) return { ok: false, problem: 'bad_path' };
    const dir = skillDir(skill);
    const target = resolveInside(dir, relPath);
    if (!target) return { ok: false, problem: 'bad_path' };
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return { ok: false, problem: 'not_found' };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, problem: 'not_found' };
    if (stat.size > MAX_RESOURCE_BYTES) return { ok: false, problem: 'too_large' };
    try {
      return { ok: true, path: relPath.trim(), bytes: stat.size, text: fs.readFileSync(target, 'utf8') };
    } catch {
      return { ok: false, problem: 'unreadable' };
    }
  }

  return {
    root,
    draftsFile,
    skillDir,
    composeMarkdown,
    draftFromTask,
    redact,
    scrubNumbers,
    prepareDraft,
    listDrafts,
    getDraft,
    rejectDraft,
    approveDraft,
    listSkills,
    getSkillContent,
    listResources,
    readResource,
  };
}

module.exports = {
  MAX_SKILL_BYTES,
  MAX_RESOURCE_BYTES,
  MAX_DRAFT_FILES,
  MAX_DRAFT_FILE_BYTES,
  MAX_DRAFT_TOTAL_BYTES,
  PLACEHOLDER,
  skillsRoot,
  draftsStateFile,
  composeMarkdown,
  draftFromTask,
  redact,
  scrubNumbers,
  createSkillStore,
};
