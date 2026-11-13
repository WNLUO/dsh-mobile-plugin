'use strict';

/**
 * 会话历史的纯派生逻辑：从 host history 事件折叠出 v1 移动端的消息/结构化项。
 *
 * 本模块只做「事件 → 展示结构」的纯计算，不碰 ctx、不发 RPC，因此可以单独测；
 * 原先这些函数与路由 handler 混在 lib/mobile/sessions.js 里（该文件 1964 行），
 * 拆出来后 handler 层只负责 HTTP 与宿主交互。
 *
 * 「什么不下发手机」（推理 / 工具参数 / 工具结果正文与 diff）的唯一规则在 `wire-cut.js`，
 * 这里只负责把留下的事件折成消息结构 —— 直播间那条路调的是同一份。
 */

const { cutAssistantBlock, cutToolResultEvent, createToolNameIndex } = require('./wire-cut.js');
const { rememberToolResults, toolResultsFor, toolResultsVersionFor } = require('./tool-result-cache.js');
const crypto = require('node:crypto');
const { derivedCache } = require('../shared/derived-cache.js');
const { foldTurnFacts, turnFactsSnapshot } = require('./turn-facts.js');

/** 每一轮出过的图（工具结果里的图片块），轮号 → 图。`lookback` 也扫：它才装得下更早那一页。 */
function collectTurnImages(entries, lookbackEntries) {
  const byTurn = new Map();
  for (const list of [entries, lookbackEntries]) {
    for (const entry of list || []) {
      const e = entry && entry.event ? entry.event : entry;
      if (!e || e.type !== 'tool/result' || !e.data || !e.data.message) continue;
      const turn = typeof e.data.turn === 'number' ? e.data.turn : undefined;
      if (turn === undefined) continue;
      const { parts } = toolResultParts(cutToolResultEvent(e, '').data.message);
      const images = toolResultImages(parts);
      if (images.length === 0) continue;
      const bucket = byTurn.get(turn) || [];
      for (const image of images) {
        if (bucket.some((kept) => kept.attachmentId && kept.attachmentId === image.attachmentId)) continue;
        bucket.push(image);
      }
      byTurn.set(turn, bucket);
    }
  }
  return byTurn;
}
const {
  reasoningText,
  reasoningStepSummary,
  toolStepSummary,
  toolStepState,
} = require('./step-index.js');
const { deriveWorkflowRuns } = require('./workflow-runs.js');

/**
 * 从 session.list 摘要行取会话标题（与桌面端侧栏同源，不再从 history 窗口猜）：
 *  - 优先读 title 投影（dsh-session-title 在「完整日志」上折叠的最新 session/title
 *    事件，正是桌面端侧栏显示的同一个值；空白会话恒为 ''，由前端显示「新会话」占位）；
 *  - 无正式标题时回退到工作区目录 basename，最后回退到 sessionId
 *    （对齐 dsh-client-runtime displayTitleOf 的兜底链）。
 * 注意：不能从 history 的 30 条窗口里找标题——长会话会把标题事件挤出窗口（桌面端无此问题）。
 */
function listTitle(s) {
  if (!s || s.blank) return '';
  const t = s.projections && s.projections.values ? s.projections.values.title : undefined;
  if (typeof t === 'string' && t !== '') return t;
  if (typeof s.cwd === 'string' && s.cwd !== '') {
    const base = s.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (base !== undefined && base !== '') return base;
  }
  return s.sessionId || '';
}

/**
 * tool/result 的可见内容：两种形状都认。
 *
 * - 当前形状：`message.content` 直接就是内容块数组，成败在 `message.isError`；
 * - 旧形状：`message.content[0]` 是 `{ isError, content: [内容块] }` 信封。
 *
 * 曾经只认旧形状，于是真实结果里的图片（`{type:'image', attachment}`）被当成信封剥掉、
 * 整张图丢失，结果级 isError 也读不到（失败的工具显示成成功）。
 */
function toolResultParts(msg) {
  const direct = Array.isArray(msg.content) ? msg.content : [];
  const envelope = direct.length === 1 && direct[0] && typeof direct[0] === 'object'
    && typeof direct[0].type !== 'string' ? direct[0] : null;
  if (!envelope) return { parts: direct, isError: msg.isError === true };
  return {
    parts: Array.isArray(envelope.content) ? envelope.content : [],
    isError: envelope.isError === true || msg.isError === true,
  };
}

/**
 * 图片块 → 移动端图片条目（`ChatMessage.images[]` / 工具块的 `images[]` 同一个形状）。
 *
 * 两条互斥的出口：
 *  - 块上有 `attachmentId`：下发**引用** `{ mediaType, name?, width?, height?, attachmentId }`，
 *    **不带 data**。字节由手机端要画的时候按 attachmentId 单张去取（`/session/attachment`），
 *    历史响应因此不再背着几十张截图的 base64。
 *  - 块里本来就只有内联 `data`、没有 attachmentId：照旧下发 `{ mediaType, data, name?, width?, height? }`。
 *    这条兜底不能删——老日志、工具结果里存在这种直接带字节的图片块。
 *
 * 宽高两格见 `imageDimsOf`：那是「手机能不能在挂载那一帧就占好位置」的前提。
 *
 * `bytes` 来自宿主附件记账（`attachment.bytes`，宿主 `ImageAttachmentRef` 本来就有这一格）：
 * App 的事实条靠它写体积，没有它就只能对内联形状按 base64 长度估。`mediaIds` 是宿主在图片
 * 块上标的「这次生成的批编号」：有就原样透传，手机侧据此把同一次生成的几张认成一组候选；
 * 老宿主不给这一格，手机侧按「这一轮的图算一批」兜底，插件不另造编号。
 *
 * 两条都要求 mediaType 可读（块上没有就退到 attachment 上的），否则 App 认不出来、
 * 也没有可显示的动作，返回 null 让调用方丢掉它。
 */
function imageEntryOf(block) {
  if (!block || typeof block !== 'object') return null;
  const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : {};
  const attachmentId = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '';
  const mediaType = typeof block.mediaType === 'string' && block.mediaType
    ? block.mediaType
    : (typeof attachment.mediaType === 'string' ? attachment.mediaType : '');
  if (!mediaType) return null;
  const name = typeof block.name === 'string'
    ? block.name
    : (typeof attachment.name === 'string' ? attachment.name : undefined);
  const dims = imageDimsOf(block, attachment);
  const bytes = imageBytesOf(block, attachment);
  const mediaIds = imageMediaIdsOf(block, attachment);
  const extra = {
    ...(name !== undefined ? { name } : {}),
    ...dims,
    ...(bytes === undefined ? {} : { bytes }),
    ...(mediaIds.length === 0 ? {} : { mediaIds }),
  };
  if (attachmentId) return { mediaType, ...extra, attachmentId };
  if (typeof block.data === 'string' && block.data) return { mediaType, data: block.data, ...extra };
  return null;
}

/**
 * 图片的字节数：宿主附件记账里的 `bytes`（块上或 attachment 上都认）。
 *
 * 不是正数的当没有：体积那一格宁可整截不写，也不摆一个「0 B」。
 */
function imageBytesOf(block, attachment) {
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
  return pick(block.bytes) ?? pick(attachment.bytes);
}

/**
 * 这次生成的批编号（宿主在图片块上标的 `mediaIds`）：去重后升序，没有就回空数组。
 *
 * **不新造编号**：手机侧对没有批号的图按「这一轮算一批」归组，插件补一个跨轮唯一号只会
 * 让同一轮里的图被拆成多组。
 */
function imageMediaIdsOf(block, attachment) {
  const source = Array.isArray(block.mediaIds) ? block.mediaIds
    : (Array.isArray(attachment.mediaIds) ? attachment.mediaIds : []);
  const ids = new Set();
  for (const value of source) {
    if (typeof value === 'number' && Number.isFinite(value)) ids.add(value);
  }
  return [...ids].sort((left, right) => left - right);
}

/**
 * 图片的原始宽高 —— 宿主的附件里本来就有（`attachment.width` / `attachment.height`）。
 *
 * **不许省掉这一格。** 手机侧要靠它把图片行的高度在**挂载那一帧就占好**：没有宽高，那一行
 * 只能先按 240 方盒占位、等图解码完 onLoad 再改成真比例；而行高在挂载之后变高，正是对话页
 * 「先落到底、再被顶回去」的来源（贴底列表上方一变高，屏幕上的内容就往下退一段）。
 * 宽高非法（缺失 / 非正数）时整格不出现，调用方仍按旧兜底盒处理。
 */
function imageDimsOf(block, attachment) {
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
  const width = pick(block.width) ?? pick(attachment.width);
  const height = pick(block.height) ?? pick(attachment.height);
  if (width === undefined || height === undefined) return {};
  return { width, height };
}

