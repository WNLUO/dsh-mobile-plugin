'use strict';
// 远程电脑的长期绑定只落插件本地文件，不进宿主凭据库。
// 2026-11-27：0.5.127 前的旧绑定补进本地库，幂等、不删旧记录、不覆盖已有新记录。

/**
 * 电脑间绑定的本地小仓库：`$DSH_HOME/storages/mobile-plugin/remote-computers.json`。
 *
 * 整份读、整份原子写（临时文件 + rename），写操作在本进程内串行，避免并发更新互相覆盖。
 * 这里只存绑定本身（实例标识、线路档位等），不存任何 API Key；读不到文件按空库处理，
 * 文件读坏则报错，不用空库把盘上内容静默抹掉。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths');

const VERSION = 1;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
// 0.5.126 及以前：绑定存在宿主凭据记录里，键是 `dsh-mobile-plugin/remote-computer-<id 的 hex>`。
const LEGACY_PREFIX = 'dsh-mobile-plugin/remote-computer-';

function defaultFile() {
  return process.env.DSH_MOBILE_REMOTE_STORE || path.join(dshHome(), 'storages', 'mobile-plugin', 'remote-computers.json');
}

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** 旧凭据记录 → 绑定本体；形状不对就当没有，不让一条脏记录挡住启动。 */
function legacyBindingOf(record) {
  if (!record || record.kind !== 'grant' || !record.payload || record.payload.version !== 1) return null;
  const binding = record.payload.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || !ID.test(binding.id || '') || typeof binding.instanceId !== 'string') return null;
  return copy(binding);
}

/**
 * 把 0.5.126 及以前的远程电脑绑定补进本地库。
 *
 * 只在本地库还没有同一 id 时写：重复启动不重复写，也不会拿旧记录盖掉用户后来改过的
 * 档位和隧道密钥。旧凭据一条不删（authorizedComputers 仍读它）。凭据服务缺失、读取
 * 失败或某条写不进去都只跳过这一条 —— 迁移是补数据，不该让插件起不来。
 */
async function migrateLegacyBindings(store, credentials) {
  const provider = typeof credentials === 'function' ? credentials() : credentials;
  if (!provider || typeof provider.listRecords !== 'function' || typeof provider.readRecord !== 'function') return 0;
  let entries;
  try {
    entries = await provider.listRecords();
  } catch {
    return 0;
  }
  let migrated = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.key !== 'string' || !entry.key.startsWith(LEGACY_PREFIX)) continue;
    let binding;
    try {
      binding = legacyBindingOf(await provider.readRecord(entry.key));
    } catch {
      continue;
    }
    if (!binding) continue;
    try {
      if (await store.get(binding.id)) continue;
      await store.put(binding);
      migrated += 1;
    } catch {
      // 单条写失败不影响其它绑定，也不把启动拖垮。
    }
  }
  return migrated;
}

function createRemoteStore(options = {}) {
  const file = options.file || defaultFile();
  let queue = Promise.resolve();

  function readAll() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: VERSION, bindings: {} };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw Object.assign(new Error(`远程电脑绑定文件已损坏：${error.message}`), { code: 'remote-store-corrupt' });
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.bindings || typeof parsed.bindings !== 'object' || Array.isArray(parsed.bindings)) {
      throw Object.assign(new Error('远程电脑绑定文件形状不对'), { code: 'remote-store-corrupt' });
    }
    return parsed;
  }

  function save(db) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function transact(change) {
    const job = queue.then(async () => {
      const db = readAll();
      const result = await change(db.bindings);
      save(db);
      return copy(result);
    });
    queue = job.catch(() => {});
    return job;
  }

  function keyOf(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('远程电脑标识不合法');
    return id;
  }

  const store = {
    file,
    async list() {
      const bindings = readAll().bindings;
      return Object.values(bindings).map(copy);
    },
    async get(id) {
      const bindings = readAll().bindings;
      const row = bindings[keyOf(id)];
      return row ? copy(row) : null;
    },
    async put(binding) {
      const id = keyOf(binding && (binding.id || binding.instanceId));
      const next = { ...copy(binding), id };
      return transact((bindings) => { bindings[id] = next; return next; });
    },
    async delete(id) {
      const key = keyOf(id);
      return transact((bindings) => { delete bindings[key]; });
    },
    async update(id, change) {
      const key = keyOf(id);
      return transact(async (bindings) => {
        const current = bindings[key];
        if (!current) throw new Error('远程电脑绑定不存在');
        const next = { ...current, ...await change(copy(current)), id: key };
        bindings[key] = next;
        return next;
      });
    },
  };

  // 创建时补一次老绑定；读写都等它跑完，壳第一次拉清单就看得见旧电脑。
  const ready = options.legacyCredentials
    ? migrateLegacyBindings(store, options.legacyCredentials).catch(() => {})
    : Promise.resolve();

  return {
    file,
    ready,
    async list() { await ready; return store.list(); },
    async get(id) { await ready; return store.get(id); },
    async put(binding) { await ready; return store.put(binding); },
    async delete(id) { await ready; return store.delete(id); },
    async update(id, change) { await ready; return store.update(id, change); },
  };
}

module.exports = { createRemoteStore, defaultFile };
