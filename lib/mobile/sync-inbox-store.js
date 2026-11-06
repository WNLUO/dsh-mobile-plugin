'use strict';

/**
 * 同步收件箱：按 `instanceId` 存密文记录的磁盘小仓库（`$DSH_HOME/storages/mobile-plugin/sync-inbox.json`）。
 *
 * 每台电脑给「共享同步组」当一次中转点：别的手机把一条条**已用 SGK 加密**的记录写进来，本机
 * 只存不读、看不懂内容。记录的形状是 `{ cid, blob, createdAt }`：`cid` 是内容标识（去重键），
 * `blob` 是 base64 的密文，`createdAt` 由本仓库在写入时打上。
 *
 * 三条限制决定了它是一个「短时邮箱」而不是数据库：
 *  · **TTL 24 小时**：过期的记录在读写时顺手清掉。同步只在手机回前台时跑一次，一天足够；
 *    再久的记录没有意义，留着只会让文件慢慢变大。
 *  · **单条 blob 上限 8KB**：记录只是「设备清单的一项 / 一条删除指令」，本该很小；超过这个量
 *    说明写错了东西，整条拒收。
 *  · **单次最多 16 条**：一次同步一批设备，超过就该分批。
 *
 * 落盘口径照 `mobile-stats.json` 那一套：整份读、整份原子写（临时文件 + rename）。**读坏文件
 * 时 write 绝不覆盖**——那会把盘上还没发出去的记录静默清空；读失败只有 `read()` 退化成空表。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths');

/** 文件格式版本：将来改结构时据此决定丢弃还是迁移。 */
const VERSION = 1;

/** 记录存活上限：24 小时。 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 单条 blob（base64 密文串）的字节上限。 */
const MAX_BLOB_BYTES = 8 * 1024;

/** 单次写入最多接收的记录条数。 */
const MAX_RECORDS_PER_WRITE = 16;

/** cid 的长度上限：它只是去重键，不拼路径，但也不该是无限长的串。 */
const MAX_CID_LEN = 200;

/**
 * 单实例最多留多少条：TTL 已经把它压到一天的量，这一道只是文件体积的兜底（超了丢最老的）。
 * 一条 8KB 封顶时，512 条约 4MB，仍可接受。
 */
const MAX_STORED_PER_INSTANCE = 512;

/** 收件箱文件：跟其它移动端插件状态放同一个目录（`storages/mobile-plugin/`）。 */
function defaultFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'sync-inbox.json');
}

/**
 * 建一个收件箱 store。默认读 `defaultFile()` 的真实时钟；测试可注入 `file` / `now` / `ttlMs`。
 *
 * @param {object} [options]
 * @param {string} [options.file]        落盘文件（测试用）
 * @param {() => number} [options.now]   当前时刻的取值器
 * @param {number} [options.ttlMs]       记录存活时长
 */
function createSyncInboxStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TTL_MS;
  const file = options.file || defaultFile();

  /** 读盘并解析。文件不存在 → 空库；存在但读不懂 → 抛错（write 会用它，绝不能吞成空库）。 */
  function readRaw() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: VERSION, instances: {} };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw Object.assign(new Error(`同步收件箱文件已损坏：${error.message}`), { code: 'sync-inbox-corrupt' });
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.instances || typeof parsed.instances !== 'object') {
      throw Object.assign(new Error('同步收件箱文件形状不对'), { code: 'sync-inbox-corrupt' });
    }
    return parsed;
  }

  /** 只留形状对、未过期的记录。 */
  function prune(list) {
    const cutoff = now() - ttlMs;
    return list.filter((record) => (
      record
      && typeof record === 'object'
      && typeof record.cid === 'string'
      && typeof record.blob === 'string'
      && Number.isFinite(record.createdAt)
      && record.createdAt > cutoff
    ));
  }

  /** 原子写：先临时文件再 rename，写一半断电也不留半份 JSON。 */
  function save(db) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /**
   * 读某实例的记录：`since` 之后、未过期的，按 `createdAt` 升序。
   * 读盘失败按空表（首页拉不到不该把同步引擎整个卡死）。
   *
   * @param {string} instanceId
   * @param {number} [since] 毫秒时间戳，只取严格晚于它的记录
   * @returns {Array<{cid: string, blob: string, createdAt: number}>}
   */
  function read(instanceId, since) {
    let db;
    try {
      db = readRaw();
    } catch {
      return [];
    }
    const list = Array.isArray(db.instances[String(instanceId || '')]) ? db.instances[String(instanceId || '')] : [];
    const sinceMs = Number.isFinite(since) && since > 0 ? since : 0;
    return prune(list)
      .filter((record) => record.createdAt > sinceMs)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => ({ cid: record.cid, blob: record.blob, createdAt: record.createdAt }));
  }

  /**
   * 写一批记录：按 cid 去重、裁掉越界 / 过期的，返回被接收的 cid 列表。
   *
   * **读坏文件会抛错、不覆盖**：盘上那份可能还有别的手机没取走的东西，绝不能当成空库重写。
   *
   * @param {string} instanceId
   * @param {Array<{cid: string, blob: string}>} records
   * @returns {string[]} 接收到的 cid（重复的也算「已在库里」）
   */
  function write(instanceId, records) {
    const db = readRaw();
    const id = String(instanceId || '');
    const byCid = new Map(prune(Array.isArray(db.instances[id]) ? db.instances[id] : []).map((r) => [r.cid, r]));
    const accepted = [];
    const at = now();
    let added = 0;
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || typeof record !== 'object') continue;
      const cid = typeof record.cid === 'string' ? record.cid : '';
      const blob = typeof record.blob === 'string' ? record.blob : '';
      if (!cid || cid.length > MAX_CID_LEN || !blob) continue;
      if (Buffer.byteLength(blob, 'utf8') > MAX_BLOB_BYTES) continue;
      if (byCid.has(cid)) {
        accepted.push(cid);
        continue;
      }
      if (added >= MAX_RECORDS_PER_WRITE) break;
      byCid.set(cid, { cid, blob, createdAt: at });
      accepted.push(cid);
      added += 1;
    }
    let list = [...byCid.values()].sort((a, b) => a.createdAt - b.createdAt);
    if (list.length > MAX_STORED_PER_INSTANCE) list = list.slice(list.length - MAX_STORED_PER_INSTANCE);
    db.version = VERSION;
    db.instances[id] = list;
    save(db);
    return accepted;
  }

  return { read, write };
}

module.exports = {
  createSyncInboxStore,
  defaultFile,
  VERSION,
  TTL_MS,
  MAX_BLOB_BYTES,
  MAX_RECORDS_PER_WRITE,
  MAX_CID_LEN,
  MAX_STORED_PER_INSTANCE,
};