/** 把 tool/result 的图片块收成移动端图片条目（两种出口见 imageEntryOf）。 */
function toolResultImages(parts) {
  const out = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object' || part.type !== 'image') continue;
    const entry = imageEntryOf(part);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * 预扫描 tool/result 事件，构建 callId → 状态/图片 映射（对接桌面 toolRowModel 状态派生）。
 *
 * 每条结果先过 `wire-cut.js`：正文与结果上的 `meta`（已应用 diff）都不下发，只留状态与图片，
 * 正文只给定时任务卡要解析的 `schedule_create` 留着。工具名从同一批事件里攒
 * （`tool/call`、assistant 的 tool-call 块），攒不到就按「不留正文」处理。
 */
function buildToolResultMap(events) {
  const map = new Map();
  const toolNames = createToolNameIndex();
  toolNames.absorbAll(events);
  for (const entry of events) {
    const e = entry.event || entry;
    if (e.type !== 'tool/result' || !e.data || !e.data.message) continue;
    const msg = e.data.message;
    const src = msg.source;
    if (!src || typeof src.callId !== 'string') continue;
    const kept = cutToolResultEvent(e, toolNames.nameOf(src.callId));
    const { parts, isError } = toolResultParts(kept.data.message);
    const code = kept.data.error && typeof kept.data.error.code === 'string' ? kept.data.error.code : undefined;
    const output = parts.map((part) => {
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('');
    const images = toolResultImages(parts);
    // `seq` 只给「按需取详情」用：手机点开这一步时拿它去回拉那一小窗事件。
    map.set(src.callId, {
      isError: isError || kept.data.error != null,
      code,
      ...(Number.isSafeInteger(e.seq) ? { seq: e.seq } : {}),
      ...(output ? { output } : {}),
      ...(images.length ? { images } : {}),
    });
  }
  return map;
}

/**
 * 把整窗工具结果折成客户端补丁（`/session/messages` 顶层的 `toolResults`）。
 *
 * 补丁本身必须取自整个窗口：调用方游标可能已经越过结果 seq，而调用块还停在 running，
 * 客户端按 callId 幂等打补丁。但**已经随消息块下发的**那份结果不再重复带料 ——
 * `items` 里的 tool-call 块本来就是同一张表构出来的，图片与定时任务卡要的那份正文再传一遍
 * 等于同一份内容在一条响应里走两趟。客户端打补丁时状态照写、料只在给了的时候才覆盖，所以
 * 那几格省掉是安全的；消息块不在这份窗口里时才带全。
 *
 * `bodies: false`（增量拉取）连「消息块不在这份窗口里」的那些也只回状态。理由是同一个：
 * 增量拉取的调用方手上已经有一份完整的会话，缺的只是「这几次调用结束了没有」。
 */
function toolResultPatchesFor(events, items, options = {}) {
  const bodies = options.bodies !== false;
  const delivered = new Set();
  for (const item of items || []) {
    if (!item || !Array.isArray(item.blocks)) continue;
    for (const block of item.blocks) {
      if (block && block.type === 'tool-call' && typeof block.callId === 'string' && block.callId) {
        delivered.add(block.callId);
      }
    }
  }
  return [...buildToolResultMap(events).entries()].map(([callId, result]) => {
    const state = result.isError ? (result.code === 'interrupted' ? 'stopped' : 'error') : 'ok';
    if (!bodies || delivered.has(callId)) return { callId, state };
    return {
      callId,
      state,
      ...(result.output ? { output: result.output } : {}),
      ...(result.images && result.images.length ? { images: result.images } : {}),
    };
  });
}

/** 把 assistant message.content 解析为一个结构块数组（text/tool-call/image）。 */
function parseBlocks(blocks, toolResults) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const raw of blocks) {
    // 推理不下发、tool-call 收成骨架（三张轮尾卡的工具留 arguments）—— 与直播间同一条规则。
    const b = cutAssistantBlock(raw);
    if (!b || typeof b.type !== 'string') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && b.dataUnavailable === true) {
      // The image attachment resolver marked this block as unavailable. Keep it out of
      // visible text; pushMessage projects its retry metadata onto unavailableImages.
      continue;
    } else if (b.type === 'image') {
      // 有 attachmentId 走引用、只有内联 data 的走兜底（见 imageEntryOf）。两者都认不出
      // 就整块丢掉——与旧行为一致，绝不能把它兜底成一段 JSON 文本。
      const entry = imageEntryOf(b);
      if (entry) out.push({ type: 'image', ...entry });
    } else if (b.type === 'tool-call') {
      // 块已被上面那条规则收过：非白名单工具只剩 `{ id, name }`，所以 argsRaw 只有三张
      // 轮尾卡的工具才有（App 从它读计划/扩展/定时任务的料）。`todo_write` 是唯一另一档：
      // 参数已被换成瘦身投影（`[{c,s}]`），不是原文，`phase` 也由同一条规则顺带算好。
      const callId = b.id != null ? String(b.id) : undefined;
      let state;
      let output;
      let images;
      if (callId && toolResults) {
        const result = toolResults.get(callId);
        if (result) {
          output = result.output;
          images = result.images;
          // 对齐桌面 toolRowModel 状态派生：error.code === 'interrupted' → stopped, isError → error, ok
          if (result.isError) {
            state = result.code === 'interrupted' ? 'stopped' : 'error';
          } else {
            state = 'ok';
          }
        }
      }
      out.push({
        type: 'tool-call',
        callId,
        name: typeof b.name === 'string' ? b.name : undefined,
        argsRaw: typeof b.arguments === 'string' ? b.arguments : (b.arguments != null ? JSON.stringify(b.arguments) : undefined),
        ...b.phase && typeof b.phase === 'object' ? { phase: b.phase } : {},
        ...state ? { state } : {},
        ...typeof output === 'string' && output ? { output } : {},
        ...images && images.length ? { images } : {},
      });
    } else {
      // 桌面端对未知 assistant block 使用 JsonBlock 兜底；移动端没有对应组件，
      // 先保留原始内容为可见文本，避免历史重同步后该节点整体消失。
      out.push({ type: 'text', text: `[未支持的内容块]\n${JSON.stringify(b)}` });
    }
  }
  return out;
}

/** 从结构块里拼接纯文本（列表预览/标题回退用，仍只取 text 块）。 */
function blocksToText(blocks) {
  return blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * 照片说明行的哨兵（U+2063 INVISIBLE SEPARATOR）。
 *
 * **只服务老消息**：早先版本发送时会在图片块之后追加一个 text 块告诉模型「这张是什么时候
 * 拍的、多大」（现在不这么发了）。那些消息的 content 里还留着那一行，而 `blocksToText` 把
 * 所有 text 块用换行拼成用户消息的展示文本，重进会话 / 断线补齐时用户气泡里就会凭空长出一行
 * 「[照片 …]」—— 用户看到的是「我发的消息自己变长了」。
 *
 * 当年那一行带了这个不可见前缀，这里在**算用户消息的展示文本时**把带它的整行去掉。字面量与
 * 语义的单一来源是 `app/src/services/viewmodels/photo-caption.ts` 的
 * `PHOTO_CAPTION_SENTINEL`（那边定义了常量与剥离函数，这里只出现同一个字符）。
 *
 * **为什么剥在插件而不是 App**：历史正文是这里拼的，App 拿到的 `item.text` 只是展示出口；
 * 在拼的这一处剥就只有一处，App 不需要认识这条约定，也不用在每个渲染点各判一次。
 */
const PHOTO_CAPTION_SENTINEL = '\u2063';

/**
 * 用户消息的展示文本：拼所有 text 块，再剥掉照片说明行。
 *
 * 只给 `role === 'user'` 用：助手正文里的 `[照片 …]` 是模型自己写的字，一个字都不许动。
 * 剥完是空串时就是空串（只发图不写字的用户消息本来就有自己的画法，别给它塞占位）。
 */
function userVisibleText(blocks) {
  const text = blocksToText(blocks);
  if (!text.includes(PHOTO_CAPTION_SENTINEL)) return text;
  return text
    .split('\n')
    .filter((line) => !line.startsWith(PHOTO_CAPTION_SENTINEL))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** 从 compaction/summary 的 summary 字段提取展示文本（数组=文本块列表，字符串直接取；空→null）。 */
function compactionSummaryText(summary) {
  if (Array.isArray(summary)) {
    const text = summary.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    return text.trim() === '' ? null : text;
  }
  if (typeof summary === 'string') return summary.trim() === '' ? null : summary;
  return null;
}

/** 从 shadowedSeqs 取被压缩条数（数组长度；缺失→null）。 */
function shadowedCount(seqs) {
  return Array.isArray(seqs) ? seqs.length : null;
}

/**
 * 一个 seq 属于哪一轮：先看事件自己的 `data.turn`，没有就按 `turn/start` 的边界归轮
 * （某个 `turn/start` 之后、下一个 `turn/start` 之前的事件必然属于那一轮）。早于窗口里
 * 第一条 `turn/start` 的 seq 无法判定，返回 null。
 *
 * 为什么要这条边界兜底：真实日志里 `user/message` 不带 `data.turn`，用户的每一句正是被压缩
 * 区间的起点；只查精确值的话，区间永远算不出来。
 *
 * 「落在之后」用的是 `<= seq`，前提是同一轮里 `turn/start` 不会晚于该轮的其它事件。已在本机
 * 1621 份会话日志上核对过：带 `data.turn` 的事件 56.7 万条，没有一条的 seq 早于它自己那一轮
 * 的 `turn/start`；也没有 `turn/start` 晚于该轮 `turn/end` 的样本，边界查询与事件自带轮号
 * 零矛盾。所以不需要再用 `turn/end` 反推，那条路留空。
 */
function turnOfSeq(seq, turnBySeq, turnStarts) {
  const exact = turnBySeq.get(seq);
  if (typeof exact === 'number') return exact;
  if (turnStarts.length === 0) return null;
  let lo = 0;
  let hi = turnStarts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turnStarts[mid][0] <= seq) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : turnStarts[found][1];
}

/**
 * 被压缩区间落在哪几轮：`{ from, to }`（两端都是轮号），算不出来时为 null。
 *
 * `shadowedSeqs` 里的每一个 seq 都要能查到轮号。**查不全就整对不下发**：宁可只显示条数，
 * 也不能拿查得到的那几个 seq 拼一个区间出来 —— 窗口外的 seq 属于更早的轮次，猜出来的
 * 区间会让用户照着跳到错误的位置。
 */
function shadowedTurnRange(seqs, turnBySeq, turnStarts) {
  if (!Array.isArray(seqs) || seqs.length === 0) return null;
  let from = null;
  let to = null;
  for (const seq of seqs) {
    const turn = turnOfSeq(seq, turnBySeq, turnStarts);
    if (typeof turn !== 'number') return null;
    if (from === null || turn < from) from = turn;
    if (to === null || turn > to) to = turn;
  }
  return from === null ? null : { from, to };
}

/**
 * 压缩行上的轮次区间字段：`{ shadowedTurnFrom, shadowedTurnTo }`，算不出来时是空对象
 * （字段整个不出现，App 侧按「未知」处理）。同一套口径喂给检查点、`compaction/end`
 * 与 `compaction/summary` 三处落点。
 */
function shadowedTurnFields(data, turnIndex) {
  const range = data ? shadowedTurnRange(data.shadowedSeqs, turnIndex.bySeq, turnIndex.starts) : null;
  return range ? { shadowedTurnFrom: range.from, shadowedTurnTo: range.to } : {};
}

/** 取安全非负整数的 token 数（与桌面端同口径：safe integer 且 >= 0，否则 null）。 */
function shadowedTokens(n) {
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** retry failure 字段：{code?, message?} 或 null（字段缺失/非字符串则省略）。 */
function retryFailure(failure) {
  if (!failure || typeof failure !== 'object') return null;
  const out = {};
  if (typeof failure.code === 'string' && failure.code !== '') out.code = failure.code;
  if (typeof failure.message === 'string' && failure.message !== '') out.message = failure.message;
  return out.code !== undefined || out.message !== undefined ? out : null;
}

/** 重试行属于哪一步：步骤一关就要把它作废（App 侧按这两个数认）。 */
function retryOwner(data) {
  return {
    ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
    ...(typeof data.step === 'number' ? { step: data.step } : {}),
  };
}

/** 列表/概览的 lastMessage 预览只取有 role 的消息项（结构化行不参与预览）。 */
function lastMessageOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role) return messages[i];
  }
  return null;
}

