'use strict';

/**
 * 站点知识里的只读脚本：声明格式、清单与调用参数校验。
 *
 * 一条命令就是站点目录下的 `scripts/<name>.js`，文件以一段块注释开头（MARK 见下），后面是
 * async 函数体，参数从 `args` 取。name 必须与文件名一致。头部一行一项：
 *
 *   - `name: list_jobs`
 *   - `description: 列出当前搜索结果里的职位`
 *   - `arg: limit integer - 最多几条`
 *   - `arg: query string required - 只保留标题含这段字的`
 *   - `returns: [{title, company, salary, url}]`
 *   - `readOnly: true`（可选；站点命令只能是 true）
 *
 * 真正的页面内执行由原生侧做（真实页面、读取世界、同源只读），这个模块**不碰网络、不执行
 * 任何代码**，只做两件事：把站点目录里的命令声明列出来，以及在调用前按声明校验参数。
 *
 * ## 执行契约（原生侧遵守，这里只定义，不在 JS 里强制执行）
 *
 * - 只读：脚本只能读 DOM 与页面已加载的数据，不得点击、输入、导航或改动页面状态。
 * - 同源：只允许当前页面同源的 GET，禁止跨域请求。
 * - 禁网：除同源只读外不得主动发起网络请求，不发 POST、不调站点的写接口。
 * - 密码打码：返回值若来自密码 / 验证码等敏感输入，一律以 `***` 代替。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 命令头的起始标记。与 Mika 的 `/* mika-command` 同构，换成我们自己的名字。 */
const COMMAND_MARK = '/* dsh-command';
/** 命令名的字符集：小写字母开头，字母数字下划线，至多 40 个。 */
const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** 参数类型白名单。 */
const TYPES = ['string', 'integer', 'number', 'boolean'];
/** 说明文字上限。 */
const DESCRIPTION_LIMIT = 120;
/** 脚本正文上限（字符）。太长说明该拆，不放进一块。 */
const BODY_LIMIT = 12_000;

/**
 * 站点知识里 `commands` 的字段规格（给写知识的人看，也给校验用）。
 * 每条命令恒定只读。
 */
const COMMAND_SCHEMA = {
  name: '小写字母开头，字母 / 数字 / 下划线，至多 40，必须与文件名 scripts/<name>.js 一致',
  description: `一句话说清这条命令取什么，至多 ${DESCRIPTION_LIMIT} 字`,
  readOnly: '恒为 true：站点命令只能读，不得写页面或改状态',
  returns: '返回的字段说明，例如 [{title, url}]',
  args: '[{ name, type: string|integer|number|boolean, required?, description? }]',
};

/** 执行契约的文字版（给知识注入与原生实现对齐用）。 */
const EXECUTION_CONTRACT = {
  readOnly: true,
  sameOrigin: true,
  network: false,
  redactPasswords: true,
  summary:
    '只读、同源、禁网、密码打码：脚本只读当前页面同源数据，不点击不输入不改页面，'
    + '不主动发网络请求（含写接口），敏感输入一律打码后返回。',
};

const ARG_RE = /^([a-z][A-Za-z0-9_]{0,39})\s+(string|integer|number|boolean)(\s+required)?(?:\s+-\s+(.+))?$/;

/** 去掉 BOM、统一换行、去掉开头空白，便于认头部。 */
function clean(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/^\s+/, '');
}

/** 这段文本是不是一条站点命令（以命令头开头）。 */
function isCommand(text) {
  return clean(text).startsWith(COMMAND_MARK);
}

/**
 * 解析一条站点命令文件。
 *
 * 返回 `{ decl, body, errors }`：`decl` 只在 `errors` 为空时给出，形状为
 * `{ name, description, readOnly: true, returns, args, file }`；`body` 是头部之后的脚本正文。
 *
 * @param {string} file 站点目录下的相对路径，如 `scripts/list_jobs.js`
 * @param {string} text 文件全文
 */
