'use strict';

/**
 * 手机端「技能编辑」的写侧 API：在技能目录里列表、读全文、新建、保存、删除（进回收站）。
 *
 * ## 边界（这是硬边界，不是待办）
 *
 * 所有落点都由「固定技能根 + 技能名」拼出来，**绝不接收调用方给的路径**：
 *  · 定位已有技能时，名字只要求「非空、≤64、不含 `/` 与 `\`、不是 `.` / `..`」（`validLookupName`），
 *    因为宿主认技能看的是目录里的 SKILL.md，目录名未必是 kebab；按 kebab 过滤会让
 *    「桌面菜单里有、手机列表里点了就报错」的技能出现；
 *  · 新建时名字必须是 kebab（`NAME_RE`），它同时是新目录名 —— 天然排掉 `/`、`.`、`..`；
 *  · 根只有两处固定值：工作区 `<projectRoot>/.dsh/skills` 与全局 `<dshHome>/skills`；
 *  · 回收站是另一个固定目录，绝不放技能根里（技能根可能指向工作区，塞删除物会污染仓库、
 *    还可能被宿主当技能扫出来）。
 * 换句话说：这条 API 只能改技能目录，改不了这台电脑上的任何其它文件。
 *
 * ## 为什么写「工作区 + 全局」两个根
 *
 * 宿主 `skills.list` 是按会话装配的：`<projectRoot>/.dsh/skills`（项目级，优先级 100）与
 * `<dshHome>/skills`（用户级，400），手机 /skills 菜单看到的就是这两处（外加只读的随附技能）。
 * 要让「手机上建的技能」立刻出现在菜单里，文件就必须落在这两个根之一 —— 不能落在插件自己的
 * `storages/mobile-plugin/skills`（宿主根本不扫那个路径，写进去是「保存成功但菜单没有」）。
 * 新建默认落工作区（只影响这个项目）；没有工作区时退回全局。
 *
 * ## revision / CAS
 *
 * 读全文回一份 `revision`（正文字节的 sha256 全 64 位 hex）。保存时带 `baseRevision`：
 * 与磁盘当前摘要不等 → 409 `revision-conflict`，回带 base / current / submitted 三份正文，
 * 由 App 让用户选保留哪一份。用内容摘要而不是 mtime：mtime 会因为 touch / 复制 / git
 * checkout 之类变了而内容没变，凭它判冲突会把用户无故拉进冲突页。不截短摘要：它决定
 * 「覆不覆盖」，撞了就是静默吃掉别人的修改，与缓存跳过那种撞了顶多漏刷一次不同。
 *
 * 读-比-写全同步（中间没有 await），单宿主进程内即串行，不引文件锁。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { dshHome } = require('../shared/paths');
const { cwdOf } = require('./session-cwd.js');
const { NAME_RE, parseFrontMatter, withField } = require('./skill-import.js');

/** 单份技能正文读取 / 写入上限（与 skill-store.js 同一档）。 */
const SKILL_MAX_BYTES = 256 * 1024;
/** 写请求体上限：正文上限 + JSON/字段开销。 */
const SKILL_BODY_MAX = 512 * 1024;
/** 技能说明展示上限（与 skills.js 一致）。 */
const SKILL_DESC_MAX = 400;
/** 回收站条目里记「原始技能根」的隐藏文件。 */
const ORIGIN_FILE = '.dsh-skill-origin';

/** 合法 scope 集。 */
const SCOPES = Object.freeze(['workspace', 'user']);

// ── 路径与根 ────────────────────────────────────────────────────────────────

/**
 * 从会话 cwd 往上找最近的 `.git` 祖先当作项目根（宿主 `findProjectRoot` 同口径）。
 * 找不到才退回 cwd 本身。不能直接拿 cwd 当根：cwd 常是仓库里的子目录，而宿主扫的是
 * 仓库根下的 `.dsh/skills`。
 */
function findProjectRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      // 读不了就当没有，继续往上。
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/** 回收站根：单独目录，缺省 `<dshHome>/storages/mobile-plugin/skill-trash`。 */
function trashRoot() {
  return process.env.DSH_MOBILE_SKILL_TRASH || path.join(dshHome(), 'storages', 'mobile-plugin', 'skill-trash');
}

/** 解析这一次请求的两个技能根；工作区缺 cwd 时给 null。 */
async function defaultRoots(ctx, sessionId) {
  const cwd = sessionId ? await cwdOf(ctx, sessionId) : '';
  const workspace = cwd && path.isAbsolute(cwd)
    ? path.join(findProjectRoot(cwd), '.dsh', 'skills')
    : null;
  return { workspace, user: path.join(dshHome(), 'skills') };
}