/**
 * 一份历史事件里所有**交付声明**过的路径（`deliverables/presented` 的 `files[].path`）。
 *
 * 与下面的按轮归并同一批事件、同一个形状兼容（`entry.event || entry`）：交付文件取字节
 * 那条路由（`session-file.js`）用它做白名单 —— 只有模型显式交出来的文件才允许手机上取。
 * 单独一个函数而不是从消息里翻 `presentedFiles`：声明事件可能落在消息窗口之外，按轮挂在
 * 消息上的那份不一定在。
 */
function presentedPathsOf(events) {
  const paths = new Set();
  for (const entry of events) {
    const e = entry && (entry.event || entry);
    if (!e || e.type !== 'deliverables/presented' || !e.data || !Array.isArray(e.data.files)) continue;
    for (const raw of e.data.files) {
      if (raw && typeof raw.path === 'string' && raw.path.trim() !== '') paths.add(raw.path);
    }
  }
  return paths;
}

/**
 * 一段事件的指纹：seq + type 的顺序序列，外加这一段之外的两格（lookback、工具结果版本）。
 *
 * 判据的边界写在 `deriveMessages` 的注释里：会话日志只追加，同一 seq 的事件不会换内容；
 * 会变的只有条数与窗口。`@param {unknown[]} parts` 里每一项要么是事件数组、要么是个标量。
 */
function eventFingerprint(events, lookbackEvents, toolResultsVersion) {
  const hash = crypto.createHash('sha1');
  // 一条事件只喂一次 `update`：`hash.update` 自身的固定开销在这个量级上比哈希本身还大
  // （实测 3600 条事件拆成四次 update 要 3.3ms，拼成一串只要 1.3ms）。
  const feed = (list) => {
    if (!Array.isArray(list)) {
      hash.update('|');
      return;
    }
    hash.update(`#${list.length}|`);
    for (const entry of list) {
      const e = entry && entry.event ? entry.event : entry;
      if (!e || typeof e !== 'object') { hash.update('|'); continue; }
      hash.update(`${Number.isSafeInteger(e.seq) ? e.seq : ''}:${typeof e.type === 'string' ? e.type : ''}|`);
    }
  };
  // lookback 在指纹里只需要「有没有、多长」：它只用来补更早的工具结果，内容变化一定伴随
  // 那个工具结果表的版本号变化，逐条扫一遍这一段不划算。
  hash.update(Array.isArray(lookbackEvents) && lookbackEvents.length ? `l${lookbackEvents.length}` : 'l0');
  hash.update(`|v${toolResultsVersion || 0}`);
  feed(events);
  return hash.digest('hex').slice(0, 16);
}

/**
 * 从 history 事件折叠出消息与「结构化行」（wire v1 扩展，向后兼容）：
 *  - 普通消息：{ id, seq, time, role, text, blocks?, images?, clientMessageId? }；
 *  - compaction：渲染成 compaction 行而不是用户气泡，id=compactionId；同 compactionId 的
 *    compaction/summary 补 counts，compaction/end 落定 state（带 error 即 failed）；
 *    同一轮的多次尝试只占一行，新尝试原地顶替还没落定的那条；
 *  - retry：{ kind:'retry', id: retryId, status:'scheduled'|'started', retry, maxRetries, … }；
 *  - turn-error / max-tokens：id 为 `turn-<turn>`；
 *  - command：command/run 发出行，command/done 原地升级。
 * 结构化项与消息按 seq 升序混排；旧载荷字段缺失时跳过对应项，绝不抛错。
 */
