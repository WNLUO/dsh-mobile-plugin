'use strict';

/**
 * 审批卡「事实行」折算：把一次审批（工具名 + 原始参数）折成一句人话，外加高亮与动作类别。
 *
 * 纯展示、纯函数：输出只进审批卡的展示位，不进任何执行路径，不新增 shell / 文件写 / 系统设置
 * 能力。所有输入都是本来就存在的东西（会话日志里的 tool-call arguments），这里只读不写。
 *
 * 一句话分工：headline 是 agent 自己说的（reason / displayReason），事实行是电脑从原始参数
 * 算出来的；删除 / 推送 / 装软件高亮。算不出来就**不出这一行**，绝不糊一句会让用户误判的话。
 *
 * 动作类别键 `classKey`（`<tool>:<class>`）只用来判断「同一轮里相同请求再次出现」——比较的是
 * 类别 + 原始参数，避免同一轮把同一条命令问两遍。它是纯比较用的键，不做任何跨轮记忆。
 *
 * 只起包装作用的程序先剥掉（`WRAPPERS`），否则 `env` / `timeout` / `xargs` 会把真正干活的
 * 那条命令藏起来，同轮比较就会把不同命令当成同一条。
 */

/** 整行事实的字符上限（中文按 1 计）。先保数量与动词，再保目标名。 */
const FACT_MAX = 40;
/** 目标清单最多列几个，超出写「等 N 个」。 */
const MAX_TARGETS = 3;
/** 一条事实最多几个分句。 */
const MAX_CLAUSES = 3;

/** `apply_patch` 的路径要从补丁头里读，参数里没有单个 `file_path`。 */
const { patchFilePaths } = require('./patch-files.js');

/** 删除类程序：高亮。 */
const DELETE_PROGS = new Set(['rm', 'rmdir', 'unlink', 'shred']);
/**
 * 只是把后面那条命令包起来、自己不干活的程序：剥掉再判它包的是什么。
 *
 * 不剥的代价很实在：`env A=1 rm -rf x`、`timeout 60 rm -rf x`、`xargs rm -rf` 的类别键会落成
 * `bash:env` / `bash:timeout` / `bash:xargs`，于是「以后都同意 env」等于「以后任意命令静默放行」。
 */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'nice', 'stdbuf', 'command', 'exec', 'xargs', 'watch', 'time', 'timeout']);