/** 根 → 绝对目录；scope 不合法或该根不可用回 null。 */
function rootOf(roots, scope) {
  if (scope === 'workspace') return roots && roots.workspace ? roots.workspace : null;
  if (scope === 'user') return roots && roots.user ? roots.user : null;
  return null;
}

/** 按 scope 决定尝试顺序；不带 scope 时工作区优先（与宿主 100 < 400 的优先级一致）。 */
function scopeOrder(roots, scope) {
  if (scope === 'workspace') return roots && roots.workspace ? ['workspace'] : [];
  if (scope === 'user') return ['user'];
  const out = [];
  if (roots && roots.workspace) out.push('workspace');
  out.push('user');
  return out;
}

/** 校验新建用的技能名（kebab，同时是目录名）。 */
function validName(raw) {
  if (typeof raw !== 'string') return '';
  const name = raw.trim();
  if (!name || name.length > 64) return '';
  return NAME_RE.test(name) ? name : '';
}

/**
 * 校验「定位已存在技能」用的名字：比 {@link validName} 宽松，只挡住路径穿越。
 * 宿主按目录里的 SKILL.md 认技能，目录名不必是 kebab；这里再按 kebab 过滤，
 * 就会出现「菜单里有、手机列表里点了报 invalid-name」的死行。
 */
function validLookupName(raw) {
  if (typeof raw !== 'string') return '';
  const name = raw.trim();
  if (!name || name.length > 64) return '';
  if (name.includes('/') || name.includes('\\')) return '';
  if (name === '.' || name === '..') return '';
  return name;
}

/** 校验 scope：缺省回 undefined（表示「自动」），非法回 null。 */
function validScope(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  const scope = raw.trim();
  if (!SCOPES.includes(scope)) return null;
  return scope;
}

/** 某技能在当前请求下的定位：{ root, scope, dir, file } 或 null。 */
function locate(roots, name, scope) {
  for (const s of scopeOrder(roots, scope)) {
    const root = rootOf(roots, s);
    if (!root) continue;
    const dir = path.join(root, name);
    const file = path.join(dir, 'SKILL.md');
    try {
      if (fs.statSync(file).isFile()) return { root, scope: s, dir, file };
    } catch {
      // 不在这个根，试下一个。
    }
  }
  return null;
}

/** 内容摘要（全 64 位 hex）。 */
function revisionOf(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 读一份技能正文并按摘要回 revision。 */
function readSkillFile(file) {
  const bytes = fs.readFileSync(file);
  return { content: bytes.toString('utf8'), bytes: bytes.length, revision: revisionOf(bytes), raw: bytes };
}

/** 原子写：同目录临时文件写完再 rename；任一步失败都清掉临时文件。 */
function writeAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw err;
  }
}

/**
 * 轻校验：能当技能被宿主列出来即可。要求 frontmatter + name + description，正文非空、不超限。
 * name 必须是 kebab：宿主按 frontmatter 的 name 认技能，非 kebab 会让技能静默从菜单消失。
 * 刻意**不**套 skill-import 的五节结构：那是自建草稿的格式约定，套上去会把用户已有的
 * 普通 SKILL.md 全部拒掉，编辑功能就没法用了。
 */
function lightProblem(content) {
  if (typeof content !== 'string' || !content.trim()) return 'invalid-content';
  if (Buffer.byteLength(content, 'utf8') > SKILL_MAX_BYTES) return 'too-large';
  const { hasFrontMatter, meta } = parseFrontMatter(content);
  if (!hasFrontMatter) return 'missing-frontmatter';
  const name = String(meta.name || '').trim();
  if (!name) return 'missing-name';
  if (!NAME_RE.test(name)) return 'bad-frontmatter-name';
  if (!String(meta.description || '').trim()) return 'missing-description';
  return null;
}

// ── 列表 / 读 ───────────────────────────────────────────────────────────────

/**
 * 列一个根下的技能（目录里有 SKILL.md 才算）。
 * 用 `statSync` 而不是 dirent 的 isDirectory：跟随符号链接目录，与宿主扫技能的口径一致，
 * 否则「桌面菜单里有、手机列表里没有」的技能就点不到了。
 */
