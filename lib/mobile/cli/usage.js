'use strict';

/**
 * 一轮用掉多少 —— ACP 报上来的用量，翻成对话页底部那行指标认识的形状。
 *
 * 两个来源，都是协议里现成的，不去猜：
 *
 *   - `usage_update` 通知：`used` / `size` 是**上下文窗口**占了多少（两家都给，opencode 实测
 *     每轮末尾发一条，`size` 20 万）；
 *   - `session/prompt` 的回包：`usage` 里是**整条会话累计**的输入 / 输出 / 缓存读写 token
 *     （`inputTokens` 明确写着「across all turns」）。
 *
 * 手机上那行指标要三项：token 速度、缓存命中率、上下文占用。对应关系——
 *
 *   - 上下文占用 = `used` / `size`；
 *   - 缓存命中率 = cacheRead / (uncached + cacheRead + cacheWrite)，与宿主那条 `cacheHitPercent`
 *     同一个公式（那一份在 App 里，插件这边照抄口径，不另立一套）；
 *   - token 速度 = 这一轮的输出 token / 这一轮花的时间。
 *
 * 报不上来的就是**没有**，不补零：`usage_update` 一次都没来过（有的适配器不发）时不给
 * `contextPressure`，指标行自然少一段，而不是显示「上下文 0%」。
 */

/** 每个会话一份，挂在 session 对象上（会话收掉时一起没）。 */
function createUsage() {
  return {
    /** 上下文：最近一次 `usage_update`。 */
    used: null,
    size: null,
    /** prompt 回包里的累计用量（最后一次见到的为准）。 */
    prompt: null,
    /** 上一轮 prompt 的累计快照：两个相减就是这一轮的量。 */
    previous: null,
    /** 累计轮数与耗时。 */
    turns: 0,
    llmMs: 0,
    /** 上一轮的输出量与耗时（token 速度用它）。 */
    decodeTokens: 0,
    decodeMs: 0,
  };
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `usage_update` 通知 → 上下文占用。 */
function applyUsageUpdate(usage, update) {
  const used = num(update && update.used);
  const size = num(update && update.size);
  if (used !== null) usage.used = used;
  if (size !== null && size > 0) usage.size = size;
  return used !== null || size !== null;
}

/**
 * 一轮结束：记下这一轮的输出量与耗时，并把累计用量换成回包那一份。
 *
 * `elapsedMs` 是从发出 prompt 到它 resolve 的墙钟时间 —— ACP 不给逐轮的耗时，这是唯一
 * 拿得到的口径，所以「token 速度」这一项是**整轮平均**，不是解码瞬时速度。够用：这一行
 * 存在的意义是「快不快」，不是基准测试。
 */
function applyPromptUsage(usage, result, elapsedMs) {
  const next = result && result.usage;
  const elapsed = num(elapsedMs) || 0;
  if (next && typeof next === 'object') {
    const prev = usage.prompt;
    const output = num(next.outputTokens);
    const prevOutput = prev ? (num(prev.outputTokens) || 0) : 0;
    usage.decodeTokens = output === null ? 0 : Math.max(0, output - prevOutput);
    usage.prompt = {
      inputTokens: num(next.inputTokens),
      outputTokens: output,
      totalTokens: num(next.totalTokens),
      cachedReadTokens: num(next.cachedReadTokens),
      cachedWriteTokens: num(next.cachedWriteTokens),
      thoughtTokens: num(next.thoughtTokens),
    };
  }
  if (elapsed > 0) {
    usage.llmMs += elapsed;
    // 没有累计用量时（适配器不回 `usage`）至少还能给一个耗时：单看它也说明这一轮多久。
    usage.decodeMs = usage.decodeTokens > 0 ? elapsed : 0;
  }
  usage.turns += 1;
  usage.previous = usage.prompt;
}

/** 缓存命中率（整数百分比）；没有输入计费量时 null（与 App 的 `cacheHitPercent` 同一个分支）。 */
function cacheHitPercent(cacheRead, billed) {
  return billed === 0 ? null : Math.round((cacheRead / billed) * 100);
}

/**
 * 会话 → `/session/stats` 的投影。
 *
 * 只给**真有数的**那几项，其余不出现（App 那边缺席就是「没有」，不会画成 0）。
 */
function statsOf(usage) {
  const out = {};
  const prompt = usage.prompt;
  if (prompt && prompt.inputTokens !== null) {
    const cachedRead = prompt.cachedReadTokens || 0;
    const cachedWrite = prompt.cachedWriteTokens || 0;
    out.tokenUsage = {
      // ACP 的 `inputTokens` 是**含缓存**的总输入，App 那边三个桶是分开的（`uncached` 是
      // 真正新读的那部分），所以这里减掉两个缓存桶，别把缓存算成新读。
      uncachedInputTokens: Math.max(0, prompt.inputTokens - cachedRead - cachedWrite),
      outputTokens: prompt.outputTokens || 0,
      cacheReadTokens: cachedRead,
      cacheWriteTokens: cachedWrite,
    };
  }
  if (usage.used !== null && usage.size !== null) {
    out.contextPressure = { contextWindow: usage.size, pressureTokens: usage.used };
  }
  if (usage.turns > 0) {
    out.sessionStats = {
      turns: usage.turns,
      // 这一版不认工具调用耗时与首字延迟：ACP 不给，编一个比空着更糟。
      steps: 0,
      llmMs: usage.llmMs,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: usage.decodeMs,
      decodeTokens: usage.decodeTokens,
    };
  }
  return out;
}

module.exports = { createUsage, applyUsageUpdate, applyPromptUsage, statsOf, cacheHitPercent };
