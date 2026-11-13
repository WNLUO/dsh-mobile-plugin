'use strict';

/**
 * 工作流运行记录：把宿主的四条 `tool-workflow/*` 事件折成一张**树**交给手机。
 *
 * 桌面那边（`@deepseek-ai/dsh-client-ui-workflow-run` 的 `workflowRunDefinition`）把同一族事件
 * 折成一个 `workflow-run` 节点，形状是**运行 → 阶段 → 成员**三层，不是一张平铺的步骤清单。
 * 手机照这个形状下发，渲染层才画得出「哪个阶段的哪几个成员还在跑」。
 *
 * 四条事件（`packages/workflow/tool-workflow/src/types.ts`）：
 *   run-start   { runId, name }
 *   agent-start { runId, seq, label, phase?, childId }
 *   agent-end   { runId, seq, outcome: completed | failed | cancelled }
 *   run-end     { runId, stopReason: completed | error | cancelled }
 *
 * 三条口径与桌面逐条对齐（改之前先读 `workflow-definition.ts` 的 `projectWorkflow`）：
 *
 * ① **状态只认「落定」与「被放弃」两种证据**。成员的 `outcome` 到了才算它结束；整条运行的
 *    `stopReason` 到了才算这条运行结束。都没有的时候不能凭「这一步的工具调用结束了」判活 ——
 *    后台跑的工作流能活过开启它的那一步，前台跑的那条会先写 run-end 再结束工具调用。
 *    唯一的例外是**这一轮被中断 / 分叉**（`turn.end.reason` 是 `interrupted` / `forked`）：
 *    那种情况下运行记录再也不会长，没写 run-end 就是被撇下了，落 `interrupted`。
 * ② **阶段是一个独立的身份**：`phase` 字段没给（`undefined`）与给了空串是两回事，前者是
 *    「未分阶段」一档，后者是一档名叫空的阶段 —— 桌面用 `workflowPhaseKey` 把两者分开，
 *    这里同样用键区分，别用 `phase || '未分阶段'` 把它们并成一组。
 * ③ **成员按 `seq` 认，不按标签**：同名成员可以并存（同一个 agent 跑两次），标签是给人看的。
 *
 * 这一层只管形状，不碰 ctx、不发 RPC —— 与 `history-derive.js` 同一分工，守卫能裸 Node 跑。
 */

/** 成员行的状态：还在跑 / 已完成 / 失败 / 已取消 / 被撇下。 */
const MEMBER_RUNNING = 'running';
const MEMBER_INTERRUPTED = 'interrupted';

/** 一条运行的终态：`stopReason` 的字面量 → 手机这一层认的词。 */
const RUN_STATUS_FROM_STOP = {
  completed: 'completed',
  error: 'failed',
  cancelled: 'cancelled',
};

/** 一个成员的 outcome → 手机这一层认的词。 */
const MEMBER_STATUS_FROM_OUTCOME = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * 阶段键：把「缺省」与「空串」分开，同时避免任何 phase 名字撞上这两档。
 *
 * 与桌面 `workflowPhaseKey` 同一条口径（`'missing'` / `value:<长度>:<名字>`）—— 长度前缀
 * 让 `value:1:a` 这种名字不会被当成另一组，也就不用去转义。
 */
function phaseKeyOf(phase) {
  if (phase === undefined) return 'missing';
  return `value:${phase.length}:${phase}`;
}

/**
 * 从一批会话事件里折出这次调用要下发的工作流行。
 *
 * @param {ReadonlyArray<{event?: object}>} entries 会话事件（history 那条路一个窗口，
 *   直播那条路是这次进来的事件本身 —— 两边形状一致，都是 `{ event }` 或裸事件）。
 * @param {object} [options]
 * @param {boolean} [options.interrupted] 这些运行全部按「被撇下」处理（见口径 ①）。直播间那条路
 *   只在**当前这一轮**被中断时用，所以它是整批的。
 * @param {Iterable<string>} [options.abandonedRunIds] 逐条指定哪些 runId 被撇下。历史那条路
 *   一个窗口里可能横跨好几轮，只有「开启它的那一轮被中断」的那几条才算，所以按 id 给。
 * @returns {Array<object>} 每一行是一个 `ChatMessage`：`{ id, kind: 'workflow', workflow }`，
 *   按 run-start 的出现位置排序，`seq` 取那一刻的事件位置。**同一 runId 只出一行**，
 *   后面的事件都并进那一行（桌面也是「一条运行一个节点」）。
 */