function listRoot(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    let dirStat;
    try {
      dirStat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const file = path.join(dir, 'SKILL.md');
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
      // 读坏只报目录名。
    }
    const title = typeof meta.name === 'string' && meta.name ? meta.name : entry.name;
    const description = typeof meta.description === 'string' ? meta.description.trim() : '';
    out.push({
      name: entry.name,
      title,
      description: description.length > SKILL_DESC_MAX ? `${description.slice(0, SKILL_DESC_MAX)}…` : description,
      nameMatchesDir: title === entry.name,
      bytes: stat.size,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ── 回收站 ──────────────────────────────────────────────────────────────────

/** 回收站条目名：`<scope>__<name>__<epochMs>`（三段格式固定，靠它反解）。 */
function trashEntryName(scope, name, at) {
  return `${scope}__${name}__${at}`;
}

/**
 * 解析回收站条目名；不合形状回 null。
 * name 段不按 kebab 限：目录名不是 kebab 的技能也能删进来，条目必须还能列出来、还原回去。
 */
function parseTrashEntry(entry) {
  const m = /^(workspace|user)__(.+)__(\d+)$/.exec(String(entry || ''));
  if (!m) return null;
  const name = validLookupName(m[2]);
  if (!name || name !== m[2]) return null;
  return { scope: m[1], name, deletedAt: Number(m[3]) };
}

/**
 * 读条目里记的原始技能根。
 * 返回 { present, root, scope }：present=false 表示老条目没记过（回退按 scope 推算）；
 * root=null 表示记了但不可用（相对路径 / 指向回收站内部）。
 */
function readOrigin(source, trashBase) {
  let text;
  try {
    text = fs.readFileSync(path.join(source, ORIGIN_FILE), 'utf8');
  } catch {
    return { present: false, root: null, scope: null };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const rawRoot = parsed && typeof parsed.root === 'string' ? parsed.root.trim() : '';
  const scope = parsed && SCOPES.includes(parsed.scope) ? parsed.scope : null;
  if (!rawRoot || !path.isAbsolute(rawRoot)) return { present: true, root: null, scope };
  const resolved = path.resolve(rawRoot);
  const base = path.resolve(trashBase);
  if (resolved === base || resolved.startsWith(`${base}${path.sep}`)) {
    return { present: true, root: null, scope };
  }
  return { present: true, root: resolved, scope };
}

/** 把整个目录搬到目标（跨盘 EXDEV 时退回复制 + 删除）。 */
function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 造一组技能写 handler。
 *
 * @param {object} [options]
 * @param {(ctx: object, sessionId: string) => Promise<{workspace: ?string, user: string}>} [options.resolveRoots]
 *   根解析（测试注入用），缺省 {@link defaultRoots}。
 * @param {string} [options.trashDir] 回收站根（测试注入用），缺省 {@link trashRoot}。
 */
function createSkillWriteHandlers(options = {}) {
  const resolveRoots = typeof options.resolveRoots === 'function' ? options.resolveRoots : defaultRoots;
  // 回收站根：允许传字符串（测试注入固定目录）或函数（缺省按 env / dshHome 现算）。
  const trashDir = typeof options.trashDir === 'string'
    ? () => options.trashDir
    : (typeof options.trashDir === 'function' ? options.trashDir : trashRoot);

  function sendError(res, status, code, message, details) {
    sendJson(res, status, { ok: false, error: { code, message, ...(details ? { details } : {}) } });
  }

  /** 正文类问题：超限是 413（与读侧同口径），其余 400。 */
  function sendProblem(res, problem) {
    return sendError(res, problem === 'too-large' ? 413 : 400, problem, lightMessage(problem));
  }

  /** 读请求体；读不出来（坏 JSON / 超 512KB）回 null，由调用方回 400 invalid-body。 */
  async function readBody(req) {
    const raw = await readJsonBody(req, SKILL_BODY_MAX);
    if (raw === null) return null;
    return raw && typeof raw === 'object' ? raw : {};
  }

  /** GET /api/mobile/v1/skill/list?sessionId= */
  async function handleSkillList(ctx, req, res) {
    const url = new URL(req.url, 'http://x');
    const sessionId = (url.searchParams.get('sessionId') || '').trim();

    const roots = await resolveRoots(ctx, sessionId);
    const skills = [];
    for (const scope of scopeOrder(roots, undefined)) {
      const root = rootOf(roots, scope);
      if (!root) continue;
      for (const item of listRoot(root)) skills.push({ ...item, scope });
    }
    sendJson(res, 200, {
      ok: true,
      skills,
      roots: { workspace: !!roots.workspace, user: !!roots.user },
    });
  }

  /** GET /api/mobile/v1/skill/content?sessionId=&name=&scope= */
  async function handleSkillContent(ctx, req, res) {
    const url = new URL(req.url, 'http://x');
    const sessionId = (url.searchParams.get('sessionId') || '').trim();
    const name = validLookupName(url.searchParams.get('name'));
    const scope = validScope(url.searchParams.get('scope'));
    if (!name) return sendError(res, 400, 'invalid-name', '技能名不合法（不能为空、不能含 / 或 \\）');
    if (scope === null) return sendError(res, 400, 'invalid-scope', 'scope 只能是 workspace 或 user');

    const roots = await resolveRoots(ctx, sessionId);
    const hit = locate(roots, name, scope);
    if (!hit) return sendError(res, 404, 'not-found', '没有这个技能');

    let info;
    try {
      info = readSkillFile(hit.file);
    } catch {
      return sendError(res, 404, 'not-found', '没有这个技能');
    }
    if (info.bytes > SKILL_MAX_BYTES) return sendError(res, 413, 'too-large', '技能正文太大');
    sendJson(res, 200, {
      ok: true,
      name,
      scope: hit.scope,
      revision: info.revision,
      bytes: info.bytes,
      content: info.content,
    });
  }

  /** POST /api/mobile/v1/skill/create { sessionId, name, content, scope? } */
  async function handleSkillCreate(ctx, req, res) {
    const body = await readBody(req);
    if (!body) return sendError(res, 400, 'invalid-body', '请求体不合法或超过 512KB');
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const name = validName(body.name);
    const scope = validScope(body.scope);
    if (!name) return sendError(res, 400, 'invalid-name', '技能名不合法（小写字母、数字、连字符）');
    if (scope === null) return sendError(res, 400, 'invalid-scope', 'scope 只能是 workspace 或 user');
    const problem = lightProblem(body.content);
    if (problem) return sendProblem(res, problem);

    const roots = await resolveRoots(ctx, sessionId);
    const targetScope = scope || (roots.workspace ? 'workspace' : 'user');
    const root = rootOf(roots, targetScope);
    if (!root) return sendError(res, 400, 'scope-unavailable', '当前没有可写的工作区技能目录，请改用全局（user）');

    const dir = path.join(root, name);
    if (fs.existsSync(dir)) return sendError(res, 409, 'name-taken', '同名技能已经存在');

    // 正文里的 name 对齐成目录名：宿主按 frontmatter 的 name 认技能，不齐会出现
    // 「目录叫 a、菜单显示 /b、再建一个互相覆盖」。
    const content = withField(body.content, 'name', name);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return sendError(res, 502, 'write-failed', `写技能失败：${String((err && err.message) || err)}`);
    }
    try {
      writeAtomic(path.join(dir, 'SKILL.md'), content);
    } catch (err) {
      // 写失败就把刚建的目录收掉，别留下「没有 SKILL.md 却占着名字」的空目录
      // （否则同名再建永远 409，列表里又找不到它）。
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      return sendError(res, 502, 'write-failed', `写技能失败：${String((err && err.message) || err)}`);
    }
    const info = readSkillFile(path.join(dir, 'SKILL.md'));
    sendJson(res, 200, { ok: true, name, scope: targetScope, revision: info.revision, bytes: info.bytes });
  }

  /** POST /api/mobile/v1/skill/save { sessionId, name, scope?, content, baseRevision, baseContent? } */
  async function handleSkillSave(ctx, req, res) {
    const body = await readBody(req);
    if (!body) return sendError(res, 400, 'invalid-body', '请求体不合法或超过 512KB');
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const name = validLookupName(body.name);
    const scope = validScope(body.scope);
    const baseRevision = typeof body.baseRevision === 'string' ? body.baseRevision.trim() : '';
    if (!name) return sendError(res, 400, 'invalid-name', '技能名不合法（不能为空、不能含 / 或 \\）');
    if (scope === null) return sendError(res, 400, 'invalid-scope', 'scope 只能是 workspace 或 user');
    if (!baseRevision) return sendError(res, 400, 'missing-base', '缺少 baseRevision（打开时的版本）');
    const problem = lightProblem(body.content);
    if (problem) return sendProblem(res, problem);

    const roots = await resolveRoots(ctx, sessionId);
    const hit = locate(roots, name, scope);
    if (!hit) return sendError(res, 404, 'not-found', '这个技能已经不在了（可能被删了），请刷新列表');

    try {
      if (fs.lstatSync(hit.file).isSymbolicLink()) {
        return sendError(res, 400, 'symlink-refused', 'SKILL.md 是一个符号链接，不覆盖');
      }
    } catch {
      return sendError(res, 404, 'not-found', '这个技能已经不在了（可能被删了），请刷新列表');
    }

    let current;
    try {
      current = readSkillFile(hit.file);
    } catch {
      return sendError(res, 404, 'not-found', '这个技能已经不在了（可能被删了），请刷新列表');
    }

    if (current.revision !== baseRevision) {
      const submitted = typeof body.content === 'string' ? body.content : '';
      return sendJson(res, 409, {
        ok: false,
        error: {
          code: 'revision-conflict',
          message: '这个技能在你打开之后被改过，请选择保留哪一版',
          details: {
            name,
            scope: hit.scope,
            baseRevision,
            currentRevision: current.revision,
            base: {
              revision: baseRevision,
              content: typeof body.baseContent === 'string' ? body.baseContent : null,
            },
            current: { revision: current.revision, content: current.content },
            submitted: { revision: revisionOf(Buffer.from(submitted, 'utf8')), content: submitted },
          },
        },
      });
    }

    try {
      writeAtomic(hit.file, body.content);
    } catch (err) {
      return sendError(res, 502, 'write-failed', `写技能失败：${String((err && err.message) || err)}`);
    }
    const fresh = readSkillFile(hit.file);
    sendJson(res, 200, { ok: true, name, scope: hit.scope, revision: fresh.revision, bytes: fresh.bytes });
  }

  /** POST /api/mobile/v1/skill/delete { sessionId, name, scope?, baseRevision? } */
  async function handleSkillDelete(ctx, req, res) {
    const body = await readBody(req);
    if (!body) return sendError(res, 400, 'invalid-body', '请求体不合法或超过 512KB');
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const name = validLookupName(body.name);
    const scope = validScope(body.scope);
    const baseRevision = typeof body.baseRevision === 'string' ? body.baseRevision.trim() : '';
    if (!name) return sendError(res, 400, 'invalid-name', '技能名不合法（不能为空、不能含 / 或 \\）');
    if (scope === null) return sendError(res, 400, 'invalid-scope', 'scope 只能是 workspace 或 user');

    const roots = await resolveRoots(ctx, sessionId);
    const hit = locate(roots, name, scope);
    if (!hit) return sendError(res, 404, 'not-found', '这个技能已经不在了');

    try {
      if (fs.lstatSync(hit.dir).isSymbolicLink()) {
        return sendError(res, 400, 'symlink-refused', '这是一个符号链接，不删除');
      }
    } catch {
      return sendError(res, 404, 'not-found', '这个技能已经不在了');
    }

    if (baseRevision) {
      let current;
      try {
        current = readSkillFile(hit.file);
      } catch {
        return sendError(res, 404, 'not-found', '这个技能已经不在了');
      }
      if (current.revision !== baseRevision) {
        return sendJson(res, 409, {
          ok: false,
          error: {
            code: 'revision-conflict',
            message: '这个技能在你打开之后被改过，请重启一遍再删',
            details: { name, scope: hit.scope, baseRevision, currentRevision: current.revision },
          },
        });
      }
    }

    const base = trashDir();
    // 撞名时把时间戳往 +1ms 挪，保持 `<scope>__<name>__<epochMs>` 三段格式不变：
    // 往后面接随机后缀会让 parseTrashEntry 解不出来，那条既列不出也永远还原不了。
    let at = Date.now();
    let entry = trashEntryName(hit.scope, name, at);
    while (fs.existsSync(path.join(base, entry))) {
      at += 1;
      entry = trashEntryName(hit.scope, name, at);
    }
    const dest = path.join(base, entry);
    try {
      moveDir(hit.dir, dest);
    } catch (err) {
      return sendError(res, 502, 'delete-failed', `删除技能失败：${String((err && err.message) || err)}`);
    }
    // 记下这次定位到的技能根：带会话的客户端换个项目还原时，按 scope 推算会落到别人的项目里。
    try {
      fs.writeFileSync(
        path.join(dest, ORIGIN_FILE),
        JSON.stringify({ root: path.resolve(hit.root), scope: hit.scope }),
        'utf8',
      );
    } catch {
      // 记不下不影响删除本身：还原退回按 scope 推算。
    }
    sendJson(res, 200, { ok: true, name, scope: hit.scope, trashed: true, entry });
  }

  /** GET /api/mobile/v1/skill/trash */
  async function handleSkillTrash(ctx, req, res) {
    const url = new URL(req.url, 'http://x');
    const sessionId = (url.searchParams.get('sessionId') || '').trim();

    const base = trashDir();
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return sendJson(res, 200, { ok: true, items: [] });
    }
    const items = [];
    for (const dir of entries) {
      if (!dir.isDirectory()) continue;
      const parsed = parseTrashEntry(dir.name);
      if (!parsed) continue;
      let revision = '';
      let title = parsed.name;
      try {
        const info = readSkillFile(path.join(base, dir.name, 'SKILL.md'));
        revision = info.revision;
        const meta = parseFrontMatter(info.content).meta;
        if (typeof meta.name === 'string' && meta.name) title = meta.name;
      } catch {
        // 回收站里的坏条目照列，revision 留空。
      }
      items.push({ entry: dir.name, name: parsed.name, title, scope: parsed.scope, deletedAt: parsed.deletedAt, revision });
    }
    items.sort((a, b) => b.deletedAt - a.deletedAt);
    sendJson(res, 200, { ok: true, items });
  }

  /** POST /api/mobile/v1/skill/trash/restore { sessionId, entry } */
  async function handleSkillTrashRestore(ctx, req, res) {
    const body = await readBody(req);
    if (!body) return sendError(res, 400, 'invalid-body', '请求体不合法或超过 512KB');
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const entry = typeof body.entry === 'string' ? body.entry.trim() : '';
    const parsed = parseTrashEntry(entry);
    if (!parsed) return sendError(res, 400, 'invalid-entry', '回收站条目名不合法');

    const base = trashDir();
    const source = path.join(base, entry);
    try {
      if (!fs.statSync(source).isDirectory()) return sendError(res, 404, 'not-found', '回收站里没有这一条');
    } catch {
      return sendError(res, 404, 'not-found', '回收站里没有这一条');
    }

    const origin = readOrigin(source, base);
    let root;
    let scope;
    if (origin.present) {
      if (!origin.root) return sendError(res, 400, 'scope-unavailable', '这个条目记的技能目录现在不可用');
      root = origin.root;
      scope = origin.scope || parsed.scope;
    } else {
      const roots = await resolveRoots(ctx, sessionId);
      root = rootOf(roots, parsed.scope);
      scope = parsed.scope;
      if (!root) return sendError(res, 400, 'scope-unavailable', '这个条目原来的技能目录现在不可用');
    }

    const target = path.join(root, parsed.name);
    if (fs.existsSync(target)) return sendError(res, 409, 'name-taken', '原位置已经有同名技能了，先处理它再还原');

    try {
      moveDir(source, target);
    } catch (err) {
      return sendError(res, 502, 'restore-failed', `还原技能失败：${String((err && err.message) || err)}`);
    }
    // 回收站专用的标记不跟回技能目录。
    try { fs.rmSync(path.join(target, ORIGIN_FILE), { force: true }); } catch { /* 忽略 */ }
    sendJson(res, 200, { ok: true, name: parsed.name, scope, restored: true });
  }

  return {
    handleSkillList,
    handleSkillContent,
    handleSkillCreate,
    handleSkillSave,
    handleSkillDelete,
    handleSkillTrash,
    handleSkillTrashRestore,
  };
}

/** 轻校验失败码 → 中文。 */
function lightMessage(problem) {
  switch (problem) {
    case 'invalid-content': return '技能正文不能为空';
    case 'too-large': return '技能正文太大（上限 256KB）';
    case 'missing-frontmatter': return '技能正文缺少 frontmatter（--- name / description ---）';
    case 'missing-name': return 'frontmatter 里缺少 name';
    case 'bad-frontmatter-name': return 'frontmatter 的 name 只能用小写字母、数字和连字符';
    case 'missing-description': return 'frontmatter 里缺少 description';
    default: return '技能正文不合法';
  }
}

const defaultHandlers = createSkillWriteHandlers();

module.exports = {
  SKILL_MAX_BYTES,
  SKILL_BODY_MAX,
  SCOPES,
  findProjectRoot,
  trashRoot,
  defaultRoots,
  validName,
  validLookupName,
  validScope,
  lightProblem,
  parseTrashEntry,
  lightMessage,
  createSkillWriteHandlers,
  ...defaultHandlers,
};