function deriveMessages(events, sessionId, lookbackEvents) {
  // 同一份事件折过一次就不再折：手机 15 秒轮询一次、镜像后台 500ms tick 一次，绝大多数
  // 轮次窗口里一条新事件都没有（见 shared/derived-cache.js）。
  //
  // 指纹取**每条事件的 seq + type**，不取整份内容的哈希：会话日志是只追加的，同一个 seq
  // 上那条事件的类型与在窗口里的位置不会变，变的只有「多出来几条」和「窗口从头挪了」。
  // 这两件事 seq/type 序列都看得出来，而整份内容哈希在这个量级上比折一遍还贵（实测长会话
  // 400 回合：整份 sha1 要 13ms、折一遍 9ms，按 seq/type 只要 1.3ms —— 拿它当判据等于白省）。
  //
  // 唯一从外面溜进来的输入是「进程里记下的工具结果」那张表（倒着翻页时用来补更早的图），
  // 它自己的版本号也进指纹：这一页没变、但更晚的一页记下了结果，图就该跟着补上。
  // 没有 sessionId 就不进缓存（分桶靠它，没有桶名的调用方多半是一次性计算）。
  const cacheKey = sessionId
    ? eventFingerprint(events, lookbackEvents, toolResultsVersionFor(sessionId))
    : '';
  if (cacheKey) {
    const hit = derivedCache.get(sessionId, cacheKey);
    if (hit !== undefined) return hit;
  }
  const out = [];
  // 预扫描 tool/result 事件（同批次事件内，结果可能在调用块之前/之后出现）。
  // `lookbackEvents` 是这一页**再往前**的一小段：倒着分页时工具结果常常落在比消息更早的位置
  // （一轮里先跑工具、最后才写正文），只看这一页就看不出这一轮出过哪些图。
  const toolResults = buildToolResultMap(lookbackEvents && lookbackEvents.length ? events.concat(lookbackEvents) : events);  // 倒着分页时，一页的边界可能正好切在「工具调用」与「它的结果」之间：这一页只有调用，
  // 结果在更新的一页（本机早就拿到过）。把那些记在进程里的结果并进来，图就跟着消息一起
  // 下发，手机侧那一行在挂载那一帧就是终高（见 tool-result-cache.js）。
  const remembered = toolResultsFor(sessionId);
  if (remembered) {
    for (const [callId, result] of remembered) {
      if (!toolResults.has(callId)) toolResults.set(callId, result);
    }
  }
  // 这一页看到的结果记下来，供更早的页用（同一进程里，后到的页是更早的那几页）。
  rememberToolResults(sessionId, toolResults);
  // 预扫描 compaction/summary：检查点 user/message 与 summary 事件在日志里的先后不固定，
  // 用 compactionId → summary 数据把 counts 补全到同一压缩行上。
  const summaries = new Map();
  for (const entry of events) {
    const e = entry.event || entry;
    if (e.type !== 'compaction/summary' || !e.data || typeof e.data.compactionId !== 'string') continue;
    summaries.set(e.data.compactionId, e.data);
  }
  // seq → turn：被压缩的 seq 要落到「第几轮」。两个来源合起来才够用 —— 大多数事件自己带
  // `data.turn`（step / tool / assistant），而真实日志里的 `user/message` 恰恰不带，它又正是
  // 被压缩区间的起点；所以再按 `turn/start` 的 seq 排一张边界表兜底（见 `turnOfSeq`）。
  // 早于窗口里第一条 `turn/start` 的 seq 无解，`shadowedTurnRange` 据此整对返回 null。
  const turnIndex = { bySeq: new Map(), starts: [] };
  for (const entry of events) {
    const e = entry.event || entry;
    if (!e || !e.data || typeof e.data !== 'object') continue;
    if (typeof e.data.turn !== 'number') continue;
    turnIndex.bySeq.set(e.seq, e.data.turn);
    if (e.type === 'turn/start') turnIndex.starts.push([e.seq, e.data.turn]);
  }
  turnIndex.starts.sort((a, b) => a[0] - b[0]);
  // 交付声明预扫描（`deliverables/presented`）：模型调 `present` 声明「这几份请你收下」时，
  // 宿主的 dsh-tool-present 会往会话日志追一条这个事件。桌面那张「交付文件」卡只认它 ——
  // **不是**「这一轮改过哪些文件」。手机第一版从 write/edit 反推，于是「每改一次都冒卡、
  // 命令行改的却一张都没有」。这里按 **turn** 归并，
  // 同一个路径后声明的覆盖先声明的（桌面 `presentedForClosing` 的 `files.set` 同口径）。
  const presentedByTurn = new Map();
  for (const entry of events) {
    const e = entry.event || entry;
    if (e.type !== 'deliverables/presented') continue;
    const data = e.data;
    if (!data || typeof data !== 'object' || typeof data.turn !== 'number' || !Array.isArray(data.files)) continue;
    const bucket = presentedByTurn.get(data.turn) || [];
    for (const raw of data.files) {
      if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || raw.path.trim() === '') continue;
      const file = {
        path: raw.path,
        ...(typeof raw.description === 'string' && raw.description.trim() !== '' ? { description: raw.description } : {}),
      };
      const at = bucket.findIndex((item) => item.path === file.path);
      if (at >= 0) bucket[at] = file;
      else bucket.push(file);
    }
    if (bucket.length > 0) presentedByTurn.set(data.turn, bucket);
  }

  // 模型归因、成功产出与净改动和直播同源；原始参数与 diff 只在本机折叠。
  const factsByTurn = foldTurnFacts((lookbackEvents || []).concat(events));
  const producedItems = [];

  // 单步计时预扫描：为每条 assistant 消息派生「本轮」的 ttft / decode / 输出 token
  // （对齐桌面 turn-metrics/assistant-timing：ttftMs = 首个非空 delta − step/start；
  // decodeMs = 落定 − 首个 delta；outputTokens = assistant/message.usage.outputTokens）。
  // 会话累计 stats 属于输入区常驻统计条，绝不能拿来冒充单轮指标（否则每条历史消息
  // 都会显示同一份累计行并随轮询刷新——正是移动端此前「统计行一直出现」的根因）。
  const stepStartTime = new Map();
  const turnStartTime = new Map();
  const turnEndTime = new Map();
  const firstDeltaTime = new Map();
  const stepOutputTokens = new Map();
  const stepKey = (turn, step) => `${turn}:${step}`;
  for (const entry of events) {
    const e = entry.event || entry;
    if (!e || typeof e.data !== 'object' || e.data === null) continue;
    const turn = e.data.turn;
    const step = e.data.step;
    if (typeof turn !== 'number') continue;
    if (e.type === 'turn/start') turnStartTime.set(turn, e.time);
    if (e.type === 'turn/end') turnEndTime.set(turn, e.time);
    if (typeof step !== 'number') continue;
    if (e.type === 'step/start') {
      const k = stepKey(turn, step);
      if (!stepStartTime.has(k)) stepStartTime.set(k, e.time);
    } else if (e.type === 'assistant/chunk' && e.data.chunk) {
      const c = e.data.chunk;
      if (c.type === 'text-delta' || c.type === 'reasoning-delta' || c.type === 'tool-call-delta') {
        const k = stepKey(turn, step);
        if (!firstDeltaTime.has(k)) firstDeltaTime.set(k, e.time);
      }
    } else if (e.type === 'assistant/message' && e.data.usage) {
      const tokens = e.data.usage.outputTokens;
      if (typeof tokens === 'number' && tokens > 0) {
        const k = stepKey(turn, step);
        if (!stepOutputTokens.has(k)) stepOutputTokens.set(k, tokens);
      }
    }
  }
  /** 派生一条 assistant 消息所在 step 的单轮计时；缺记录（非流式落定/无 step 边界）返回 undefined。 */
  const timingOf = (e) => {
    if (!e || typeof e.data !== 'object' || e.data === null) return undefined;
    const turn = e.data.turn;
    const step = e.data.step;
    if (typeof turn !== 'number' || typeof step !== 'number') return undefined;
    const k = stepKey(turn, step);
    const start = stepStartTime.get(k);
    const first = firstDeltaTime.get(k);
    const timing = {};
    const turnStart = turnStartTime.get(turn);
    const turnEnd = turnEndTime.get(turn);
    if (turnStart != null && turnEnd != null && turnEnd >= turnStart) timing.runMs = turnEnd - turnStart;
    if (start == null || first == null) return Object.keys(timing).length > 0 ? timing : undefined;
    const ttftMs = Math.max(0, first - start);
    if (ttftMs > 0) timing.ttftMs = ttftMs;
    const decodeMs = Math.max(0, e.time - first);
    if (decodeMs > 0) timing.decodeMs = decodeMs;
    const outputTokens = stepOutputTokens.get(k);
    if (typeof outputTokens === 'number' && outputTokens > 0) timing.outputTokens = outputTokens;
    return Object.keys(timing).length > 0 ? timing : undefined;
  };
  // 结构化行按 id 唯一：compactionId → 行索引（检查点行原地替换 start 行）、retryId → 行索引（原地升级）。
  const compactionAt = new Map();
  // 一轮里的压缩尝试行（turn → 行索引表）：同一轮的多次尝试共用一行，见 pendingCompactionAt。
  const compactionTurns = new Map();
  const retryAt = new Map();
  // 命令行按 commandId 唯一：command/run 发出行，command/done 原地升级（保 run 的 name，位置随 done 事件 seq 归位）。
  const commandAt = new Map();

  /**
   * 每一轮的「过程清单」：一步一行摘要，正文仍然一个字节都不下发。
   *
   * 清单挂在**这一轮开头那条消息**上（App 的头条行就是它派生的），收口后点开清单再按
   * `seq` / `resultSeq` 去 `/session/step` 取那一步的详情 —— 这就是「按需获取」的那一半。
   * 只做摘要不做正文：一条推理正文平均几万字、一次 `write` 的参数就是整份文件，把它们
   * 塞进消息响应里正是 2026-10-27 砍掉它的理由。
   */
  const stepsByTurn = new Map();
  const openerByTurn = new Map();
  /**
   * 工作流那四类事件（`tool-workflow/*`）原样攒着，最后交给 `workflow-runs.js` 折成树。
   *
   * 不在主循环里就地折：一次运行的数据横跨四条事件、还要看「开启它的那一轮有没有被中断」，
   * 那些判据只有整窗看完才成立。攒的时候连 seq 一起留（要按位置归轮）。
   */
  const workflowEntries = [];
  let lastOpener = null;
  const collectSteps = (content, e) => {
    if (!Array.isArray(content)) return;
    const turn = e.data && typeof e.data.turn === 'number' ? e.data.turn : undefined;
    if (turn === undefined) return;
    if (!openerByTurn.has(turn) && lastOpener) openerByTurn.set(turn, lastOpener);
    const list = stepsByTurn.get(turn) || [];
    content.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.type === 'reasoning') {
        // 签名块先剥掉再判空：只剩签名的那一段等于没有推理，不算一步（桌面那边是整行不显示）。
        const text = reasoningText(raw.text);
        // 空推理块（只有零宽字符那种）不算一步：App 点开一条什么都没有的行没有意义。
        if (text.trim() === '') return;
        list.push({
          kind: 'think',
          ...(Number.isSafeInteger(e.seq) ? { seq: e.seq } : {}),
          index,
          summary: reasoningStepSummary(text),
        });
        return;
      }
      if (raw.type !== 'tool-call') return;
      const callId = raw.id != null ? String(raw.id) : undefined;
      const result = callId ? toolResults.get(callId) : undefined;
      const rawArgs = typeof raw.arguments === 'string'
        ? raw.arguments
        : (raw.arguments != null ? JSON.stringify(raw.arguments) : '');
      list.push({
        kind: 'tool',
        ...(callId ? { callId } : {}),
        ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
        summary: toolStepSummary(raw.name, rawArgs),
        state: toolStepState(result),
        ...(Number.isSafeInteger(e.seq) ? { seq: e.seq } : {}),
        ...(result && Number.isSafeInteger(result.seq) ? { resultSeq: result.seq } : {}),
      });
    });
    if (list.length > 0) stepsByTurn.set(turn, list);
  };

  // 普通消息（user/assistant）沿用原折叠逻辑。
  const pushMessage = (msg, e) => {
    collectSteps(msg.content, e);
    const parsed = parseBlocks(msg.content, toolResults);
    // 工具产出的图挂成这条消息的图片附件：App 把它画在气泡上方（缩略图 + 文件名，点开全屏），
    // 与用户自己发的图同一种形状。工具卡里不再重复画同一张图 —— 一张图两处画会把字节也翻倍。
    const toolImages = [];
    const blocks = parsed.map((block) => {
      if (block.type !== 'tool-call' || !Array.isArray(block.images) || block.images.length === 0) return block;
      toolImages.push(...block.images);
      const { images: _movedToAttachments, ...rest } = block;
      return rest;
    });
    // 用户消息的展示文本要剥掉照片说明（见 `userVisibleText`）；助手消息原样拼。
    const text = msg.role === 'user' ? userVisibleText(blocks) : blocksToText(blocks);
    // 图片条目统一投影：引用模式带 attachmentId 不带 data，内联兜底带 data 不带 attachmentId。
    //
    // **宽高必须一起带上**（`imageDimsOf` 的口径）：手机侧靠它在挂载那一帧就把图片行的高度占好，
    // 少这两格就只能先占 240 方盒、等解码完再改，而贴底列表上方一变高，屏幕上看到的内容就
    // 往下退一段 —— 这正是「先落到底、再被顶回去」那一跳。
    const images = [
      ...blocks.filter((b) => b.type === 'image'),
      ...toolImages,
    ].map(({ mediaType, data, name, attachmentId, width, height, bytes, mediaIds }) => ({
      mediaType,
      ...(typeof name === 'string' ? { name } : {}),
      ...(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : {}),
      ...(typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? { bytes } : {}),
      ...(Array.isArray(mediaIds) && mediaIds.length > 0 ? { mediaIds } : {}),
      ...(typeof attachmentId === 'string' && attachmentId ? { attachmentId } : {}),
      ...(typeof attachmentId === 'string' && attachmentId ? {} : { data }),
    }));
    const unavailableImages = (Array.isArray(msg.content) ? msg.content : [])
      .filter((block) => block && block.type === 'image' && block.dataUnavailable === true)
      .map((block) => {
        const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : {};
        return {
          attachmentId: typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '',
          ...(typeof block.mediaType === 'string' ? { mediaType: block.mediaType } : {}),
          ...(typeof block.name === 'string' ? { name: block.name } : {}),
        };
      })
      .filter((image) => image.attachmentId !== '');
    // 只要存在可识别或保留的 block 就入列表；纯推理/工具调用也必须保留，
    // 否则流式标签在重同步时会消失。
    const hasContent = blocks.length > 0 || unavailableImages.length > 0;
    if (!hasContent) return;
    const clientMessageId = msg.role === 'user' ? clientMessageIdFromSource(msg.source, msg) : undefined;
    // 这一轮的轮号（老日志没有）：产出清单、交付声明按它归并，也随消息下发给 App ——
    // 对话页的轮次头条与整条会话轴都要靠它，缺了这条消息就落不到任何一轮上。
    // 事件自带的 `data.turn` 优先（真实日志里带它的更权威，跨轮对不上时以它为准）；
    // `user/message` 恰恰都不带，它又正是开启这一轮的那条，所以按 `turn/start` 的边界兜底。
    const turn = turnOfSeq(e.seq, turnIndex.bySeq, turnIndex.starts) ?? undefined;
    const item = {
      id: String(msg.id),
      role: msg.role || 'assistant',
      text,
      blocks,
      images: images.length > 0 ? images : undefined,
      ...(unavailableImages.length > 0 ? { unavailableImages } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      seq: e.seq,
      time: e.time,
      ...(turn !== undefined ? { turn } : {}),
    };
    // 回填要等循环跑完（这一轮后面几步写的也要算进来），先把这条记下来。
    if (turn !== undefined) producedItems.push({ item, turn });
     // 这一轮模型显式声明的交付文件：轮尾那张交付卡的唯一依据（与产出的清单分开）。
    if (turn !== undefined) {
       const presented = presentedByTurn.get(turn);
       if (presented && presented.length > 0) item.presentedFiles = presented.map((file) => ({ ...file }));
     }
     // 单轮计时只挂 assistant 消息（user/message 无 step 计时）。
    if (item.role !== 'user') {
      const timing = timingOf(e);
      if (timing) item.timing = timing;
    }
    out.push(item);
    // 这一轮的过程清单挂在**开启这一轮的那条消息**上：App 的头条行按它派生。
    if (item.role === 'user') lastOpener = item;
  };

  /**
   * 这次压缩由哪条 slash 命令触发（`compaction/*` 上的 `sourceCommandId`）。
   *
   * 手动 `/compact` 时压缩行与命令行是同一件事的两半（桌面 `CompactionCommandCard` 只画一个
   * `CompactionItem`），靠这个 id 配对，见出循环后的「认领」。
   */
  const commandIdOf = (data) => (data && typeof data.sourceCommandId === 'string' && data.sourceCommandId !== ''
    ? data.sourceCommandId
    : null);

  // 放入一行 compaction：同一 compactionId 只保留一行，检查点行原地替换 start 行（最终按 seq 排序归位）。
  const placeCompaction = (item) => {
    let index = compactionAt.get(item.id);
    if (index === undefined) {
      index = out.length;
      out.push(item);
    } else out[index] = item;
    compactionAt.set(item.id, index);
    if (typeof item.turn === 'number') {
      const list = compactionTurns.get(item.turn);
      if (list === undefined) compactionTurns.set(item.turn, [index]);
      else if (!list.includes(index)) list.push(index);
    }
    return index;
  };

  // 同一轮里的多次压缩尝试只占一行：宿主一步重试一次、每次一个新 compactionId，按 id 找必然
  // 「每次都新增一条」——一次跑几十步就是一个回合几十条「正在压缩…」。新尝试顶替这一轮里还
  // 没落定的那条（running / failed），已经落地（done）的不顶替：那是真压过一次的记录。
  const pendingCompactionAt = (turn, id) => {
    if (compactionAt.has(id)) return compactionAt.get(id);
    if (typeof turn !== 'number') return -1;
    for (const index of compactionTurns.get(turn) || []) {
      const row = out[index];
      if (row && row.kind === 'compaction' && (row.state === 'running' || row.state === 'failed')) return index;
    }
    return -1;
  };

  for (const entry of events) {
    const e = entry.event || entry;
    const seq = e.seq;
    const time = e.time;
    // 工作流那四类事件不在这里就地折：攒起来整窗看（见 `workflowEntries`）。
    if (typeof e.type === 'string' && e.type.startsWith('tool-workflow/')) {
      workflowEntries.push(entry.event ? entry : { event: e });
      continue;
    }
    if (e.type === 'user/message' && e.data) {
      const msg = e.data;
      const src = msg.source;
      if (src && typeof src === 'object' && src.kind === 'plugin' && src.plugin === 'compact') {
        // 压缩检查点本身是一条 user/message，绝不能渲染成用户气泡，渲染成 compaction 行。
        const id = typeof src.compactionId === 'string' && src.compactionId !== ''
          ? src.compactionId
          : (msg.id != null ? String(msg.id) : null);
        if (id === null) continue;
        const s = summaries.get(id);
        // 触发命令的 id 在检查点自己的 source 上（桌面 `compactSource` 读的就是它）。只认
        // `compaction/*` 的 data 时，检查点先到 / 那些事件在窗口外就配不上命令行。
        const commandId = typeof src.sourceCommandId === 'string' && src.sourceCommandId !== '' ? src.sourceCommandId : null;
        placeCompaction({
          id,
          kind: 'compaction',
          state: 'done',
          summary: s ? compactionSummaryText(s.summary) : null,
          shadowedItemCount: s ? shadowedCount(s.shadowedSeqs) : null,
          shadowedTokenCount: s ? shadowedTokens(s.shadowedTokenCount) : null,
          ...shadowedTurnFields(s, turnIndex),
          ...(commandId ? { compactionCommandId: commandId } : {}),
          seq,
          time,
        });
        continue;
      }
      if (src && typeof src === 'object' && src.kind === 'schedule') {
        // 定时任务投递的提醒：桌面画成 `turn-trigger` 节点，手机这里落成一行 kind:'wake'
        // （与 App 的 userMessageOrigin 同口径，见 app/src/utils/structuralItems.ts）。
        // 以前把它并进下面那条「非 user 来源一律不下发」里丢掉，于是每一轮自动执行在重进
        // 会话后一点痕迹都没有。正文是宿主拼的提醒框架，原样收下、不解析。
        const wakeBlocks = parseBlocks(msg.content, toolResults);
        const wakeText = blocksToText(wakeBlocks);
        if (wakeText) {
          out.push({
            id: String(msg.id),
            kind: 'wake',
            wakeSource: 'schedule',
            text: wakeText,
            seq: e.seq,
            time: e.time,
          });
        }
        continue;
      }
      if (src && typeof src === 'object' && src.kind !== 'user') {
        // 上下文注入 / 召回一律不下发（2026-11-08 用户要求）：规则文件、开发地图提示、技能目录
        // 这些是宿主每轮自己塞给模型的说明书，召回也是模型视角的东西，画成折叠行只占地方。
        continue;
      }
      // 普通用户消息（source 缺失或 kind==='user'）沿用原折叠。
      pushMessage(msg, e);
    } else if (e.type === 'assistant/message' && e.data && e.data.message && e.data.message.content) {
      pushMessage(e.data.message, e);
    } else if (e.type === 'compaction/start' && e.data && typeof e.data.compactionId === 'string' && e.data.compactionId !== '') {
      // 行已由检查点发出（done）时跳过，避免重复行。同一轮里已有没落定的行就**原地顶替**
      // （换 id/状态，位置留在第一次尝试那一处）—— 否则一次跑几十步就是几十条行。
      const idx = pendingCompactionAt(e.data.turn, e.data.compactionId);
      const commandId = commandIdOf(e.data);
      if (idx < 0) {
        placeCompaction({
          id: e.data.compactionId,
          kind: 'compaction',
          state: 'running',
          summary: null,
          shadowedItemCount: null,
          shadowedTokenCount: null,
          seq,
          time,
          ...(typeof e.data.turn === 'number' ? { turn: e.data.turn } : {}),
          ...(commandId ? { compactionCommandId: commandId } : {}),
        });
      } else {
        const existing = out[idx];
        out[idx] = {
          ...existing,
          id: e.data.compactionId,
          state: 'running',
          error: null,
          ...(typeof e.data.turn === 'number' ? { turn: e.data.turn } : {}),
          ...(commandId ? { compactionCommandId: commandId } : {}),
        };
        compactionAt.set(e.data.compactionId, idx);
      }
    } else if (e.type === 'compaction/end' && e.data && typeof e.data.compactionId === 'string' && e.data.compactionId !== '') {
      // 这次尝试的落定：无 error → done（summary / 检查点随后补齐 counts）、有 error → failed
      // 带原因。这条以前整条丢掉，于是被拒绝的压缩永远停在「正在压缩…」，失败一次都看不见。
      const error = typeof e.data.error === 'string' && e.data.error !== '' ? e.data.error : null;
      const idx = pendingCompactionAt(e.data.turn, e.data.compactionId);
      const commandId = commandIdOf(e.data);
      // `compaction/end` 自己不带被压缩的 seq 清单：轮次区间照 checkpoints 的同一份预扫描
      // summary 取，口径与检查点那条一致（拿不到就整对不下发）。
      const endTurns = shadowedTurnFields(summaries.get(e.data.compactionId), turnIndex);
      if (idx < 0) {
        placeCompaction({
          id: e.data.compactionId,
          kind: 'compaction',
          state: error ? 'failed' : 'done',
          error,
          summary: null,
          shadowedItemCount: null,
          shadowedTokenCount: null,
          ...endTurns,
          seq,
          time,
          ...(typeof e.data.turn === 'number' ? { turn: e.data.turn } : {}),
          ...(commandId ? { compactionCommandId: commandId } : {}),
        });
      } else {
        const existing = out[idx];
        out[idx] = {
          ...existing,
          id: e.data.compactionId,
          state: error ? 'failed' : 'done',
          error,
          ...endTurns,
          ...(commandId ? { compactionCommandId: commandId } : {}),
        };
        compactionAt.set(e.data.compactionId, idx);
      }
    } else if (e.type === 'compaction/summary' && e.data && typeof e.data.compactionId === 'string' && e.data.compactionId !== '') {
      // 已有同 compactionId 的行（start 或检查点发出）→ 升级为 done 并补 counts；否则新增 done 行。
      const id = e.data.compactionId;
      const existing = compactionAt.has(id) ? out[compactionAt.get(id)] : null;
      const commandId = commandIdOf(e.data);
      // 轮次区间与条数取自同一份 `shadowedSeqs`：查不全时只是这两个字段不出现，条数照旧下发。
      const turns = shadowedTurnFields(e.data, turnIndex);
      if (existing) {
        existing.state = 'done';
        existing.error = null;
        existing.summary = compactionSummaryText(e.data.summary);
        existing.shadowedItemCount = shadowedCount(e.data.shadowedSeqs);
        existing.shadowedTokenCount = shadowedTokens(e.data.shadowedTokenCount);
        // 这一条这次没算出来（窗口外的 seq）时保留行上已有的区间，不拿空值抹掉。
        if (turns.shadowedTurnFrom !== undefined) existing.shadowedTurnFrom = turns.shadowedTurnFrom;
        if (turns.shadowedTurnTo !== undefined) existing.shadowedTurnTo = turns.shadowedTurnTo;
        if (commandId) existing.compactionCommandId = commandId;
      } else {
        placeCompaction({
          id,
          kind: 'compaction',
          state: 'done',
          summary: compactionSummaryText(e.data.summary),
          shadowedItemCount: shadowedCount(e.data.shadowedSeqs),
          shadowedTokenCount: shadowedTokens(e.data.shadowedTokenCount),
          ...turns,
          seq,
          time,
          ...(commandId ? { compactionCommandId: commandId } : {}),
        });
      }
    } else if (e.type === 'llm/retry' && e.data && typeof e.data.retryId === 'string' && e.data.retryId !== '' && typeof e.data.retry === 'number') {
      // 同 retryId 的后续重试（retry=2…）原地更新，保持一行。
      const id = e.data.retryId;
      const existing = retryAt.has(id) ? out[retryAt.get(id)] : null;
      if (existing) {
        existing.status = 'scheduled';
        existing.retry = e.data.retry;
        if (typeof e.data.maxRetries === 'number') existing.maxRetries = e.data.maxRetries;
        if (typeof e.data.delayMs === 'number') existing.delayMs = e.data.delayMs;
        existing.failure = retryFailure(e.data.failure);
      } else {
        const item = {
          id,
          kind: 'retry',
          status: 'scheduled',
          retry: e.data.retry,
          maxRetries: typeof e.data.maxRetries === 'number' ? e.data.maxRetries : null,
          failure: retryFailure(e.data.failure),
          seq,
          time,
          ...retryOwner(e.data),
        };
        if (typeof e.data.delayMs === 'number') item.delayMs = e.data.delayMs;
        retryAt.set(id, out.length);
        out.push(item);
      }
    } else if (e.type === 'llm/retry-started' && e.data && typeof e.data.retryId === 'string' && e.data.retryId !== '' && typeof e.data.retry === 'number') {
      const id = e.data.retryId;
      const existing = retryAt.has(id) ? out[retryAt.get(id)] : null;
      if (existing) existing.status = 'started';
      else {
        retryAt.set(id, out.length);
        out.push({
          id,
          kind: 'retry',
          status: 'started',
          retry: e.data.retry,
          maxRetries: typeof e.data.maxRetries === 'number' ? e.data.maxRetries : null,
          failure: null,
          seq,
          time,
          ...retryOwner(e.data),
        });
      }
    } else if (e.type === 'step/end' && e.data && typeof e.data.turn === 'number' && typeof e.data.step === 'number') {
      // 这一步关了就把它里面还停在 scheduled 的重试标成 cancelled（桌面 `isClosed` 判的也是这一步
      // 结束）。只认 turn/end 的话，重开这个会话会看到一条永远「等待重试」的旧行，和新的并排。
      for (const index of retryAt.values()) {
        const row = out[index];
        if (row && row.kind === 'retry' && row.status === 'scheduled'
          && row.turn === e.data.turn && row.step === e.data.step) row.status = 'cancelled';
      }
    } else if (e.type === 'command/run' && e.data && typeof e.data.commandId === 'string' && e.data.commandId !== '' && typeof e.data.name === 'string') {
      // 命令行：root 行（running）。同 commandId 重复 run（罕见）只更新位置字段。
      const id = e.data.commandId;
      const item = { id, kind: 'command', name: e.data.name, status: 'running', seq, time };
      const existing = commandAt.has(id) ? out[commandAt.get(id)] : null;
      if (existing) Object.assign(existing, { status: 'running', seq, time });
      else {
        commandAt.set(id, out.length);
        out.push(item);
      }
    } else if (e.type === 'command/done' && e.data && typeof e.data.commandId === 'string' && e.data.commandId !== '') {
      // 升级同 commandId 行（name 保 run 的）；done 先到（罕见）则按 done 内容建行。
      const id = e.data.commandId;
      // `id` 必须落在行上：done 先到（增量窗口从命令行尾巴开始时就是这种）时这条行是新建的，
      // 没有 id 的话 App 按 id 合并就配不上那半截 run 行 —— 屏幕上会多出一行「命令 · …」。
      const done = { id, kind: 'command', status: 'done', seq, time };
      if (e.data.kind === 'error' || e.data.kind === 'success') done.resultKind = e.data.kind;
      if (typeof e.data.text === 'string' && e.data.text !== '') done.text = e.data.text;
      const existing = commandAt.has(id) ? out[commandAt.get(id)] : null;
      if (existing) Object.assign(existing, done);
      else {
        commandAt.set(id, out.length);
        out.push(done);
      }
    } else if (e.type === 'turn/end' && e.data && e.data.reason && e.data.turn != null) {
      // turn/end 每轮一次，一条消息只对应一条行：error → turn-error；max-tokens → max-tokens；
      // aborted → turn-aborted；其余 kind 忽略。
      if (e.data.reason.kind === 'error') {
        const err = e.data.reason.error;
        if (!err || typeof err.message !== 'string') continue;
        const item = { id: `turn-${e.data.turn}`, kind: 'turn-error', message: err.message, seq, time };
        if (typeof err.code === 'string' && err.code !== '') item.code = err.code;
        out.push(item);
      } else if (e.data.reason.kind === 'max-tokens') {
        out.push({ id: `turn-${e.data.turn}`, kind: 'max-tokens', seq, time });
      } else if (e.data.reason.kind === 'aborted') {
        // 用户点了停止（或被宿主打断）。这一行不带正文，只让 App 把那一轮标成「已停止」并摊开：
        // 桌面口径是 aborted / error 不折叠，App 收不到这个信号就只能当成正常结束，把整轮收进
        // 一行「已完成，用时 …」里 —— 跑了几十步、最后没有收尾答复的那一轮会整轮从屏幕上消失。
        out.push({ id: `turn-${e.data.turn}`, kind: 'turn-aborted', seq, time });
      }
    }
    // tool/result 等其余类型照旧忽略（工具结果在预扫描里配对回填；compaction 行由 start/end 发出）。
  }
  // 过程清单按轮回填：`steps` 只带摘要与位置，正文要用户点开某一步时再去取。
  if (stepsByTurn.size > 0) {
    for (const [turn, steps] of stepsByTurn) {
      const opener = openerByTurn.get(turn);
      if (!opener || steps.length === 0) continue;
      opener.turnProcess = {
        ...(opener.turnProcess && typeof opener.turnProcess === 'object' ? opener.turnProcess : {}),
        count: steps.length,
        steps,
        ...(Number.isSafeInteger(opener.seq) ? { startSeq: opener.seq } : {}),
      };
    }
  }
  /**
   * 这一轮出过的图也按轮回填到**最后一条正文**上。
   *
   * 倒着翻页时，工具结果（图在这里）的 seq 往往比这条正文更早 —— 那一页后到，正文先上屏，
   * 于是这一行先按「没图」的高度排好，等下一页把图带回来才长高；它在用户头顶上，一长高就把
   * 正看的内容推走。`lookbackEvents` 里已经能看到这一轮的结果，就先挂到正文那条上（与 App
   * `chatRenderRows` 的 settleImages 同口径），行在挂载那一帧就是终高。
   */
  if (producedItems.length > 0) {
    const byTurn = collectTurnImages(events, lookbackEvents);
    for (const [turn, images] of byTurn) {
      // 这一轮已经有消息带图（工具调用那条就在这一页里）：别重复挂，App 那边也会去重。
      if (producedItems.some((entry) => entry.turn === turn && (entry.item.images?.length ?? 0) > 0)) continue;
      const carriers = producedItems.filter((entry) => entry.turn === turn && entry.item.role !== 'user' && entry.item.text);
      const last = carriers[carriers.length - 1];
      if (last) last.item.images = images;
    }
  }
  // 所属轮每个可见载体都带轻量事实，薄入口即使只剩用户行/失败行也不会丢产出。
  for (const item of out) {
    const turn = typeof item.turn === 'number' ? item.turn : turnOfSeq(item.seq, turnIndex.bySeq, turnIndex.starts);
    const facts = factsByTurn.get(turn);
    if (!facts) continue;
    if (turn !== null && turn !== undefined) item.turn = turn;
    Object.assign(item, turnFactsSnapshot(facts));
  }
  // 手动 `/compact` 在桌面上是**一件事**：`CompactionCommandCard` 只画一个 `CompactionItem`
  // （标题取命令名，摘要位放条数与 token 数，条数不齐时放命令结果原文），命令行那块根本不出现。
  // 宿主的 command/run·done 与压缩检查点由 `sourceCommandId` 连在一起，所以这里让压缩行认领
  // 命令行：压缩行继承命令名，命令行整条不发给手机 —— 否则屏幕上会多出一行「命令 ·
  // Compacted N history items」（名字在增量窗口里丢了就掉成「命令」，摘要是宿主 en locale 的
  // 英文原句，手机不本地化）。
  const commandNames = new Map();
  for (const item of out) {
    if (!item || item.kind !== 'command') continue;
    const entry = {};
    if (typeof item.name === 'string' && item.name !== '') entry.name = item.name;
    if (typeof item.text === 'string' && item.text !== '') entry.text = item.text;
    if (entry.name !== undefined || entry.text !== undefined) commandNames.set(item.id, entry);
  }
  const claimedCommands = new Set();
  for (const item of out) {
    if (!item || item.kind !== 'compaction') continue;
    const commandId = item.compactionCommandId;
    if (typeof commandId !== 'string' || commandId === '') continue;
    const paired = commandNames.get(commandId);
    // 标题取命令名；命令行那半截不在窗口里也写 compact —— 只有 /compact 能触发压缩，桌面
    // `fallbackState` 同样把名字兜成 'compact'，否则这一行会掉回「上下文已压缩」。
    item.compactionTitle = paired && paired.name !== undefined ? paired.name : 'compact';
    // 条数不齐时摘要位用命令结果原文顶上（桌面 `fallbackSummary: node.outcome?.text`）。
    if (paired && paired.text !== undefined && (item.shadowedItemCount == null || item.shadowedTokenCount == null)) {
      item.compactionFallbackSummary = paired.text;
    }
    claimedCommands.add(commandId);
  }
  if (claimedCommands.size > 0) {
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const item = out[index];
      if (item && item.kind === 'command' && claimedCommands.has(item.id)) out.splice(index, 1);
    }
  }
  // 压缩行带一个空正文：直播侧的同款行本来就带 `text: ''`（App 的 `structuralItems`
  // 一条不落），历史这边少这一格时，没跟上判空修复的旧安装包会在这条行上直接读正文、
  // 当场抛错、整页崩掉（2026-10-27 真机）。标题与摘要照旧按 kind 走，不读这个字段；
  // 其它结构行刻意不带（与 `history-turn-end` 守卫钉的形状一致）。
  for (const item of out) {
    if (item.kind === 'compaction' && typeof item.text !== 'string') item.text = '';
  }
  // 工作流运行：`tool-workflow/*` 折成「运行 → 阶段 → 成员」三层（形状与桌面 `workflow-run`
  // 节点一致，见 `workflow-runs.js`）。这些事件原先整族没人认、手机上一张卡都不出现。
  //
  // 「被撇下」按**开启这次运行的那一轮**判：历史窗口里可能横跨好几轮，只有那一轮是被中断 /
  // 分叉的，这条运行才再也不会长（桌面的 `turnAbandoned` 读的正是 run-start 所在那一轮的
  // `turn.end.reason`）。所以逐条给 runId，不能整批按「当前这一轮」算。
  if (workflowEntries.length > 0) {
    const abandonedTurns = new Set();
    for (const entry of events) {
      const e = entry.event || entry;
      if (!e || e.type !== 'turn/end' || !e.data || typeof e.data.turn !== 'number') continue;
      const reason = e.data.reason && e.data.reason.kind;
      if (reason === 'interrupted' || reason === 'forked') abandonedTurns.add(e.data.turn);
    }
    const abandonedRunIds = [];
    if (abandonedTurns.size > 0) {
      for (const entry of events) {
        const e = entry.event || entry;
        if (!e || e.type !== 'tool-workflow/run-start' || !e.data) continue;
        const turn = turnOfSeq(e.seq, turnIndex.bySeq, turnIndex.starts);
        if (turn !== null && abandonedTurns.has(turn) && e.data.runId !== undefined) {
          abandonedRunIds.push(String(e.data.runId));
        }
      }
    }
    const workflowRows = abandonedRunIds.length > 0
      ? deriveWorkflowRuns(workflowEntries, { abandonedRunIds })
      : deriveWorkflowRuns(workflowEntries);
    for (const row of workflowRows) out.push(row);
  }
  // 严格按事件 seq 升序（与消息混排；compaction 行升级/替换后位置以最终事件为准）。
  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));  // 存进缓存的是**已经排好序的最终结果**：调用方拿到的是同一份引用，拿去 filter / map 都好，
  // 但不要再就地改（要改就先拷一份）。见 shared/derived-cache.js 的说明。
  if (cacheKey) derivedCache.set(sessionId, cacheKey, out);
  return out;
}

