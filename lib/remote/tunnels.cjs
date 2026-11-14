// 远程电脑的 Tailcat/P2P 候选：通过已认证控制通道会合，每台绑定独立持有私钥与句柄。
'use strict';

const { createRemoteTunnelHelper } = require('./tunnel-helper.cjs');
const TERMINAL_ERRORS = new Set(['REMOTE_REVOKED', 'REMOTE_EXPIRED']);
const list = value => [...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && item.length <= 256))].sort();
const same = (a, b) => JSON.stringify(list(a)) === JSON.stringify(list(b));
const idOf = binding => binding.id || binding.instanceId;

function localRoute(url, channel) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return { url: parsed.origin, channel };
  } catch { return null; }
}

function createRemoteTunnels({ store, transport, helper = createRemoteTunnelHelper() }) {
  const sessions = new Map();
  const jobs = new Map();
  const versions = new Map();
  let closed = false;
  const generation = () => helper.status?.().generation || 0;

  function serialized(id, action) {
    const previous = jobs.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    jobs.set(id, next);
    void next.finally(() => { if (jobs.get(id) === next) jobs.delete(id); }).catch(() => {});
    return next;
  }

  async function keysFor(binding) {
    const id = idOf(binding);
    const stored = await store.get(id) || binding;
    const keys = { ...(stored.tunnelKeys || {}) };
    const tailcat = await helper.request('remoteTailcatKey', { deviceId: id, privateKey: keys.tailcatPrivateKey || '' });
    keys.tailcatPrivateKey = tailcat.privateKey;
    if (!keys.p2pPrivateKey || !keys.p2pPublicKey) {
      const pair = await helper.request('remoteP2PKeys', { deviceId: id, p2pPrivateKey: keys.p2pPrivateKey || '' });
      keys.p2pPrivateKey = pair.private;
      keys.p2pPublicKey = pair.public;
    }
    if (!keys.tailcatPrivateKey || !keys.p2pPrivateKey || !keys.p2pPublicKey || !tailcat.publicKey) throw new Error('remote-helper-keys');
    if (JSON.stringify(keys) !== JSON.stringify(stored.tunnelKeys || {})) {
      if (typeof store.update === 'function') await store.update(id, () => ({ tunnelKeys: keys }));
      else await store.put({ ...stored, id, tunnelKeys: keys });
    }
    return { keys, tailcatPublicKey: tailcat.publicKey };
  }

  async function control(binding, route, payload) {
    const all = (binding.routes || []).filter(candidate => candidate && typeof candidate.url === 'string');
    const choices = route ? [route] : [...all.slice(0, 1), ...all.filter(item => item.channel === 'relay'), ...all.slice(1)]
      .filter((item, index, rows) => rows.findIndex(other => other.url === item.url) === index);
    for (let index = 0; index < choices.length; index += 2) {
      const batch = choices.slice(index, index + 2).map(async candidate => {
        const result = await transport.callRemoteControl(binding, candidate, payload, { timeoutMs: 15000 });
        return { result, route: candidate };
      });
      const results = await Promise.allSettled(batch);
      const terminal = results.find(item => item.status === 'rejected' && TERMINAL_ERRORS.has(item.reason?.code));
      if (terminal) throw terminal.reason;
      const success = results.find(item => item.status === 'fulfilled');
      if (success) return success.value;
    }
    throw new Error('remote-control-unavailable');
  }

  async function stopDevice(id) {
    sessions.delete(id);
    try { await helper.closeDevice(id); } catch { /* 已退出的助手没有遗留句柄。 */ }
  }

  async function initialize(binding, route, version) {
    const id = idOf(binding);
    let entry;
    try {
      const { keys, tailcatPublicKey } = await keysFor(binding);
      if (closed || versions.get(id) !== version) return [];
      const payload = { op: 'tunnels', tailcatPublicKey, p2p: { publicKey: keys.p2pPublicKey, candidates: [], localCandidates: [] } };
      const first = await control(binding, route, payload);
      entry = { routes: [], generation: generation(), controlRoute: first.route, publicKey: keys.p2pPublicKey,
        tailcatPublicKey, candidates: [], localCandidates: [] };
      const tailcat = first.result?.tailcat;
      if (tailcat?.address && Number.isInteger(tailcat.port)) {
        try {
          const started = await helper.request('remoteTailcatStart', { deviceId: id, privateKey: keys.tailcatPrivateKey,
            address: tailcat.address, remotePort: tailcat.port });
          const candidate = localRoute(`http://127.0.0.1:${started.port}`, 'tunnel');
          if (candidate) entry.routes.push(candidate);
        } catch { /* P2P 与基础线路仍可独立使用。 */ }
      }
      const peer = first.result?.p2p;
      if (peer?.publicKey && Number.isInteger(peer.port)) {
        try {
          const started = await helper.request('remoteP2PStart', { deviceId: id, p2pPrivateKey: keys.p2pPrivateKey,
            p2pPeerKey: peer.publicKey, p2pPeerPublic: list(peer.candidates), p2pPeerLocal: list(peer.localCandidates), p2pListenPort: peer.port });
          const candidate = localRoute(started.url, 'p2p');
          if (candidate) {
            const local = await helper.request('remoteP2PCandidates', { deviceId: id });
            entry.candidates = list(local.candidates || started.candidates);
            entry.localCandidates = list(local.localCandidates);
            const second = await control(binding, first.route, { op: 'tunnels.refresh', tailcatPublicKey,
              p2p: { publicKey: keys.p2pPublicKey, candidates: entry.candidates, localCandidates: entry.localCandidates } });
            if (second.result?.p2p?.publicKey !== peer.publicKey) throw new Error('remote-p2p-identity-changed');
            // A 更新接收端后会主动打向这块 B socket；保留 B 句柄，让数据面学习 A 的当前地址。
            entry.routes.push(candidate);
          }
        } catch (error) {
          try { await helper.request('remoteP2PStop', { deviceId: id }); } catch { /* 助手退出即清理。 */ }
          if (TERMINAL_ERRORS.has(error?.code)) throw error;
        }
      }
      if (closed || versions.get(id) !== version || entry.generation !== generation()) {
        await stopDevice(id);
        return [];
      }
      sessions.set(id, entry);
      return entry.routes.map(item => ({ ...item }));
    } catch (error) {
      await stopDevice(id);
      if (TERMINAL_ERRORS.has(error?.code)) throw error;
      return [];
    }
  }

  async function routesFor(binding) {
    const id = idOf(binding);
    return serialized(id, async () => {
      if (closed) return [];
      const current = sessions.get(id);
      if (current && current.generation === generation() && helper.status?.().running !== false) {
        if (current.routes.some(item => item.channel === 'p2p')) {
          try {
            const local = await helper.request('remoteP2PCandidates', { deviceId: id });
            if (!same(local.candidates, current.candidates) || !same(local.localCandidates, current.localCandidates)) {
              const candidates = list(local.candidates);
              const localCandidates = list(local.localCandidates);
              await control(binding, current.controlRoute, { op: 'tunnels.refresh', tailcatPublicKey: current.tailcatPublicKey,
                p2p: { publicKey: current.publicKey, candidates, localCandidates } });
              current.candidates = candidates;
              current.localCandidates = localCandidates;
            }
          } catch (error) {
            if (TERMINAL_ERRORS.has(error?.code)) {
              await stopDevice(id);
              throw error;
            }
            current.routes = current.routes.filter(item => item.channel !== 'p2p');
            try { await helper.request('remoteP2PStop', { deviceId: id }); } catch { /* 已退出。 */ }
          }
        }
        return current.routes.map(item => ({ ...item }));
      }
      await stopDevice(id);
      const version = versions.get(id) || 0;
      versions.set(id, version);
      return initialize(binding, undefined, version);
    });
  }

  return {
    routesFor,
    refresh(binding, { route } = {}) {
      const id = idOf(binding);
      const version = (versions.get(id) || 0) + 1;
      versions.set(id, version);
      return serialized(id, async () => {
        await stopDevice(id);
        if (closed || versions.get(id) !== version) return [];
        return initialize(binding, route, version);
      });
    },
    close(id) {
      versions.set(id, (versions.get(id) || 0) + 1);
      return serialized(id, () => stopDevice(id));
    },
    async closeAll() {
      closed = true;
      for (const id of new Set([...sessions.keys(), ...jobs.keys()])) versions.set(id, (versions.get(id) || 0) + 1);
      await Promise.all([...jobs.values()].map(job => job.catch(() => {})));
      sessions.clear();
      await helper.close();
    },
  };
}

module.exports = { createRemoteTunnels };