function deriveWorkflowRuns(entries, options) {
  const interrupted = Boolean(options && options.interrupted);
  /** runId → { index, run }：index 是它在 out 里的位置，run 是正在攒的那份。 */
  const byRun = new Map();
  const out = [];
  // 成员按 seq 认：runId + seq。同一个 seq 被两次 agent-start 认领属于畸形数据，
  // 后到的直接覆盖（桌面也是 Map 语义，不叠成两条）。
  for (const entry of entries || []) {
    const e = entry && entry.event ? entry.event : entry;
    if (!e || typeof e.type !== 'string') continue;
    if (e.type !== 'tool-workflow/run-start'
      && e.type !== 'tool-workflow/agent-start'
      && e.type !== 'tool-workflow/agent-end'
      && e.type !== 'tool-workflow/run-end') continue;
    const data = e.data;
    if (!data || typeof data !== 'object') continue;
    const runId = data.runId === undefined || data.runId === null ? '' : String(data.runId);
    if (runId === '') continue;

    if (e.type === 'tool-workflow/run-start') {
      // 同一条运行重开（罕见，但宿主不保证）就地换掉那一行，不要多出一张卡。
      const run = {
        id: runId,
        name: typeof data.name === 'string' && data.name !== '' ? data.name : '',
        status: MEMBER_RUNNING,
        phases: [],
      };
      const existing = byRun.get(runId);
      if (existing) {
        out[existing.index] = { id: `workflow-${runId}`, kind: 'workflow', workflow: run, seq: e.seq, time: e.time };
      } else {
        byRun.set(runId, { index: out.length, run });
        out.push({ id: `workflow-${runId}`, kind: 'workflow', workflow: run, seq: e.seq, time: e.time });
      }
      continue;
    }

    const holder = byRun.get(runId);
    // 没收到 run-start 就来的成员 / 结束事件：窗口截断（拉历史只回最近几十条）——
    // 这时**不无中生有造一条运行**，文件名与阶段都缺，画出来是张空卡。
    if (!holder) continue;
    const run = holder.run;

    if (e.type === 'tool-workflow/agent-start') {
      const seq = typeof data.seq === 'number' ? data.seq : null;
      if (seq === null) continue;
      const rawPhase = data.phase === undefined ? undefined : (typeof data.phase === 'string' ? data.phase : '');
      const key = phaseKeyOf(rawPhase);
      let group = run.phases.find((item) => item.key === key);
      if (!group) {
        group = { key, phase: rawPhase === undefined ? null : rawPhase, members: [] };
        run.phases.push(group);
      }
      const member = {
        seq,
        label: typeof data.label === 'string' ? data.label : '',
        status: MEMBER_RUNNING,
        // childId 落 String：App 拿它 push 子会话，类型上必须是串。
        childId: data.childId === undefined || data.childId === null ? '' : String(data.childId),
      };
      const at = group.members.findIndex((item) => item.seq === seq);
      if (at === -1) group.members.push(member);
      else group.members[at] = member;
      continue;
    }

    if (e.type === 'tool-workflow/agent-end') {
      const seq = typeof data.seq === 'number' ? data.seq : null;
      if (seq === null) continue;
      const status = MEMBER_STATUS_FROM_OUTCOME[data.outcome] || MEMBER_RUNNING;
      for (const group of run.phases) {
        const member = group.members.find((item) => item.seq === seq);
        if (member) {
          member.status = status;
          break;
        }
      }
      continue;
    }

    // run-end
    run.status = RUN_STATUS_FROM_STOP[data.stopReason] || MEMBER_RUNNING;
  }

  // 被撇下的那一档（口径 ①）：整条运行没有 run-end、又有中断证据时，运行与它下面还在
  // 「running」的成员一起落 interrupted。已经落定的成员不动 —— 它们真跑完了。
  const abandoned = options && options.abandonedRunIds ? new Set(options.abandonedRunIds) : null;
  if (interrupted || (abandoned && abandoned.size > 0)) {
    for (const item of out) {
      const run = item.workflow;
      if (run.status !== MEMBER_RUNNING) continue;
      const dropped = abandoned === null ? interrupted : abandoned.has(run.id);
      if (!dropped) continue;
      run.status = MEMBER_INTERRUPTED;
      for (const group of run.phases) {
        for (const member of group.members) {
          if (member.status === MEMBER_RUNNING) member.status = MEMBER_INTERRUPTED;
        }
      }
    }
  }

  return out;
}

/**
 * 一条运行里所有成员（先按阶段顺序、再按 seq）。渲染层数「几个成员 / 几个还在跑」用它。
 */
function workflowMembers(run) {
  const members = [];
  for (const group of (run && run.phases) || []) {
    for (const member of group.members || []) members.push(member);
  }
  return members;
}

module.exports = {
  deriveWorkflowRuns,
  workflowMembers,
  phaseKeyOf,
};
