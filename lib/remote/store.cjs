'use strict';
// 远程电脑的长期绑定仅保存于宿主凭据记录，面板只消费控制器的无密钥投影。
const OWNER = 'dsh-mobile-plugin';
const PREFIX = `${OWNER}/remote-computer-`;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function createRemoteStore(options = {}) {
  const providerOf = typeof options.credentials === 'function' ? options.credentials : () => options.credentials;
  function provider() {
    const value = providerOf();
    if (!value || typeof value.readRecord !== 'function' || typeof value.modifyRecord !== 'function') {
      const error = new Error('宿主凭据存储暂不可用，无法保存远程电脑绑定');
      error.code = 'credentials-unavailable';
      throw error;
    }
    return value;
  }
  function keyOf(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('远程电脑标识不合法');
    return PREFIX + Buffer.from(id, 'utf8').toString('hex');
  }
  function payloadOf(record) {
    if (!record || record.kind !== 'grant' || record.payload?.version !== 1) return null;
    const binding = record.payload.binding;
    if (!binding || !ID.test(binding.id || '') || typeof binding.instanceId !== 'string') return null;
    return copy(binding);
  }
  return {
    async list() {
      const value = provider();
      const records = await value.listRecords();
      const keys = records.filter(item => typeof item.key === 'string' && item.key.startsWith(PREFIX));
      const rows = await Promise.all(keys.map(async item => payloadOf(await value.readRecord(item.key))));
      return rows.filter(Boolean);
    },
    async get(id) { return payloadOf(await provider().readRecord(keyOf(id))); },
    async put(binding) {
      const id = binding?.id || binding?.instanceId;
      const key = keyOf(id);
      const next = copy({ ...binding, id });
      await provider().modifyRecord(key, current => ({
        kind: 'grant', payload: { version: 1, binding: { ...(payloadOf(current) || {}), ...next } },
      }));
      return next;
    },
    async delete(id) { await provider().deleteRecord(keyOf(id)); },
    async update(id, change) {
      let result;
      await provider().modifyRecord(keyOf(id), async current => {
        const binding = payloadOf(current);
        if (!binding) throw new Error('远程电脑绑定不存在');
        result = { ...binding, ...await change(copy(binding)), id };
        return { kind: 'grant', payload: { version: 1, binding: result } };
      });
      return copy(result);
    },
  };
}
module.exports = { createRemoteStore, PREFIX };
