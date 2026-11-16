// 媒体任务逐会话保存，重启后明确标记未完成的收存，不重跑生成。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ACTIVE } = require('./contract.js');
function createMediaStore(root) {
  fs.mkdirSync(root, { recursive: true });
  const sessions = new Map();
  const fileOf = (id) => path.join(root, `${encodeURIComponent(id)}.json`);
  function read(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    let value;
    try { value = JSON.parse(fs.readFileSync(fileOf(sessionId), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; value = { revision: 0, items: [] }; }
    if (!value || !Array.isArray(value.items)) throw new Error('媒体任务记录无法读取');
    let changed = false;
    for (const item of value.items) {
      if (ACTIVE.has(item.phase)) {
        item.phase = 'interrupted'; item.error = '电脑服务已重启，请继续交付或重试接收'; item.updatedAt = Date.now(); item.revision = ++value.revision; changed = true;
      }
    }
    sessions.set(sessionId, value);
    if (changed) save(sessionId, value);
    return value;
  }
  function save(sessionId, value) {
    const target = fileOf(sessionId);
    const temporary = `${target}.part`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, target);
    sessions.set(sessionId, value);
  }
  function update(sessionId, task) {
    const state = read(sessionId);
    const next = { ...task, revision: state.revision + 1, updatedAt: Date.now() };
    const items = state.items.slice();
    const index = items.findIndex((item) => item.id === next.id);
    if (index < 0) items.push(next); else items[index] = next;
    save(sessionId, { revision: next.revision, items });
    return next;
  }
  return { read, update, root };
}
module.exports = { createMediaStore };
