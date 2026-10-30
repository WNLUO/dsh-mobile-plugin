'use strict';

/**
 * 过程清单的一步：手机端只拿「一行摘要 + 状态 + 位置」，正文（推理全文、工具参数、
 * 输出、diff）一律走 `/session/step` 按需取。
 *
 * 这里只有纯函数：摘要怎么算、状态怎么判、参数里的路径怎么取。投影层（history-derive）
 * 与详情端点（session-step）都从这里取，避免「清单里写一种说法、详情里又是另一种」。
 */

/** 一步摘要的字数上限：清单是一行省略，再长也看不见，白白占线路。 */
const STEP_SUMMARY_MAX = 72;

/** 摘要里保留的第一个非空行（推理正文常带 markdown，去掉粗体标记与多余空白）。 */
function firstLine(text) {
  const line = String(text || '').replace(/\r\n/g, '\n').split('\n').find((part) => part.trim() !== '') || '';
  return line.replace(/\*\*/g, '').trim();
}

/** 截断到上限，超出用一个省略号收尾。 */
function clampSummary(text, max = STEP_SUMMARY_MAX) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * 推理正文里模型带的签名块（`<signature>…</signature>`）在展示前剥掉。
 *
 * 桌面从 0.2.1-rc.5 起在渲染层做同一件事，但宿主存的会话数据里那段还在 —— 手机不从数据里
 * 剥一遍，清单摘要那第一行就是一串 base64、展开详情整段噪声。流式期间只写到半截签名
 * （`<sig`）时返回空串，不让它先闪一下再消失；剥完什么都不剩的块等于没有推理，调用方按空处理。
 */
function reasoningText(text) {
  const value = typeof text === 'string' ? text : '';
  if (value[0] !== '<') return value;
  const opening = '<signature>';
  if (opening.startsWith(value)) return '';
  if (!value.startsWith(opening)) return value;
  const closing = '</signature>';
  const end = value.indexOf(closing, opening.length);
  if (end === -1) return '';
  let start = end + closing.length;
  while (start < value.length) {
    if (value[start] === '\n') start += 1;
    else if (value[start] === '\r' && value[start + 1] === '\n') start += 2;
    else break;
  }
  return value.slice(start);
}

/** 推理正文的一行摘要。 */
function reasoningStepSummary(text) {
  return clampSummary(firstLine(reasoningText(text)));
}

/** 参数 JSON → 对象；解析不了就返回空对象（畸形参数不该让清单少一条）。 */
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** 参数里第一个像路径/命令/查询词的字段（桌面各工具卡片也是这么挑的）。 */
function firstStringArg(args, keys) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * 工具调用的一行摘要：读/写/改给路径，命令给命令，搜索给查询词，其余退回描述或工具名。
 *
 * 摘要必须带信息量：用户是看着这一行决定「值不值得点开」的，只写「读取文件」等于没写。
 */
function toolStepSummary(name, rawArgs) {
  const args = parseArgs(rawArgs);
  switch (name) {
    case 'bash':
    case 'pwsh':
    case 'terminal_send':
      return clampSummary(firstStringArg(args, ['command', 'cmd']) || firstStringArg(args, ['description']));
    case 'write':
    case 'edit':
    case 'str_replace_editor':
    case 'read':
    case 'read_image':
      return clampSummary(firstStringArg(args, ['file_path', 'path']) || firstStringArg(args, ['description']));
    case 'grep':
    case 'glob':
      return clampSummary(firstStringArg(args, ['pattern', 'query']) || firstStringArg(args, ['path']));
    case 'web_fetch':
      return clampSummary(firstStringArg(args, ['url']));
    case 'web_search':
      return clampSummary(firstStringArg(args, ['query']) || firstStringArg(args, ['q']));
    default:
      return clampSummary(firstStringArg(args, ['description', 'path', 'file_path', 'command', 'query']));
  }
}

/** 工具结果的成败 → 一步的状态（与 App 那份 UI 用同一套词）。 */
function toolStepState(result) {
  if (!result) return 'running';
  if (result.isError) return result.code === 'interrupted' ? 'stopped' : 'error';
  return 'ok';
}

/** 内容块里那段文本（工具结果两种形状都认，见 history-derive 的 toolResultParts）。 */
function textOfParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('');
}

module.exports = {
  STEP_SUMMARY_MAX,
  firstLine,
  clampSummary,
  reasoningText,
  reasoningStepSummary,
  parseArgs,
  toolStepSummary,
  toolStepState,
  textOfParts,
};