/**
 * 入口窗口的「内容化」裁剪（`GET /session/messages?thin=1`，只对不带 beforeSeq / afterSeq 的
 * 一次性入口窗口生效；往上翻页与增量补拉保持完整）。
 *
 * 入口原来按「消息条数」截尾巴，而宿主每跑一个 agent 步就落一条 assistant 消息，长回合最后
 * 几十条可能全是过程消息，用户自己那句话被挤出窗口。现在按「轮」分组，只留用户消息、助手
 * 正文、带图消息与结构化行；过程明细不下发，每轮裁掉多少项挂在开头那条用户消息的
 * `turnProcess` 上，点开时按 startSeq / endSeq 回头要那一轮的事件。
 *
 * 窗口最老那一组没有起点（截断正好切在一轮中间）时整组丢掉，否则会画出「凭空冒出的 AI
 * 发言」，它会被「加载更早」整轮补回。
 *
 * 三种「出卡」工具（定时任务 / 计划 / 扩展卡）的调用块要留一条，轮尾那几张卡是从工具块现算
 * 的，整块丢掉会让卡凭空不见。新增一种轮尾卡时要同步这里。
 */
const ENTRY_OUTCOME_TOOLS = new Set(['schedule_create', 'exit_plan_mode', 'extension_present']);

