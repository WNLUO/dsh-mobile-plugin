// 媒体生成、原件接收和预览独立记账，手机断线不取消电脑收存。
'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMediaStore } = require('./store.js');
const { sourceOf, acquireMedia } = require('./acquire.js');
const { ratioOf, publicTask } = require('./contract.js');
function createMediaService(options) {
  const store = createMediaStore(options.root);
  const listeners = new Map();
  const pending = new Map();
  const get = (sessionId, id) => {
    const task = store.read(sessionId).items.find((item) => item.id === id);
    if (!task) throw new Error('这条会话没有登记该媒体任务');
    return task;
  };
  const publish = (sessionId, value) => {
    const task = store.update(sessionId, value);
    for (const listener of listeners.get(sessionId) || []) { try { listener(snapshot(sessionId)); } catch {} }
    return task;
  };
  const snapshot = (sessionId) => {
    const state = store.read(sessionId);
    return { sessionId, revision: state.revision, items: state.items.map(publicTask) };
  };
  function begin(owner, input) {
    if (!['image', 'video'].includes(input.kind)) throw new Error('媒体类型必须是 image 或 video');
    const key = typeof input.key === 'string' ? input.key : '';
    const previous = key && store.read(owner.sessionId).items.find((item) => item.key === key && item.turn === owner.turn);
    if (previous) return publicTask(previous);
    const task = publish(owner.sessionId, { id: randomUUID(), ...owner, key, kind: input.kind,
      title: String(input.title || (input.kind === 'video' ? '视频' : '图片')).slice(0, 200), frameRatio: ratioOf(input.aspectRatio, input.kind),
      phase: 'generating', createdAt: Date.now() });
    return publicTask(task);
  }
  async function receive(sessionId, id, input, variant = 'original') {
    const task = get(sessionId, id);
    if (variant === 'original' && task.phase === 'ready') return publicTask(task);
    const slot = `${sessionId}:${id}:${variant}`;
    if (pending.has(slot)) return pending.get(slot).promise;
    const source = sourceOf(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('媒体接收超时，请重试接收')), 10 * 60 * 1000);
    timer.unref?.();
    const next = publish(sessionId, { ...task, ...(variant === 'original' ? { source, phase: 'receiving', error: undefined, loaded: 0, total: undefined } : {}) });
    const promise = (async () => {
      try {
        const result = await acquireMedia(source, path.join(store.root, 'objects', id, `${variant}-${randomUUID()}`), {
          cwd: input.cwd || next.cwd, name: input.name, kind: variant === 'preview' ? 'image' : next.kind,
          signal: controller.signal, fetch: options.fetch, protectedPorts: options.protectedPorts?.(),
          onProgress: variant === 'original' ? (loaded, total) => {
            const current = get(sessionId, id);
            if (current.phase === 'receiving') publish(sessionId, { ...current, loaded, total });
          } : undefined,
        });
        const current = get(sessionId, id);
        if (controller.signal.aborted) throw controller.signal.reason;
        const alias = source.path || source.url;
        const saved = variant === 'preview'
          ? { ...current, preview: result }
          : { ...current, original: result, phase: 'ready', error: undefined, loaded: result.bytes, total: result.bytes,
            width: result.width, height: result.height, bytes: result.bytes, mediaType: result.mediaType, name: result.name,
            sourceAlias: alias && !source.headers?.Authorization && !source.headers?.authorization ? alias : undefined };
        return publicTask(publish(sessionId, saved));
      } catch (error) {
        if (variant === 'preview') throw error;
        const current = get(sessionId, id);
        if (current.phase !== 'cancelled') publish(sessionId, { ...current, phase: 'failed', error: String(error.message || error).slice(0, 400) });
        throw error;
      } finally { clearTimeout(timer); pending.delete(slot); }
    })();
    pending.set(slot, { controller, promise });
    return promise;
  }
  function update(sessionId, id, input) {
    const current = get(sessionId, id);
    if (current.phase === 'ready') return publicTask(current);
    const phase = input.phase && ['generating', 'failed', 'cancelled'].includes(input.phase) ? input.phase : current.phase;
    if (phase === 'cancelled') for (const [key, entry] of pending) if (key.startsWith(`${sessionId}:${id}:`)) entry.controller.abort();
    return publicTask(publish(sessionId, { ...current, phase, detail: typeof input.detail === 'string' ? input.detail.slice(0, 300) : current.detail,
      error: phase === 'failed' ? String(input.error || '媒体生成失败').slice(0, 400) : undefined }));
  }
  return { begin, get, snapshot, receive, update,
    retry(sessionId, id) { const task = get(sessionId, id); if (!task.source) throw new Error('尚未收到媒体来源，请让生成方继续交付'); return receive(sessionId, id, { ...task.source, cwd: task.cwd, name: task.name }); },
    subscribe(sessionId, listener) { let group = listeners.get(sessionId); if (!group) listeners.set(sessionId, group = new Set()); group.add(listener); return () => { group.delete(listener); if (!group.size) listeners.delete(sessionId); }; },
    close() { for (const entry of pending.values()) entry.controller.abort(); listeners.clear(); },
  };
}
module.exports = { createMediaService };
