'use strict';
// 远程电脑的长期绑定只落插件本地文件，不进宿主凭据库。

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

function defaultFile() {
  return process.env.DSH_MOBILE_REMOTE_STORE || path.join(dshHome(), 'storages', 'mobile-plugin', 'remote-computers.json');
}

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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

  return {
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
}

module.exports = { createRemoteStore, defaultFile };