/**
 * 入口窗口里除了出卡工具还要留一行的：`todo_write` 的瘦身块。
 *
 * 不并进 `ENTRY_OUTCOME_TOOLS` —— 那个集合的全部含义是「轮尾卡要解析的原文」，塞进去以后
 * 谁再加一种轮尾卡都会顺手误会。这里留它是因为它不吃「原文」：`parseBlocks` 已经把它换成了
 * `todo-phases.js` 的最小投影（`[{c,s}]` + `phase`），一行几十个字。不单独放行的话，刚点进
 * 会话（入口走 thin=1）时最近几轮的阶段行会整片消失，只有往上翻、走完整分页才又出现。
 */
const ENTRY_PHASE_TOOLS = new Set(['todo_write']);

/**
 * 一轮的起点：用户自己发的消息，或定时任务唤醒的那一行。
 *
 * 注入行不再是起点：它们已经不下发了，再认它当起点只会留下一组没有可画内容的行。
 */
function isEntryTurnOpener(item) {
  return Boolean(item) && typeof item === 'object'
    && (item.role === 'user' || item.kind === 'wake');
}

function thinEntryMessages(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const hasMore = options.hasMore === true;
  const groups = [];
  let group = null;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (isEntryTurnOpener(item) || group === null) {
      group = { opener: isEntryTurnOpener(item) ? item : null, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  const out = [];
  for (let index = 0; index < groups.length; index += 1) {
    const { opener, items: groupItems } = groups[index];
    // 最老那半轮：没有用户消息当起点，整组丢掉（交给「加载更早」）。整页只有这一组时不丢 ——
    // 那是「单独一轮就超过入口上限」的极端形状，丢了等于入口全空，宁可先摊开这一轮的文字。
    if (opener === null && hasMore && index === 0 && groups.length > 1) continue;
    let processCount = 0;
    let hasKeptAssistant = false;
    const kept = [];
    for (const item of groupItems) {
      // 结构化行与唤醒行原样保留：体量小，而且「已停止 / 处理失败 / 已压缩」是这一轮的状态。
      if (isEntryTurnOpener(item) || item.kind !== undefined) {
        kept.push(item);
        continue;
      }
      if (item.role === 'user') { kept.push(item); continue; }
      if (item.role !== 'assistant') { kept.push(item); continue; }
      const blocks = Array.isArray(item.blocks) ? item.blocks : [];
      const keptBlocks = [];
      let stripped = 0;
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        // **每一个过程块都记进 processCount**，包括因为要出轮尾卡而留下的那几个 ——
        // 这个数是给 App 的「这一轮一共多少项过程」用的，它按自己派生出的过程项递减；
        // 只数「被摘掉的」会让保留的那几块扣不掉，App 那边提前减到 0、加载入口消失，
        // 真正没载入的过程反倒没处点了。
        // 空推理块在 deriveMessages 里就被丢掉了（`parseBlocks` 只留有文字的），这里也
        // 不能数 —— 数了 App 就少扣一项，那一轮的加载入口永远差着数。
        if (block.type === 'reasoning') {
          if (typeof block.text === 'string' && block.text) { processCount += 1; stripped += 1; }
          continue;
        }
        if (block.type === 'tool-call') {
          // 计数照记：留下的那几块（轮尾卡 + 阶段行）也是这一轮的过程项，App 那边照样要
          // 拿 processCount 扣掉它们，只数被摘掉的会让加载入口提前消失。
          processCount += 1;
          const keepsOneRow = typeof block.name === 'string'
            && (ENTRY_OUTCOME_TOOLS.has(block.name) || ENTRY_PHASE_TOOLS.has(block.name));
          if (keepsOneRow) keptBlocks.push(block);
          else stripped += 1;
          continue;
        }
        keptBlocks.push(block);
      }
      const hasText = typeof item.text === 'string' && item.text !== '';
      const hasContent = hasText
        || keptBlocks.some((block) => block.type === 'image' || block.type === 'tool-call')
        || (Array.isArray(item.images) && item.images.length > 0)
        || (Array.isArray(item.unavailableImages) && item.unavailableImages.length > 0);
      if (!hasContent) continue;
      kept.push(stripped > 0 ? { ...item, blocks: keptBlocks } : item);
      hasKeptAssistant = true;
    }
    // 一轮里一条助手消息都没留下（整轮只在跑工具、被停止）：交付声明照样得留个落脚处。
    if (opener !== null && !hasKeptAssistant) {
      const presented = groupItems
        .filter((item) => Array.isArray(item.presentedFiles) && item.presentedFiles.length > 0)
        .flatMap((item) => item.presentedFiles);
      if (presented.length > 0) {
        const at = kept.indexOf(opener);
        if (at >= 0) kept[at] = { ...opener, presentedFiles: presented };
      }
    }
    if (opener !== null && processCount > 0 && Number.isSafeInteger(opener.seq)) {
      const last = groupItems[groupItems.length - 1];
      const endSeq = Number.isSafeInteger(last.seq) ? last.seq : opener.seq;
      const at = kept.indexOf(opener);
      if (at >= 0) {
        // 清单（`steps`）随入口窗口一起下发：过程正文不在线上，这一行摘要就是用户
        // 「值不值得点开」的全部依据，摘掉它这一轮就没法点开了。
        const steps = opener.turnProcess && Array.isArray(opener.turnProcess.steps)
          ? opener.turnProcess.steps
          : null;
        kept[at] = {
          ...kept[at],
          turnProcess: {
            startSeq: opener.seq,
            endSeq,
            count: steps ? steps.length : processCount,
            ...(typeof last.time === 'number' ? { endTime: last.time } : {}),
            ...(steps ? { steps } : {}),
          },
        };
      }
    }
    for (const item of kept) out.push(item);
  }
  return out;
}

// 信封拆解的唯一实现在 lib/mobile/envelope.js。这里只是为了让既有
// `require('./history-derive.js').unwrap` 继续可用（对外导出面不变）。
const { unwrap } = require('./envelope.js');

const MODEL_UNAVAILABLE_ERROR = {
  code: 'model-unavailable',
  message: '当前没有可用的模型，请先在模型选择器中选择一个可用模型',
};

/**
 * 宿主错误的 details 原样透传。移动端据此把 attachment-error 映射成中文提示，
 * 读的是与桌面端 attachmentErrorText 同一个 details.reason 契约
 * （MODEL_DOES_NOT_SUPPORT_IMAGES / TOO_MANY_IMAGES / IMAGE_TOO_LARGE …）。
 * 只接受纯对象：Error 实例、数组一律丢弃，避免污染 JSON 响应。
 */
function errorDetails(error) {
  const details = error && typeof error === 'object' ? error.details : undefined;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const proto = Object.getPrototypeOf(details);
  if (proto !== Object.prototype && proto !== null) return undefined;
  return details;
}

function promptErrorObject(error) {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? error.message : '';
    const text = `${code} ${message}`.toLowerCase();
    if (
      ['no-model', 'model-unavailable', 'model-not-found', 'model-not-routable', 'no-provider', 'provider-unavailable', 'not-routable'].includes(code.toLowerCase())
      || /no (?:usable |available |selected |configured )?model|model[^\n]*(?:unavailable|not found|not configured|not routable|missing|required)|no provider|provider[^\n]*(?:unavailable|not found|not configured|missing|required)|没有(?:可用的)?模型|模型[^\n]*(?:不可用|未配置|不存在|缺失|必需)|提供商[^\n]*(?:不可用|未配置|缺失)/i.test(text)
    ) return { ...MODEL_UNAVAILABLE_ERROR };
    if (code || message) {
      const details = errorDetails(error);
      return {
        ...(code ? { code } : { code: 'prompt-failed' }),
        message: message || '消息发送失败',
        ...(details ? { details } : {}),
      };
    }
  }
  const message = error instanceof Error ? error.message : String(error || '');
  const text = message.toLowerCase();
  if (/no (?:usable |available |selected |configured )?model|no provider|没有(?:可用的)?模型|模型[^\n]*(?:不可用|未配置|不存在|缺失)/i.test(text)) return { ...MODEL_UNAVAILABLE_ERROR };
  return { code: 'prompt-failed', message: message || '消息发送失败' };
}

