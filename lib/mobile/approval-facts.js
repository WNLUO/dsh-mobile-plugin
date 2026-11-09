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
 * 动作类别键 `classKey`（`<tool>:<class>@<tier>`）既做「这一类以后都同意」的记账键，也做「同一轮
 * 重复请求」的比较键，两处必须用同一份，所以只在这里算一遍。档位后缀（`workspace-write` /
 * `danger-full-access` / `unknown`）由主入口统一拼上：同一个动作在不同沙箱档位下是**不同的键**，
 * 工作区内记住的「以后都同意」不该顺带放行完全访问的那一次。
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
  npm: new Set(['install', 'i', 'add', 'ci']),
  pnpm: new Set(['install', 'i', 'add', 'dlx']),
  yarn: new Set(['install', 'add']),
  bun: new Set(['install', 'add']),
  pip: new Set(['install']),
  pip3: new Set(['install']),
  gem: new Set(['install']),
  cargo: new Set(['install']),
  apt: new Set(['install']),
  'apt-get': new Set(['install']),
  go: new Set(['install']),
  brew: new Set(['install']),
  uv: new Set(['install', 'add']),
};
const INSTALL_MANAGERS = new Set(Object.keys(PM_INSTALL));
/** 不带子命令、只要出现就是「下载并运行第三方代码」的程序（`npx x` / `uvx x`）。 */
const IMPLICIT_INSTALL = new Set(['npx', 'uvx']);

/** 解释器 / 套壳程序：命令内容在参数里，静态解析不到真正干了什么，一律不给「以后都同意」。 */
const INTERPRETERS = new Set([
  'node', 'nodejs', 'deno', 'bun', 'ts-node', 'tsx',
  'python', 'python2', 'python3', 'ruby', 'perl', 'php', 'lua', 'Rscript',
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'eval', 'source', 'run_code',
]);

/** 段首可剥的包装程序。 */
const WRAPPERS = new Set(['env', 'sudo', 'time', 'nice', 'nohup', 'command', 'exec', 'stdbuf']);
/** 这些 shell 的 `-c` 后面才是真正的命令。 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
/** sudo 里需要吞掉后一个 token 的选项。 */
const SUDO_ARG_OPTS = new Set([
  '-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-T', '-D',
  '--user', '--group', '--host', '--prompt', '--chdir', '--close-from', '--other-user',
  '--role', '--type', '--command-timeout',
]);
/** xargs 里需要吞掉后一个 token 的选项。 */
const XARGS_ARG_OPTS = new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '-e', '-l']);

/** 沙箱档位后缀 → 中文尾巴（unknown 不带后缀）。 */
const TIER_SUFFIX = {
  'workspace-write': '（工作区内）',
  'danger-full-access': '（完全访问）',
};
const TIERS = new Set(['workspace-write', 'danger-full-access', 'unknown']);

/** 手机类工具：动作名 → 事实行用的一句。classKey 是 `phone:<action>`（动作名取工具名后缀）。 */
const PHONE_TOOLS = {
  phone_open_app: { action: 'open_app', label: '打开应用' },
  phone_open_link: { action: 'open_link', label: '打开链接' },
  phone_tap: { action: 'tap', label: '在手机上点按' },
  phone_gesture: { action: 'gesture', label: '在手机上滑动/长按' },
  phone_type: { action: 'type', label: '在手机上输入文字' },
  phone_key: { action: 'key', label: '按手机系统键' },
  phone_set_alarm: { action: 'set_alarm', label: '设置闹钟' },
  phone_set_timer: { action: 'set_timer', label: '设置计时器' },
  phone_show_alarms: { action: 'show_alarms', label: '查看闹钟' },
  phone_share_text: { action: 'share_text', label: '分享文字' },
  phone_add_calendar_event: { action: 'add_calendar_event', label: '新建日历事件' },
  phone_screenshot: { action: 'screenshot', label: '操作手机界面' },
  phone_screen: { action: 'screen', label: '操作手机界面' },
  phone_scroll: { action: 'scroll', label: '操作手机界面' },
  phone_scroll_to: { action: 'scroll_to', label: '操作手机界面' },
  phone_find: { action: 'find', label: '操作手机界面' },
  phone_query: { action: 'query', label: '操作手机界面' },
  phone_extract: { action: 'extract', label: '操作手机界面' },
  phone_collect: { action: 'collect', label: '操作手机界面' },
  phone_wait: { action: 'wait', label: '操作手机界面' },
  phone_wheel: { action: 'wheel', label: '操作手机界面' },
  phone_steps: { action: 'steps', label: '操作手机界面' },
  phone_route_hint: { action: 'route_hint', label: '操作手机界面' },
  phone_target: { action: 'target', label: '切换手机' },
  phone_app_after_task: { action: 'app_after_task', label: '收尾手机应用' },
};

