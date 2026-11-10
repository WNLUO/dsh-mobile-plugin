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
 * 动作类别键 `classKey`（`<tool>:<class>`）既做「这一类以后都同意」的记账键，也做「同一轮
 * 重复请求」的比较键，两处必须用同一份，所以只在这里算一遍。
 *
 * 详见 docs/dev-map / decisions 里这条改动的原因。
 */

/** 整行事实的字符上限（中文按 1 计）。先保数量与动词，再保目标名。 */
const FACT_MAX = 40;
/** 目标清单最多列几个，超出写「等 N 个」。 */
const MAX_TARGETS = 3;
/** 一条事实最多几个分句。 */
const MAX_CLAUSES = 3;

/** 删除类程序：高亮。 */
const DELETE_PROGS = new Set(['rm', 'rmdir', 'unlink', 'shred']);
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

/** 相对 cwd 的第一段目录；超出 cwd / 取不到就 `abs`。 */
function dirKeyOf(p, cwd) {
  if (typeof p !== 'string' || !p) return 'abs';
  if (typeof cwd !== 'string' || !cwd) return 'abs';
  const norm = p.replace(/\\/g, '/');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
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

/** 按 `&&` `||` `;` `|` 换行切段，剥 sudo 与 VAR=val 前缀，返回每段的 token 数组。 */
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
    let tokens = seg.split(/\s+/).filter(Boolean);
    // 剥 sudo（可能带选项）
    while (tokens[0] === 'sudo') {
      tokens = tokens.slice(1);
      while (tokens.length && tokens[0].startsWith('-')) tokens = tokens.slice(1);
    }
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

  // 重定向写文件（段内出现 > 或 >>）
  const redirect = tokens.findIndex((t) => t === '>' || t === '>>');
  if (redirect >= 0 && tokens[redirect + 1]) {
    return { clause: `写 ${baseOf(tokens[redirect + 1])}`, highlight: false, prog };
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
  if (/^(bash:rm|bash:rmdir|bash:unlink|bash:shred)$/.test(classKey)) return 5;
  if (classKey === 'bash:git:push' || classKey === 'bash:git:reset' || classKey === 'bash:git:clean') return 5;
  if (INSTALL_MANAGERS.has((classKey.split(':')[1] || '').split(':')[0]) && /install|add|:i$/.test(classKey)) return 4;
  if (/^(write|edit):/.test(classKey)) return 3;
  if (/^read:/.test(classKey)) return 2;
  return 1;
}

/** 把 classKey 翻成给人看的一句（撤销页 / 按钮用）。 */
function labelOf(classKey) {
  const parts = String(classKey || '').split(':');
  const tool = parts[0];
  if (tool === 'bash') {
    if (parts[1] === 'git' && parts[2]) {
      const map = { push: 'git push', commit: 'git commit', reset: 'git reset', clean: 'git clean' };
      return `Bash · ${map[parts[2]] || `git ${parts[2]}`}`;
    }
    if (parts.length === 3) {
      return `Bash · ${parts[1]} ${parts[2] === 'add' || parts[2] === 'install' || parts[2] === 'i' ? '装包' : parts[2]}`;
    }
    const prog = parts[1] || '';
    if (DELETE_PROGS.has(prog)) return 'Bash · 删除文件';
    if (prog === 'curl' || prog === 'wget') return 'Bash · 联网请求';
    return `Bash · 运行 ${prog || '命令'}`;
  }
  if (tool === 'write' || tool === 'edit') return `改文件 · ${parts[1] || '未知目录'}`;
  if (tool === 'read') return `读文件 · ${parts[1] || '未知目录'}`;
  if (tool === 'web_fetch') return `联网 · ${parts[1] || '网页'}`;
  if (tool === 'tool') return `工具 · ${parts[1] || '未知'}`;
  return tool ? String(classKey) : '';
}

let opts = {};

/**
 * 主入口：`calls` = `{toolName, args}` 或它的数组；`options.cwd` 用于写/读文件的目录归类。
 * 返回 `{ fact, highlight, classKey, classLabel, rememberable }`。
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

  // classKey：多调用取最危险那条；单调用就是它自己。
  let classKey = pieces.length ? pieces[0].classKey : 'tool:unknown';
  for (const p of pieces) {
    if (dangerRank(p.classKey) > dangerRank(classKey)) classKey = p.classKey;
  }
  // 高亮是同一份解析给出的第二个信号：删除 / 推送 / reset / clean / 装包只在这几处点亮
  // （见 `clauseOfSegment`）。组合命令的类别键容易把危险那一段藏进 `a+b`，两条一起看才不漏。
  const rememberable = isRememberable(classKey) && !highlight;
  return {
    fact,
    highlight,
    classKey,
    classLabel: labelOf(classKey),
    rememberable,
  };
}

/**
 * 哪些动作类别**永远不许**被「这一类以后都同意」记住。
 *
 * 判据分两层，两层都只看原始请求折出来的东西（`deriveApprovalFacts` 的输入就是原始参数）：
 *  - **动作类别**（classKey）：删除类程序、`git push` / `git reset` / `git clean`、装包动词；
 *  - **高亮**（highlight）：上面这几类一旦被解析出来就会置高亮，多段命令（`cd x && rm -rf y`）
 *    的类别键是 `bash:cd+rm` 这种组合，单看类别字符串容易漏，高亮是同一份解析给出的第二个信号。
 *
 * 理由：`rm` 这个类别一旦被记住，任意 `rm`（包括 `rm -rf ~`）都变成静默放行 —— 这不是「同类」，
 * 只是「同名」。推送、装软件同理（推送会动远端，装包会执行第三方脚本）。这三类一律每次问，
 * 宁可多推一张卡。
 */
function isIrreversibleClass(classKey) {
  const key = String(classKey || '');
  if (!key) return false;
  // `git rm` 也是删文件（只是经过了 git），`git push/reset/clean` 会动远端或不可恢复。
  if (key === 'bash:git:push' || key === 'bash:git:reset' || key === 'bash:git:clean' || key === 'bash:git:rm') return true;
  if (!key.startsWith('bash:')) return false;
  // 组合键（`bash:cd+rm`）与单程序键（`bash:rm`）都拆成「程序[:动词]」逐段看。
  for (const part of key.slice('bash:'.length).split('+')) {
    const [prog, verb] = part.split(':');
    if (!prog) continue;
    if (DELETE_PROGS.has(prog)) return true;
    if (INSTALL_MANAGERS.has(prog) && PM_INSTALL[prog].has(String(verb || '').toLowerCase())) return true;
  }
  return false;
}

/**
 * 键退化到 `tool:<name>`（无区分度）时不给「以后都同意」；删除 / 推送 / 装软件这三类也不给
 * （见 `isIrreversibleClass`）；其余给。
 */
function isRememberable(classKey) {
  if (!classKey || classKey === 'tool:unknown') return false;
  if (classKey.startsWith('tool:')) return false;
  if (isIrreversibleClass(classKey)) return false;
  return true;
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
  labelOf,
  isRememberable,
  isIrreversibleClass,
  FACT_MAX,
};
