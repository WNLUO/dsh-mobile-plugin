'use strict';

/**
 * 生成跨端测试向量（讨论记录 §8.3(12)）。
 *
 * 加密这套东西最容易翻车的地方不是算法，是**两端把某个字节拼错了**：base64 的变体、
 * AAD 的拼接顺序、HKDF 的 info、摘要用 hex 还是 base64。任何一处不一致，症状都是
 * 「解不开」，而两边各看各的代码都像是对的。
 *
 * 所以先冻结一张表：每行给出输入与期望输出（hex），宿主与 App 各跑一遍，对不上就是实现
 * 错了，不用互相猜。**这张表是产物，不是测试**：改协议才重跑，平常由两端的测试读它。
 *
 * 用法：`node scripts/gen-e2ee-vectors.cjs`（宿主侧，用 node:crypto）。
 * App 侧的实现文件在 `app/src/services/e2ee.ts`，读同一份 JSON 校验。
 */

const fs = require('node:fs');
const path = require('node:path');
const e2ee = require('../lib/shared/e2ee.js');

const hex = (buf) => Buffer.from(buf).toString('hex');
const fixed = (length, fill) => Buffer.alloc(length, fill);
const utf8 = (text) => Buffer.from(text, 'utf8');

/** 固定输入，别用随机：这张表要能重算出同样的输出。 */
const TICKET = fixed(32, 0x11);
const DEVICE_KEY = fixed(32, 0x22);
const PAIR_NONCE = fixed(12, 0x33);
const BODY_NONCE = fixed(12, 0x44);
const DOWN_NONCE = fixed(12, 0x55);
const PARAMS_NONCE = fixed(12, 0x66);
const INSTANCE = 'a1b2c3d4';

const pairKey = e2ee.derivePairKey(TICKET, INSTANCE);
const keys = e2ee.deriveSessionKeys(DEVICE_KEY);
const pairPlain = utf8(JSON.stringify({ deviceKey: e2ee.b64url(DEVICE_KEY), keyId: '0011223344556677', device: { name: 'iPhone', platform: 'ios' } }));
const pairSealed = e2ee.sealWithNonce(pairKey, PAIR_NONCE, pairPlain, e2ee.pairAad(INSTANCE));

const bodyPlain = utf8(JSON.stringify({ sessionId: 'abc', text: '你好，世界' }));
const upSealed = e2ee.sealWithNonce(keys.up, BODY_NONCE, bodyPlain, e2ee.upAad('POST', '/api/mobile/v1/session/send'));

const respPlain = utf8(JSON.stringify({ ok: true, data: { received: 1 } }));
const downSealed = e2ee.sealWithNonce(keys.down, DOWN_NONCE, respPlain, e2ee.downAad('POST', '/api/mobile/v1/session/send', 1761292800123, e2ee.b64url(BODY_NONCE)));

const paramsPlain = utf8(JSON.stringify({ path: '/Users/x/project', query: '日志' }));
const paramsSealed = e2ee.sealWithNonce(keys.up, PARAMS_NONCE, paramsPlain, e2ee.paramsAad(1761292800123, e2ee.b64url(BODY_NONCE)));

const canonical = e2ee.canonicalString({
  method: 'POST',
  path: '/api/mobile/v1/session/send',
  query: '?fresh=1',
  ts: 1761292800123,
  nonce: e2ee.b64url(BODY_NONCE),
  bodyBytes: utf8(JSON.stringify({ v: 2, c: e2ee.b64(upSealed) })),
});

const vectors = {
  note: '协议 v2 的跨端测试向量。由 scripts/gen-e2ee-vectors.cjs 生成，两端测试读它。改协议才重生成。',
  proto: 2,
  inputs: {
    ticket: hex(TICKET),
    deviceKey: hex(DEVICE_KEY),
    instanceId: INSTANCE,
    pairNonce: hex(PAIR_NONCE),
    bodyNonce: hex(BODY_NONCE),
    downNonce: hex(DOWN_NONCE),
    paramsNonce: hex(PARAMS_NONCE),
    pairPlain: pairPlain.toString('utf8'),
    bodyPlain: bodyPlain.toString('utf8'),
    responsePlain: respPlain.toString('utf8'),
    paramsPlain: paramsPlain.toString('utf8'),
    requestMethod: 'POST',
    requestPath: '/api/mobile/v1/session/send',
    requestQuery: '?fresh=1',
    requestTs: 1761292800123,
  },
  expect: {
    pairKey: hex(pairKey),
    keyUp: hex(keys.up),
    keyDown: hex(keys.down),
    keySig: hex(keys.sig),
    pairSealed: hex(pairSealed),
    upSealed: hex(upSealed),
    downSealed: hex(downSealed),
    paramsSealed: hex(paramsSealed),
    canonical,
    signature: e2ee.sign(keys.sig, canonical),
  },
};

const out = path.join(__dirname, '..', 'test', 'e2ee-vectors.json');
fs.writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
process.stdout.write(`wrote ${out}\n`);