/** 拿走了第一个参数、其后才是真正命令的那几个（`timeout 60 rm`、`nice -n 10 rm`）。 */
const WRAPPER_WITH_ARG = new Set(['timeout', 'nice', 'time']);
/** 包装器的这些选项自带取值：`sudo -u root rm` 里 `root` 是用户名，不是命令。 */
const OPTS_WITH_VALUE = new Set(['-u', '-g', '-n', '-p', '-C', '-S', '-I', '-L', '-P', '--signal', '--kill-after', '--user', '--group', '-s']);
/** 包管理器 → 装包动词集合。 */
const PM_INSTALL = {
  npm: new Set(['install', 'i', 'add']),
  pnpm: new Set(['install', 'i', 'add']),
  yarn: new Set(['install', 'add']),
  bun: new Set(['install', 'add']),
  pip: new Set(['install']),
  pip3: new Set(['install']),
  gem: new Set(['install']),
  cargo: new Set(['install']),
  apt: new Set(['install']),
  'apt-get': new Set(['install']),
  go: new Set(['install']),
};
const INSTALL_MANAGERS = new Set(Object.keys(PM_INSTALL));

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取路径末段（一行放不下整条路径）。 */
function baseOf(p) {
  if (typeof p !== 'string' || !p) return '';
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 相对 cwd 的第一段目录；超出 cwd / 取不到就 `abs`。相对路径按 cwd 拼出来再判。 */
function dirKeyOf(p, cwd) {
  if (typeof p !== 'string' || !p) return 'abs';
  if (typeof cwd !== 'string' || !cwd) return 'abs';
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  let norm = p.replace(/\\/g, '/');
  if (!/^[A-Za-z]:|^\//.test(norm) && !norm.startsWith('~')) norm = `${root}/${norm}`;
  if (!norm.startsWith(`${root}/`)) return 'abs';
  const rel = norm.slice(root.length + 1);
  const seg = rel.split('/')[0];
  return seg && seg !== '..' ? seg : 'abs';
}

/** 取文件路径（宿主两种写法都认）。 */
function pathOf(args) {
  if (!isRecord(args)) return '';
  if (typeof args.file_path === 'string' && args.file_path) return args.file_path;
  if (typeof args.path === 'string' && args.path) return args.path;
  return '';
}

/** 把一个目标清单收成「a、b 等 N 个」，最多 `MAX_TARGETS` 个。 */
function listTargets(names) {
  const clean = names.map((n) => String(n || '').trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length <= MAX_TARGETS) return clean.join('、');
  return `${clean.slice(0, MAX_TARGETS).join('、')} 等 ${clean.length} 个`;
}

/**
 * 剥掉只起包装作用的程序（`sudo` / `env` / `timeout 60` / `nohup` / `xargs` …），露出真正干活
 * 的那一条。剥不干净的代价见 `WRAPPERS` 的注释：类别键会落在包装器上，「以后都同意 env」等于
 * 「以后任意命令都静默放行」。认不出来的包装器一律不动，宁可少剥一层。
 */
function stripWrappers(tokens) {
  let out = tokens;
  for (let guard = 0; guard < 8; guard += 1) {
    if (out.length === 0) return out;
    const prog = baseOf(out[0]);
    if (!WRAPPERS.has(prog)) return out;
    let rest = out.slice(1);
    // 选项连同它的取值一起剥：`sudo -u root cmd`、`nice -n 10 cmd` 里那个词是参数不是命令。
    while (rest.length && rest[0].startsWith('-')) {
      const opt = rest[0];
      rest = rest.slice(1);
      if (OPTS_WITH_VALUE.has(opt) && rest.length) rest = rest.slice(1);
    }
    // `env A=1 cmd`：剥完 `env` 之后还压着一层赋值，继续剥掉。
    while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
    // `timeout 60 cmd` / `nice 10 cmd`：包装器自己吃掉一个参数，其后才是命令。
    if (WRAPPER_WITH_ARG.has(prog) && rest.length > 1 && /^[\d.]+[smhd]?$/.test(rest[0])) rest = rest.slice(1);
    out = rest;
  }
  return out;
}

/** 按 `&&` `||` `;` `|` 换行切段，剥包装器与 VAR=val 前缀，返回每段的 token 数组。 */
function splitSegments(command) {
  if (typeof command !== 'string') return [];
  // 先把 sh -c "…" / bash -c "…" 剥一层（常见且便宜）。
  let cmd = command;
  const shellWrap = cmd.match(/\b(?:sh|bash)\s+-c\s+(['"])([\s\S]*)\1/);
  if (shellWrap) cmd = shellWrap[2];
  const rawSegs = cmd.split(/\n|&&|\|\||;|\|/);
  const out = [];
  for (let seg of rawSegs) {
    seg = seg.trim();
    if (!seg) continue;
    // 剥段首赋值 VAR=value
    seg = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    const tokens = stripWrappers(seg.split(/\s+/).filter(Boolean));
    if (tokens.length === 0) continue;
    out.push(tokens);
  }
  return out;
}

/** 去掉首尾引号。 */
function unquote(s) {
  if (typeof s !== 'string') return '';
  const m = s.match(/^(['"])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

/** 从 URL 取 host，失败返回 ''。 */
function hostOf(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    return new URL(url).host || '';
  } catch {
    // 相对串（web_fetch 一般给绝对 URL）——退回按域名猜一下，不行就空。
    const m = url.match(/^[a-z]+:\/\/([^/]+)/i);
    return m ? m[1] : '';
  }
}

/** 解析一段 bash，返回 `{ clause, highlight, prog }`；cliches 里只给「一段」。 */
function clauseOfSegment(tokens) {
  const prog = baseOf(tokens[0] || '');
  if (!prog) return null;
  const rest = tokens.slice(1);
  const nonOpt = rest.filter((t) => !t.startsWith('-'));

  // git 子命令
  if (prog === 'git') {
    const sub = (rest.find((t) => !t.startsWith('-')) || '').toLowerCase();
    if (sub === 'commit') {
      const m = tokens.join(' ').match(/-m\s+(['"])([\s\S]*?)\1/);
      const msg = m ? m[2].slice(0, 20) : '';
      return { clause: msg ? `提交：${msg}` : '提交（git commit）', highlight: false, prog: 'git' };
    }
    if (sub === 'push') {
      const parts = nonOpt.slice(1); // 去掉 'push' 本身
      const target = parts.slice(0, 2).join('/');
      return { clause: target ? `推送 → ${target}` : '推送', highlight: true, prog: 'git' };
    }
    if (sub === 'reset' && rest.includes('--hard')) {
      return { clause: '丢弃未提交改动', highlight: true, prog: 'git' };
    }
    if (sub === 'clean' && rest.some((t) => /^-[a-z]*f/.test(t))) {
      return { clause: '删未跟踪文件', highlight: true, prog: 'git' };
    }
    return { clause: `跑 git ${sub}`.trim(), highlight: false, prog: 'git' };
  }

  // 删除类
  if (DELETE_PROGS.has(prog)) {
    const names = nonOpt.map(unquote);
    const list = listTargets(names);
    return { clause: list ? `删 ${list}` : '删文件', highlight: true, prog };
  }

  // 包管理器装包
  if (INSTALL_MANAGERS.has(prog)) {
    const verb = (nonOpt[0] || '').toLowerCase();
    if (PM_INSTALL[prog].has(verb)) {
      const pkg = nonOpt.slice(1).map(unquote).filter((p) => p && !p.startsWith('-')).join('、');
      return { clause: pkg ? `装 ${pkg}（${prog}）` : `装包（${prog}）`, highlight: true, prog };
    }
    return { clause: `跑 ${prog} ${verb}`.trim(), highlight: false, prog };
  }

  // 网络
  if (prog === 'curl' || prog === 'wget') {
    const urlTok = rest.find((t) => /^https?:\/\//i.test(t));
    const host = hostOf(urlTok || '');
    return { clause: host ? `连 ${host}` : `跑 ${prog}`, highlight: false, prog };
  }

  // 重定向写文件（段内出现 > 或 >>）。
  const redirect = tokens.findIndex((t) => t === '>' || t === '>>');
  if (redirect >= 0 && tokens[redirect + 1]) {
    const target = unquote(tokens[redirect + 1]);
    return { clause: `写 ${baseOf(target)}`, highlight: false, prog };
  }

  // 其它程序
  const first = nonOpt[0] !== undefined ? unquote(nonOpt[0]).replace(/^["']+|["']+$/g, '') : '';
  return { clause: first ? `跑 ${prog} ${first}`.trim() : `跑 ${prog}`, highlight: false, prog };
}

/** 单次 bash 调用的类别键（按程序 / git 子命令 / 包管理器子命令 / 程序组合）。 */
function bashClassKey(command) {
  const segs = splitSegments(command);
  if (segs.length === 0) return 'tool:bash';
  const progs = [];
  let gitSub = null;
  let pmVerb = null;
  for (const tokens of segs) {
    const prog = baseOf(tokens[0] || '');
    if (!prog) continue;
    if (prog === 'git') {
      const sub = (tokens.slice(1).find((t) => !t.startsWith('-')) || '').toLowerCase();
      if (sub) gitSub = sub;
    }
    if (INSTALL_MANAGERS.has(prog)) {
      const verb = (tokens.slice(1).find((t) => !t.startsWith('-')) || '').toLowerCase();
      if (verb) pmVerb = `${prog}:${verb}`;
    }
    if (!progs.includes(prog)) progs.push(prog);
  }
  if (progs.length === 0) return 'tool:bash';
  if (progs.length === 1 && progs[0] === 'git') return `bash:git:${gitSub || 'git'}`;
  if (progs.length === 1 && INSTALL_MANAGERS.has(progs[0]) && pmVerb) return `bash:${pmVerb}`;
  // 多段或普通程序：去重升序拼接
  return `bash:${progs.slice().sort().join('+')}`;
}

/** 判断一次调用是不是「解析不出」的壳（run_code / node -e "$(…)" 之类）。 */
function isOpaque(toolName, args) {
  if (toolName === 'run_code') return true;
  if (toolName === 'bash' && isRecord(args) && typeof args.command === 'string') {
    if (!/\$\(|`/.test(args.command)) return false;
    const tokens = args.command.split(/\s+/);
    const interp = tokens.some((t) => t === '-e' || t === '-c' || /^-[a-z]*[ec]$/.test(t));
    return interp;
  }
  return false;
}

/** 单次调用 → `{ clause, highlight, classKey }`。 */
function callToPiece(toolName, args) {
  const name = typeof toolName === 'string' ? toolName : '';
  if (name === 'bash') {
    if (!isRecord(args) || typeof args.command !== 'string' || !args.command.trim()) {
      return { clause: '', highlight: false, classKey: 'tool:bash' };
    }
    if (isOpaque(name, args)) {
      const segs = splitSegments(args.command);
      const prog = segs.length ? baseOf(segs[0][0] || '') : 'bash';
      return { clause: `跑 ${prog}（内容无法静态解析）`, highlight: false, classKey: `bash:${prog}` };
    }
    const segs = splitSegments(args.command);
    const clauses = [];
    let highlight = false;
    for (const tokens of segs) {
      const piece = clauseOfSegment(tokens);
      if (!piece) continue;
      if (piece.clause) clauses.push(piece.clause);
      if (piece.highlight) highlight = true;
    }
    return { clause: clauses.join('；'), highlight, classKey: bashClassKey(args.command) };
  }

  if (name === 'write' || name === 'edit') {
    const p = pathOf(args);
    if (!p) return { clause: '', highlight: false, classKey: `tool:${name}` };
    const d = dirKeyOf(p, opts.cwd);
    return { clause: `改 ${baseOf(p)}`, highlight: false, classKey: `${name}:${d}` };
  }

  if (name === 'apply_patch') {
    const paths = patchFilePaths(isRecord(args) ? args.input : '');
    if (paths.length === 0) return { clause: '', highlight: false, classKey: 'tool:apply_patch' };
    const head = baseOf(paths[0]);
    const d = dirKeyOf(paths[0], opts.cwd);
    const clause = paths.length === 1 ? `改 ${head}` : `改 ${head} 等 ${paths.length} 个文件`;
    return { clause, highlight: false, classKey: `apply_patch:${d}` };
  }

  if (name === 'read' || name === 'read_image') {
    const p = pathOf(args);
    if (!p) return { clause: '', highlight: false, classKey: `tool:${name}` };
    const d = dirKeyOf(p, opts.cwd);
    return { clause: `读 ${baseOf(p)}`, highlight: false, classKey: `read:${d}` };
  }

  if (name === 'web_fetch') {
    const url = isRecord(args) && typeof args.url === 'string' ? args.url : '';
    const host = hostOf(url);
    return { clause: host ? `连 ${host}` : '打开网页', highlight: false, classKey: host ? `web_fetch:${host}` : 'tool:web_fetch' };
  }

  if (name === 'web_search') {
    let q = '';
    if (isRecord(args)) {
      if (typeof args.query === 'string') q = args.query;
      else if (Array.isArray(args.queries) && typeof args.queries[0] === 'string') q = args.queries[0];
    }
    const short = q.slice(0, 20);
    return { clause: short ? `在网上搜 "${short}"` : '在网上搜', highlight: false, classKey: 'tool:web_search' };
  }

  // 未知工具
  return { clause: name ? `执行 ${name}` : '', highlight: false, classKey: name ? `tool:${name}` : 'tool:unknown' };
}

/** 危险度排序，用于多调用聚合时取「最危险那条」做 classKey。 */
function dangerRank(classKey) {
  const key = String(classKey || '');
  if (/^(bash:rm|bash:rmdir|bash:unlink|bash:shred)$/.test(key)) return 5;
  if (key === 'bash:git:push' || key === 'bash:git:reset' || key === 'bash:git:clean') return 5;
  if (INSTALL_MANAGERS.has((key.split(':')[1] || '').split(':')[0]) && /install|add|:i$/.test(key)) return 4;
  if (/^(write|edit):/.test(key)) return 3;
  if (/^read:/.test(key)) return 2;
  return 1;
}

let opts = {};

/**
 * 主入口：`calls` = `{toolName, args}` 或它的数组；`options.cwd` 用于写/读文件的目录归类。
 * 返回 `{ fact, highlight, classKey }`。
 */
function deriveApprovalFacts(calls, options) {
  opts = isRecord(options) ? options : {};
  const list = Array.isArray(calls) ? calls : [calls];
  const pieces = [];
  for (const call of list) {
    if (!isRecord(call)) continue;
    const piece = callToPiece(call.toolName, call.args);
    if (piece) pieces.push(piece);
  }
  const nonEmpty = pieces.filter((p) => p.clause);
  const joined = nonEmpty.map((p) => p.clause).slice(0, MAX_CLAUSES).join('；');
  const highlight = pieces.some((p) => p.highlight);
  let fact = joined;
  if (fact.length > FACT_MAX) {
    // 先保数量与动词、再保目标名：若带「等 N 个」，保住这段后缀，只截前面的目标清单。
    const m = fact.match(/^(.*?)(\s等\s\d+\s个)$/);
    if (m) {
      const suffix = m[2];
      const room = FACT_MAX - suffix.length - 1;
      fact = room > 0 ? `${m[1].slice(0, room)}…${suffix}` : suffix.trim();
    } else {
      fact = `${fact.slice(0, FACT_MAX - 1)}…`;
    }
  }

  // classKey：多调用取最危险那条；单调用就是它自己。只用于同轮重复比较。
  let classKey = pieces.length ? pieces[0].classKey : 'tool:unknown';
  for (const p of pieces) {
    if (dangerRank(p.classKey) > dangerRank(classKey)) classKey = p.classKey;
  }
  return { fact, highlight, classKey };
}

/** 归一化的关键参数摘要（同轮重复比较用；字符串直接比，不用哈希）。 */
function keyArgsOf(toolName, args) {
  if (!isRecord(args)) return '';
  try {
    if (toolName === 'bash' && typeof args.command === 'string') {
      return args.command.replace(/\s+/g, ' ').trim();
    }
    if ((toolName === 'write' || toolName === 'edit') && pathOf(args)) {
      const content = typeof args.content === 'string' ? args.content : '';
      const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
      const newStr = typeof args.new_string === 'string' ? args.new_string : '';
      const body = content.length > 65536
        ? `${content.length}\u0000${content.slice(0, 64)}\u0000${content.slice(-64)}`
        : content;
      return `${pathOf(args)}\u0000${body}\u0000${oldStr}\u0000${newStr}`;
    }
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

module.exports = {
  deriveApprovalFacts,
  keyArgsOf,
  FACT_MAX,
};