/** 手机类里只有这两个「打开某个具体东西」的够具体，可以记。 */
const PHONE_REMEMBERABLE = /^phone:(?:open_app|open_link):.+/;

/** 终端类工具名。 */
const TERMINAL_TOOLS = new Set(['terminal_send', 'terminal', 'pwsh', 'powershell']);

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

/** 相对 cwd 的第一段目录；相对路径先拼 cwd；超出 cwd / 取不到就 `abs`。 */
function dirKeyOf(p, cwd) {
  if (typeof p !== 'string' || !p) return 'abs';
  if (typeof cwd !== 'string' || !cwd) return 'abs';
  let norm = p.replace(/\\/g, '/');
  if (norm.startsWith('~')) return 'abs';
  while (norm.startsWith('./')) norm = norm.slice(2);
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const full = norm.startsWith('/') ? norm : `${root}/${norm}`;
  if (!full.startsWith(`${root}/`)) return 'abs';
  const rel = full.slice(root.length + 1);
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

/** 取命令字符串（`bash` 只认 command；终端类工具两种写法都认）。 */
function commandOf(args, allowCmd) {
  if (!isRecord(args)) return '';
  if (typeof args.command === 'string' && args.command.trim()) return args.command;
  if (allowCmd && typeof args.cmd === 'string' && args.cmd.trim()) return args.cmd;
  return '';
}

/** 把一个目标清单收成「a、b 等 N 个」，最多 `MAX_TARGETS` 个。 */
function listTargets(names) {
  const clean = names.map((n) => String(n || '').trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length <= MAX_TARGETS) return clean.join('、');
  return `${clean.slice(0, MAX_TARGETS).join('、')} 等 ${clean.length} 个`;
}

/** 去掉首尾引号。 */
function unquote(s) {
  if (typeof s !== 'string') return '';
  const m = s.match(/^(['"])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

/** 按顶层 `&&` `||` `;` `|` 换行切段（引号内、转义后的分隔符不切）。 */
function splitTopLevel(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      // `\;`（find -exec 的结尾）不许被当成段分隔符。
      cur += ch + cmd[i + 1];
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      out.push(cur);
      cur = '';
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === '|' && cmd[i + 1] === '|') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === '|') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 引号感知分词：引号里的空格不切；token 原样保留引号（展示与 `-m "…"` 提取都靠它）。 */
function tokenize(seg) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < seg.length) {
        cur += seg[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < seg.length) {
      cur += ch + seg[i + 1];
      i += 1;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** 剥段首的 `VAR=value` 赋值。 */
function stripLeadingAssignments(tokens) {
  let toks = tokens;
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
  return toks;
}

/** 剥包装程序（env / sudo / time / nice / nohup / command / exec / stdbuf）。 */
function stripWrappers(tokens) {
  let toks = tokens.slice();
  for (let guard = 0; guard < 8; guard += 1) {
    if (toks.length === 0) break;
    const prog = baseOf(toks[0]);
    if (!WRAPPERS.has(prog)) break;
    toks = toks.slice(1);
    if (prog === 'env') {
      while (toks.length) {
        const t = toks[0];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
          toks = toks.slice(1);
          continue;
        }
        if (t === '-u' || t === '--unset') {
          toks = toks.slice(2);
          continue;
        }
        if (t === '--') {
          toks = toks.slice(1);
          continue;
        }
        if (t.startsWith('-') && t.length > 1) {
          toks = toks.slice(1);
          continue;
        }
        break;
      }
      continue;
    }
    if (prog === 'sudo') {
      while (toks.length) {
        const t = toks[0];
        if (t === '--') {
          toks = toks.slice(1);
          break;
        }
        if (SUDO_ARG_OPTS.has(t)) {
          toks = toks.slice(2);
          continue;
        }
        if (t.startsWith('-') && t.length > 1) {
          toks = toks.slice(1);
          continue;
        }
        break;
      }
      continue;
    }
    if (prog === 'nice') {
      while (toks.length && toks[0] === '-n') toks = toks.slice(2);
      while (toks.length && toks[0] === '--adjustment') toks = toks.slice(2);
      while (toks.length && /^-\d+$/.test(toks[0])) toks = toks.slice(1);
      continue;
    }
    if (prog === 'stdbuf') {
      while (toks.length && /^-[ioe]/.test(toks[0])) toks = toks.slice(1);
      continue;
    }
    if (prog === 'exec') {
      if (toks[0] === '-a' && toks.length > 1) toks = toks.slice(2);
      while (toks.length && toks[0].startsWith('-') && toks[0] !== '-') toks = toks.slice(1);
      continue;
    }
    // time / nohup / command：只剥自己的选项。
    while (toks.length && toks[0].startsWith('-') && toks[0] !== '-') {
      if (prog === 'time' && (toks[0] === '-f' || toks[0] === '-o')) {
        toks = toks.slice(2);
        continue;
      }
      toks = toks.slice(1);
    }
  }
  return toks;
}

/** 把等价的装包写法归一：`python3 -m pip …` → `pip …`，`uv pip|tool …` → `uv …`。 */
function normalizeInstallAliases(tokens) {
  if (tokens.length === 0) return tokens;
  const prog = baseOf(tokens[0]);
  if (/^python[0-9.]*$/.test(prog) && tokens[1] === '-m' && /^pip[0-9.]*$/.test(baseOf(tokens[2] || ''))) {
    return ['pip', ...tokens.slice(3)];
  }
  if (prog === 'uv' && (tokens[1] === 'pip' || tokens[1] === 'tool')) {
    return ['uv', ...tokens.slice(2)];
  }
  return tokens;
}

/** `find … -exec <cmd> …` 取内层程序（没有 -exec 返回 null）。 */
function innerOfFind(tokens) {
  if (baseOf(tokens[0] || '') !== 'find') return null;
  const idx = tokens.findIndex((t) => t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir');
  if (idx < 0) return null;
  const inner = tokens.slice(idx + 1).filter((t) => t !== ';' && t !== '\\;' && t !== '+' && t !== '{}');
  return inner.length ? inner : null;
}

/** `xargs <cmd>` 取内层命令。 */
function innerOfXargs(tokens) {
  if (baseOf(tokens[0] || '') !== 'xargs') return tokens;
  let toks = tokens.slice(1);
  while (toks.length) {
    const t = toks[0];
    if (XARGS_ARG_OPTS.has(t)) {
      toks = toks.slice(2);
      continue;
    }
    if (t === '--') {
      toks = toks.slice(1);
      break;
    }
    if (t.startsWith('-') && t.length > 1) {
      toks = toks.slice(1);
      continue;
    }
    break;
  }
  return toks.length ? toks : tokens;
}

/** 一段原始文本 → 若干「有效命令」token 数组（剥包装、剥一层 shell -c、解 find/xargs）。 */
function expandSegment(seg, depth) {
  let tokens = stripLeadingAssignments(tokenize(seg));
  tokens = stripWrappers(tokens);
  if (tokens.length === 0) return [];
  const prog = baseOf(tokens[0]);
  if (depth > 0 && SHELLS.has(prog)) {
    const idx = tokens.findIndex((t, i) => i > 0 && /^-[A-Za-z]*c$/.test(t));
    if (idx > 0 && tokens[idx + 1]) {
      const inner = unquote(tokens.slice(idx + 1).join(' ').trim());
      return segmentsOf(inner, depth - 1);
    }
  }
  tokens = normalizeInstallAliases(tokens);
  const findInner = innerOfFind(tokens);
  if (findInner) return [findInner];
  return [innerOfXargs(tokens)];
}

function segmentsOf(command, depth) {
  if (typeof command !== 'string') return [];
  const out = [];
  for (const raw of splitTopLevel(command)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    for (const tokens of expandSegment(trimmed, depth)) {
      if (tokens.length) out.push(tokens);
    }
  }
  return out;
}

/** 按 `&&` `||` `;` `|` 换行切段，剥包装，返回每段的有效 token 数组。 */
function splitSegments(command) {
  return segmentsOf(command, 1);
}

/** git 的全局选项（`-C dir` / `-c k=v` / `--git-dir=` / `--work-tree=`）跳过后取子命令。 */
function gitInfo(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--exec-path') {
      i += 2;
      continue;
    }
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=') || t.startsWith('--namespace=') || t.startsWith('--exec-path=')) {
      i += 1;
      continue;
    }
    if (/^-[Cc]./.test(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) {
      i += 1;
      continue;
    }
    break;
  }
  const sub = i < tokens.length ? String(tokens[i]).toLowerCase() : '';
  return { sub, rest: tokens.slice(i + 1) };
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

  // git 子命令（先跳过全局选项）
  if (prog === 'git') {
    const info = gitInfo(tokens);
    const sub = info.sub;
    const subRest = info.rest;
    const subNonOpt = subRest.filter((t) => !t.startsWith('-'));
    if (sub === 'commit') {
      const m = tokens.join(' ').match(/-m\s+(['"])([\s\S]*?)\1/);
      const msg = m ? m[2].slice(0, 20) : '';
      return { clause: msg ? `提交：${msg}` : '提交（git commit）', highlight: false, prog: 'git' };
    }
    if (sub === 'push') {
      const target = subNonOpt.slice(0, 2).join('/');
      return { clause: target ? `推送 → ${target}` : '推送', highlight: true, prog: 'git' };
    }
    if (sub === 'reset' && subRest.includes('--hard')) {
      return { clause: '丢弃未提交改动', highlight: true, prog: 'git' };
    }
    if (sub === 'rm') {
      const names = subNonOpt.map(unquote);
      const list = listTargets(names);
      return { clause: list ? `删 ${list}（git rm）` : '删文件（git rm）', highlight: true, prog: 'git' };
    }
    if (sub === 'clean' && subRest.some((t) => /^-[a-z]*f/.test(t))) {
      return { clause: '删未跟踪文件', highlight: true, prog: 'git' };
    }
    return { clause: `跑 git ${sub}`.trim(), highlight: false, prog: 'git' };
  }

  // 删除类
  if (DELETE_PROGS.has(prog)) {
    const names = nonOpt.map(unquote).filter((n) => n !== '{}');
    const list = listTargets(names);
    return { clause: list ? `删 ${list}` : '删文件', highlight: true, prog };
  }

  // npx / uvx：出现即下载并运行第三方代码
  if (IMPLICIT_INSTALL.has(prog)) {
    const pkg = nonOpt.length ? unquote(nonOpt[0]) : '';
    return { clause: pkg ? `装 ${pkg}（${prog}）` : `跑 ${prog}`, highlight: true, prog };
  }

  // 包管理器装包
  if (INSTALL_MANAGERS.has(prog)) {
    const verb = (nonOpt[0] || '').toLowerCase();
    if (PM_INSTALL[prog].has(verb)) {
      // `pnpm dlx <pkg> …` 只有第一个是包，后面是它自己的参数。
      const pkgs = verb === 'dlx' ? nonOpt.slice(1, 2) : nonOpt.slice(1);
      const pkg = pkgs.map(unquote).filter((p) => p && !p.startsWith('-')).join('、');
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
      const sub = gitInfo(tokens).sub;
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

/** 命令里带 `$(…)` / 反引号 + `-e`/`-c`：内容静态解析不出来。 */
function isOpaqueCommand(command) {
  if (typeof command !== 'string' || !command) return false;
  if (!/\$\(|`/.test(command)) return false;
  const tokens = command.split(/\s+/);
  return tokens.some((t) => t === '-e' || t === '-c' || /^-[a-z]*[ec]$/.test(t));
}

/** 一段命令 → `{ clause, highlight, classKey }`。 */
function bashPiece(command) {
  if (isOpaqueCommand(command)) {
    const segs = splitSegments(command);
    const prog = segs.length ? baseOf(segs[0][0] || '') : 'bash';
    return { clause: `跑 ${prog}（内容无法静态解析）`, highlight: false, classKey: `bash:${prog}` };
  }
  const segs = splitSegments(command);
  const clauses = [];
  let highlight = false;
  for (const tokens of segs) {
    const piece = clauseOfSegment(tokens);
    if (!piece) continue;
    if (piece.clause) clauses.push(piece.clause);
    if (piece.highlight) highlight = true;
  }
  return { clause: clauses.join('；'), highlight, classKey: bashClassKey(command) };
}

/** 写 / 改 / 读的目录归类（相对路径先拼 cwd，越出 cwd 归 `abs`）。 */
function filePiece(toolName, cls, args, ctx, verb) {
  const p = pathOf(args);
  if (!p) return { clause: '', highlight: false, classKey: `tool:${toolName}` };
  const d = dirKeyOf(p, ctx.cwd);
  return { clause: `${verb} ${baseOf(p)}`, highlight: false, classKey: `${cls}:${d}` };
}

/** 单次调用 → `{ clause, highlight, classKey }`（classKey 不带档位后缀）。 */
function callToPiece(toolName, args, ctx) {
  const name = typeof toolName === 'string' ? toolName : '';

  if (name === 'bash') {
    const command = commandOf(args);
    if (!command) return { clause: '', highlight: false, classKey: 'tool:bash' };
    return bashPiece(command);
  }

  if (TERMINAL_TOOLS.has(name)) {
    const command = commandOf(args, true);
    if (!command) return { clause: '在终端执行命令', highlight: false, classKey: `tool:${name}` };
    return bashPiece(command);
  }

  if (name === 'str_replace_editor') {
    return filePiece(name, 'edit', args, ctx, '改');
  }

  if (name === 'run_code') {
    return { clause: '跑代码（内容无法静态解析）', highlight: false, classKey: 'tool:run_code' };
  }

  if (name === 'write' || name === 'edit') {
    return filePiece(name, name, args, ctx, '改');
  }

  if (name === 'read' || name === 'read_image') {
    return filePiece(name, 'read', args, ctx, '读');
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

  if (Object.prototype.hasOwnProperty.call(PHONE_TOOLS, name)) {
    const def = PHONE_TOOLS[name];
    if (name === 'phone_open_app') {
      const pkg = isRecord(args) && typeof args.packageName === 'string' ? args.packageName : '';
      return {
        clause: pkg ? `打开 ${pkg}` : '打开应用',
        highlight: false,
        classKey: pkg ? `phone:open_app:${pkg}` : 'tool:phone_open_app',
      };
    }
    if (name === 'phone_open_link') {
      const uri = isRecord(args) && typeof args.uri === 'string' ? args.uri : '';
      const host = hostOf(uri);
      return {
        clause: host ? `连 ${host}` : '打开链接',
        highlight: false,
        classKey: host ? `phone:open_link:${host}` : 'tool:phone_open_link',
      };
    }
    let clause = def.label;
    if (name === 'phone_tap' && isRecord(args) && typeof args.target === 'string' && args.target.trim()) {
      clause = `${def.label} ${args.target.trim()}`;
    }
    return { clause, highlight: false, classKey: `phone:${def.action}` };
  }

  if (name === 'plugin_manager' || name === 'plugin_market' || name === 'plugin_self') {
    return { clause: '管理插件', highlight: false, classKey: `tool:${name}` };
  }

  if (name === 'schedule_create' || name === 'schedule_edit') {
    return { clause: '设置定时任务', highlight: false, classKey: `tool:${name}` };
  }

  if (name === 'extension_present') {
    return { clause: '展示扩展', highlight: false, classKey: 'tool:extension_present' };
  }

  if (name && (/mcp/i.test(name) || name.includes('__'))) {
    return { clause: `调用 ${name}`, highlight: false, classKey: `tool:${name}` };
  }

  // 未知工具
  return { clause: name ? `执行 ${name}` : '', highlight: false, classKey: name ? `tool:${name}` : 'tool:unknown' };
}

/** 危险度排序，用于多调用聚合时取「最危险那条」做 classKey。 */
function dangerRank(classKey) {
  const base = splitClassKey(classKey).base;
  if (!base) return 1;
  if (/^(bash:rm|bash:rmdir|bash:unlink|bash:shred)$/.test(base)) return 5;
  if (base === 'bash:git:push' || base === 'bash:git:reset' || base === 'bash:git:clean' || base === 'bash:git:rm') return 5;
  if (base.startsWith('bash:')) {
    for (const part of base.slice('bash:'.length).split('+')) {
      const [prog, verb] = part.split(':');
      if (!prog) continue;
      if (DELETE_PROGS.has(prog)) return 5;
      if (IMPLICIT_INSTALL.has(prog)) return 4;
      const verbs = PM_INSTALL[prog];
      if (verbs && verbs.has(String(verb || '').toLowerCase())) return 4;
    }
  }
  if (/^(write|edit):/.test(base)) return 3;
  if (/^read:/.test(base)) return 2;
  return 1;
}

/** 拆 `<base>@<tier>`；没有认识的档位后缀时整个串当 base。 */
function splitClassKey(classKey) {
  const key = String(classKey || '');
  const idx = key.lastIndexOf('@');
  if (idx <= 0) return { base: key, tier: '' };
  const tier = key.slice(idx + 1);
  if (!TIERS.has(tier)) return { base: key, tier: '' };
  return { base: key.slice(0, idx), tier };
}

/** 档位归一：认不出的当 `unknown`。 */
function normalizeTier(tier) {
  const t = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  if (TIERS.has(t)) return t;
  if (t.includes('danger') || t.includes('full')) return 'danger-full-access';
  if (t.includes('workspace')) return 'workspace-write';
  return 'unknown';
}

/** action → 中文（`labelOf` 用；与 PHONE_TOOLS 的 label 同源）。 */
const PHONE_ACTION_LABEL = (() => {
  const map = {};
  for (const def of Object.values(PHONE_TOOLS)) {
    if (!map[def.action]) map[def.action] = def.label;
  }
  return map;
})();

/** 不带档位的那一句（`labelOf` 的外壳负责补档位尾巴）。 */
function labelOfBase(base) {
  const parts = String(base || '').split(':');
  const tool = parts[0];
  if (tool === 'bash') {
    if (parts[1] === 'git' && parts[2]) {
      const map = { push: 'git push', commit: 'git commit', reset: 'git reset', clean: 'git clean', rm: 'git rm' };
      return `Bash · ${map[parts[2]] || `git ${parts[2]}`}`;
    }
    if (parts.length === 3) {
      const verb = parts[2];
      return `Bash · ${parts[1]} ${verb === 'add' || verb === 'install' || verb === 'i' || verb === 'ci' || verb === 'dlx' ? '装包' : verb}`;
    }
    const progs = (parts[1] || '').split('+').filter(Boolean);
    if (progs.length > 1) {
      return `Bash · ${progs.map((p) => (DELETE_PROGS.has(p) ? '删除文件' : p)).join(' + ')}`;
    }
    const prog = progs[0] || '';
    if (DELETE_PROGS.has(prog)) return 'Bash · 删除文件';
    if (prog === 'curl' || prog === 'wget') return 'Bash · 联网请求';
    if (IMPLICIT_INSTALL.has(prog)) return `Bash · ${prog} 装包`;
    return `Bash · 运行 ${prog || '命令'}`;
  }
  if (tool === 'write' || tool === 'edit') return `改文件 · ${parts[1] || '未知目录'}`;
  if (tool === 'read') return `读文件 · ${parts[1] || '未知目录'}`;
  if (tool === 'web_fetch') return `联网 · ${parts[1] || '网页'}`;
  if (tool === 'phone') {
    const action = parts[1] || '';
    const detail = parts.slice(2).join(':');
    const label = PHONE_ACTION_LABEL[action] || '操作手机';
    return detail ? `${label} · ${detail}` : label;
  }
  if (tool === 'tool') return `工具 · ${parts[1] || '未知'}`;
  return base ? String(base) : '';
}

/** 把 classKey 翻成给人看的一句（撤销页 / 按钮用），带沙箱档位尾巴。 */
function labelOf(classKey) {
  const { base, tier } = splitClassKey(classKey);
  const core = labelOfBase(base);
  if (!core) return core;
  return `${core}${TIER_SUFFIX[tier] || ''}`;
}

/**
 * 主入口：`calls` = `{toolName, args}` 或它的数组；`options.cwd` 用于写/读文件的目录归类，
 * `options.tier` 是这次审批的沙箱档位（`workspace-write` / `danger-full-access`，解析不到当
 * `unknown`），会拼进 classKey 的 `@` 后缀。
 * 返回 `{ fact, highlight, classKey, classLabel, rememberable }`。
 */
function deriveApprovalFacts(calls, options) {
  const opt = isRecord(options) ? options : {};
  const ctx = {
    cwd: typeof opt.cwd === 'string' ? opt.cwd : '',
    tier: normalizeTier(opt.tier),
  };
  const list = Array.isArray(calls) ? calls : [calls];
  const pieces = [];
  for (const call of list) {
    if (!isRecord(call)) continue;
    const piece = callToPiece(call.toolName, call.args, ctx);
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

  // classKey：多调用取最危险那条；单调用就是它自己。档位在最后统一拼一次。
  let baseKey = pieces.length ? pieces[0].classKey : 'tool:unknown';
  for (const p of pieces) {
    if (dangerRank(p.classKey) > dangerRank(baseKey)) baseKey = p.classKey;
  }
  const classKey = `${baseKey}@${ctx.tier}`;
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
  const key = splitClassKey(classKey).base;
  if (!key) return false;
  // `git rm` 也是删文件（只是经过了 git），`git push/reset/clean` 会动远端或不可恢复。
  if (key === 'bash:git:push' || key === 'bash:git:reset' || key === 'bash:git:clean' || key === 'bash:git:rm') return true;
  if (!key.startsWith('bash:')) return false;
  // 组合键（`bash:cd+rm`）与单程序键（`bash:rm`）都拆成「程序[:动词]」逐段看。
  for (const part of key.slice('bash:'.length).split('+')) {
    const [prog, verb] = part.split(':');
    if (!prog) continue;
    if (DELETE_PROGS.has(prog)) return true;
    if (IMPLICIT_INSTALL.has(prog)) return true;
    const verbs = PM_INSTALL[prog];
    if (verbs && verbs.has(String(verb || '').toLowerCase())) return true;
  }
  return false;
}

/** 解释器 / 套壳程序：参数里才是真正的动作，类别本身没有区分度。 */
function isInterpreterClass(classKey) {
  const key = splitClassKey(classKey).base;
  if (!key.startsWith('bash:')) return false;
  for (const part of key.slice('bash:'.length).split('+')) {
    const prog = part.split(':')[0];
    if (prog && INTERPRETERS.has(prog)) return true;
  }
  return false;
}

/**
 * 键退化到 `tool:<name>`（无区分度）时不给「以后都同意」；`*:abs`（越出工作区）也不给；
 * 手机类只放行「打开某个具体应用 / 链接」；删除 / 推送 / 装软件、解释器与套壳程序同样不给
 * （见 `isIrreversibleClass`、`isInterpreterClass`）；其余给。档位不改变可记性。
 */
function isRememberable(classKey) {
  const base = splitClassKey(classKey).base;
  if (!base || base === 'tool:unknown') return false;
  if (base.startsWith('tool:')) return false;
  if (base.endsWith(':abs')) return false;
  if (base.startsWith('phone:')) return PHONE_REMEMBERABLE.test(base);
  if (isIrreversibleClass(base)) return false;
  if (isInterpreterClass(base)) return false;
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