/**
 * 移动端提示词用的 rpcId 前缀。宿主把 source.rpcId 原样回带在 user 消息上，
 * 移动端据此把乐观行和历史里的真消息对上号。
 */
const MOBILE_PROMPT_RPC_PREFIX = 'mobile:';

/**
 * 从 user 消息里取回移动端的 clientMessageId。优先用显式字段；老宿主只把它塞在
 * source.rpcId 里，两条路都认，历史重同步才不会把乐观行变成重复行。
 */
function clientMessageIdFromSource(source, message) {
  if (message && typeof message.clientMessageId === 'string' && message.clientMessageId) return message.clientMessageId;
  if (!source || typeof source !== 'object' || source.kind !== 'user' || typeof source.rpcId !== 'string') return undefined;
  return source.rpcId.startsWith(MOBILE_PROMPT_RPC_PREFIX)
    ? source.rpcId.slice(MOBILE_PROMPT_RPC_PREFIX.length) || undefined
    : undefined;
}

module.exports = {
  listTitle,
  presentedPathsOf,
  deriveMessages,
  thinEntryMessages,
  unwrap,
  errorDetails,
  promptErrorObject,
  MODEL_UNAVAILABLE_ERROR,
  buildToolResultMap,
  toolResultPatchesFor,
  parseBlocks,
  blocksToText,
  userVisibleText,
  lastMessageOf,
  MOBILE_PROMPT_RPC_PREFIX,
  clientMessageIdFromSource,
};
