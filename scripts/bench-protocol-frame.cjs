'use strict';

/**
 * Manual allocation/throughput comparison for the relay frame encoder.
 * Run with: node scripts/bench-protocol-frame.cjs
 * The legacy reference allocates Buffer.from(JSON.stringify(...)) and then copies
 * it into the final frame; the production encoder writes UTF-8 directly once.
 */

const { encodeFrame, T, HEADER_LEN } = require('../lib/relay/protocol.js');

const iterations = Math.max(1, Number(process.env.BENCH_ITERATIONS) || 500);
const rounds = Math.max(1, Number(process.env.BENCH_ROUNDS) || 5);
const payloadSize = Math.max(1, Number(process.env.BENCH_BODY_BYTES) || 64 * 1024);
const payload = { kind: 'protocol-benchmark', body: 'x'.repeat(payloadSize) };

function legacyEncodeFrame(type, id, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_LEN + body.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(id >>> 0, 1);
  frame.writeUInt32BE(body.length, 5);
  body.copy(frame, HEADER_LEN);
  return frame;
}

function measure(encoder) {
  let checksum = 0;
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    const frame = encoder(T.sync, i, payload);
    checksum = (checksum + frame.length + frame[HEADER_LEN]) >>> 0;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { elapsedMs, checksum };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Warm both paths before collecting samples; alternate order to reduce order bias.
measure(legacyEncodeFrame);
measure(encodeFrame);
const legacyMs = [];
const directMs = [];
let legacyChecksum = 0;
let directChecksum = 0;
for (let round = 0; round < rounds; round += 1) {
  if (global.gc) global.gc();
  const pair = round % 2 === 0
    ? [['legacy', legacyEncodeFrame], ['direct', encodeFrame]]
    : [['direct', encodeFrame], ['legacy', legacyEncodeFrame]];
  for (const [name, encoder] of pair) {
    const result = measure(encoder);
    if (name === 'legacy') { legacyMs.push(result.elapsedMs); legacyChecksum = result.checksum; }
    else { directMs.push(result.elapsedMs); directChecksum = result.checksum; }
  }
}

const bodyBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
const legacyBufferBytesPerFrame = HEADER_LEN + bodyBytes * 2;
const directBufferBytesPerFrame = HEADER_LEN + bodyBytes;
const legacyMedianMs = median(legacyMs);
const directMedianMs = median(directMs);
console.log(JSON.stringify({
  node: process.version,
  payloadBytes: bodyBytes,
  iterationsPerRound: iterations,
  rounds,
  legacyMedianMs,
  directMedianMs,
  directThroughputRatio: legacyMedianMs / directMedianMs,
  estimatedBufferBytesPerFrame: {
    legacy: legacyBufferBytesPerFrame,
    direct: directBufferBytesPerFrame,
    reductionPercent: (1 - directBufferBytesPerFrame / legacyBufferBytesPerFrame) * 100,
  },
  checksumsMatch: legacyChecksum === directChecksum,
}, null, 2));