function parseCommand(file, text) {
  const t = clean(text);
  if (!t.startsWith(COMMAND_MARK)) {
    return { decl: null, body: '', errors: [`文件要以 \`${COMMAND_MARK}\` 开头`] };
  }
  const end = t.indexOf('*/');
  if (end < 0) return { decl: null, body: '', errors: ['命令头没有用 `*/` 结束'] };

  const body = t.slice(end + 2).trim();
  const errors = [];
  let name = null;
  let description = null;
  let returns = null;
  let readOnly = null;
  const args = [];

  for (const raw of t.slice(COMMAND_MARK.length, end).split('\n')) {
    // 头部每行可能带一个多余的 `*` 前缀，去掉它再按 key: value 解析。
    const line = raw.trim().replace(/^\*\s?/, '');
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) {
      errors.push(`头部这一行看不懂：${line}`);
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    switch (key) {
      case 'name':
        name = value;
        break;
      case 'description':
        description = value;
        break;
      case 'returns':
        returns = value;
        break;
      case 'readOnly':
      case 'readonly':
        readOnly = value.toLowerCase() === 'true';
        break;
      case 'arg':
        {
          const m = ARG_RE.exec(value);
          if (m) {
            args.push({
              name: m[1],
              type: m[2],
              required: Boolean(m[3]),
              description: (m[4] || '').trim(),
            });
          } else {
            errors.push(`arg 要写作「名字 类型 [required] [- 说明]」，类型是 ${TYPES.join('/')}：${value}`);
          }
        }
        break;
      default:
        errors.push(`头部有不认得的键 ${key}`);
    }
  }

  const base = path.basename(file).replace(/\.js$/i, '');
  if (name == null) errors.push('缺少 name');
  else if (!NAME_RE.test(name)) errors.push('name 只能用小写字母、数字与下划线，以字母开头，至多 40 个字符');
  else if (name !== base) errors.push(`name（${name}）必须与文件名（${base}.js）一致`);
  if (description == null || description === '') errors.push('缺少 description');
  else if ([...description].length > DESCRIPTION_LIMIT) errors.push(`description 超过 ${DESCRIPTION_LIMIT} 字`);
  if (returns == null || returns === '') errors.push('缺少 returns');
  if (readOnly === false) errors.push('站点命令只能只读，readOnly 不能是 false');
  const dupNames = args.map((a) => a.name).filter((n, i, arr) => arr.indexOf(n) !== i);
  for (const dup of new Set(dupNames)) errors.push(`arg ${dup} 重复`);
  if (body === '') errors.push('脚本正文为空');
  if (body.length > BODY_LIMIT) errors.push(`脚本正文 ${body.length} 字，超过 ${BODY_LIMIT}`);

  const decl = errors.length === 0
    ? { name, description, readOnly: true, returns, args, file }
    : null;
  return { decl, body, errors };
}

/** 值是否符合声明的类型。 */
function fitsType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return false;
  }
}

/**
 * 按声明校验一次调用的参数。没问题返回 null，有问题返回一句中文说明。
 *
 * @param {object} decl parseCommand 给出的命令声明
 * @param {object} args 模型 / 调用方给的参数（名字 → 值）
 */
function validateCommand(decl, args) {
  if (!decl || typeof decl !== 'object') return '命令声明无效';
  const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const declared = new Map((decl.args || []).map((a) => [a.name, a]));
  for (const key of Object.keys(given)) {
    if (!declared.has(key)) {
      const takes = (decl.args || []).map((a) => a.name).join('、') || '无参数';
      return `'${key}' 不是 ${decl.name} 的参数；它接受 ${takes}`;
    }
  }
  for (const arg of decl.args || []) {
    const value = given[arg.name];
    const missing = value === undefined || value === null;
    if (missing) {
      if (arg.required) return `${decl.name} 需要参数 '${arg.name}'（${arg.type}）`;
      continue;
    }
    if (!fitsType(value, arg.type)) return `参数 '${arg.name}' 必须是 ${arg.type}`;
  }
  return null;
}

/**
 * 读一个站点目录下的 `scripts/*.js`，把带命令头的解析成声明清单。
 *
 * 返回 `{ commands, errors }`：`commands` 是合法声明（按名字排序），`errors` 收下坏掉的命令
 * 及其具体问题。目录不存在或某文件读坏了都只跳过，不抛。
 *
 * @param {string} siteDir 站点知识目录，如 `knowledge/sites/github.com`
 */
function listCommands(siteDir) {
  const dir = path.join(String(siteDir || ''), 'scripts');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { commands: [], errors: [] };
  }
  const commands = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    } catch {
      continue;
    }
    if (!isCommand(text)) continue;
    const rel = `scripts/${entry.name}`;
    const parsed = parseCommand(rel, text);
    if (parsed.decl) commands.push(parsed.decl);
    else errors.push({ file: rel, errors: parsed.errors });
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands, errors };
}

/** 把一条命令声明写成知识块里的一行（供站点正文注入）。 */
function formatCommandLine(decl) {
  const sig = (decl.args || [])
    .map((a) => `${a.name}${a.required ? '' : '?'}: ${a.type}`)
    .join(', ');
  const notes = (decl.args || [])
    .filter((a) => a.description)
    .map((a) => `${a.name} ${a.description}`)
    .join('; ');
  return `- ${decl.name}(${sig}): ${decl.description}。返回 ${decl.returns}`
    + (notes ? `。参数：${notes}` : '');
}

module.exports = {
  COMMAND_MARK,
  NAME_RE,
  TYPES,
  DESCRIPTION_LIMIT,
  BODY_LIMIT,
  COMMAND_SCHEMA,
  EXECUTION_CONTRACT,
  isCommand,
  parseCommand,
  validateCommand,
  listCommands,
  formatCommandLine,
};
