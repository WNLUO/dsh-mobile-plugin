// AI 在生成前登记固定比例卡，完成后以相同任务编号交付原件。
'use strict';
const fs = require('node:fs');
function registerMediaTool(ctx, service) {
  const { defineTool } = require('@deepseek-ai/dsh-tools');
  return ctx.tools.register(defineTool({
    name: 'mobile_media',
    description: 'Track image or video generation for the mobile app. Begin before invoking any generator, then deliver its original file or HTTP download URL with the returned taskId. Updates and previews replace the same fixed-ratio card. A successful deliver means the original has been copied durably on this computer; it does not change ordinary desktop delivery. Never send API keys in tool arguments: download privately with the generating plugin and deliver the local file instead.',
    parameters: {
      action: { type: 'string', required: true, enum: ['begin', 'update', 'preview', 'deliver', 'retry', 'fail', 'cancel', 'list'] },
      taskId: { type: 'string', description: 'Task returned by begin; required except begin and list.' },
      kind: { type: 'string', enum: ['image', 'video'], description: 'Required for begin.' },
      title: { type: 'string', description: 'Brief description of this media.' },
      aspectRatio: { type: 'string', description: 'Requested width:height when known; omit if the generator chooses automatically.' },
      key: { type: 'string', description: 'Stable per-result key within this turn to avoid duplicate begin calls.' },
      path: { type: 'string', description: 'Existing original file in the execution filesystem; relative paths use the conversation working directory.' },
      url: { type: 'string', description: 'HTTP(S) media download URL, including temporary signed URLs; not a preview webpage or browser blob URL.' },
      name: { type: 'string', description: 'Optional output filename.' },
      detail: { type: 'string', description: 'Actual generation stage; do not invent percentage progress.' },
      error: { type: 'string', description: 'Reason for generation failure.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent?.session?.header?.id) throw new Error('媒体交付需要当前会话');
      const sessionId = String(agent.session.header.id);
      const boundary = ctx.get('agents')?.turnBoundaryOf(agent.session);
      if (args.action === 'list') return service.snapshot(sessionId);
      if (args.action === 'begin') {
        if (!boundary?.openTurnStartSeq) throw new Error('媒体生成需要正在运行的会话回合');
        const cwd = await ctx.get('workingDirectory')?.ensure(agent, exec.signal);
        return service.begin({ sessionId, turn: boundary.lastTurn, anchorSeq: agent.session.events?.at(-1)?.seq || boundary.openTurnStartSeq, cwd }, args);
      }
      if (!args.taskId) throw new Error('需要 taskId');
      if (args.action === 'retry') return service.retry(sessionId, args.taskId);
      if (['deliver', 'preview'].includes(args.action)) {
        let input = args;
        if (args.path) {
          const provider = ctx.get('fs');
          const cwd = await ctx.get('workingDirectory')?.ensure(agent, exec.signal);
          if (provider) {
            const resolved = await provider.resolve(args.path, { cwd, signal: exec.signal });
            const target = provider.hostPath?.(resolved);
            if (target) input = { ...args, path: target, cwd };
            else if (!fs.existsSync(args.path)) throw new Error('该执行环境的文件不能在电脑端读取，请先导出可访问文件');
          }
        }
        return service.receive(sessionId, args.taskId, input, args.action === 'preview' ? 'preview' : 'original');
      }
      return service.update(sessionId, args.taskId, { ...args, phase: args.action === 'fail' ? 'failed' : args.action === 'cancel' ? 'cancelled' : undefined });
    },
  }));
}
const MEDIA_GUIDANCE = 'For any image or video generation, call mobile_media begin before starting the generator, using its requested aspect ratio when known. Keep that taskId through generation and provide real preview images only when available. Deliver the original file or a downloadable media URL after generation, and wait for a successful receipt; repair failed downloads by refreshing the URL or exporting a file. Do not rerun paid generation to fix delivery. Mark generation failures with fail. Preserve the normal final answer and any existing delivery. Browser blob URLs or authenticated preview pages require the generating plugin to export the original file.';
function installMediaTool(ctx, service) {
  try { registerMediaTool(ctx, service); } catch (error) {
    if (!String(error.message || error).includes('without inject')) throw error;
  }
  try {
    ctx.systemPrompt.section({ name: 'mobile:media-delivery', order: 10150, interpolate: false, text: MEDIA_GUIDANCE });
  } catch (error) {
    if (!String(error.message || error).includes('without inject')) throw error;
  }
}
module.exports = { registerMediaTool, installMediaTool };
