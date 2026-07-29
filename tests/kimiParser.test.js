// Kimi Code parser tests.
//
// Kimi Code logs per-turn usage as a top-level `usage.record` event in
// ~/.kimi-code/.../agents/main/wire.jsonl (flat schema, camelCase fields).
// These tests pin the field mapping, the zero-usage drop, the model fallback,
// and — critically — that the nested step.end usage duplicate is NOT counted.
//
// Run with: gjs -m tests/kimiParser.test.js

import { parseKimiLine } from '../modules/parsers.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const WIRE = '/tmp/wire.jsonl';

// 1. usage.record → entry with mapped camelCase fields
const r1 = parseKimiLine(JSON.stringify({
    type: 'usage.record', model: 'kimi-k3', usageScope: 'turn', time: 1785322886975,
    usage: { inputOther: 20993, output: 159, inputCacheRead: 0, inputCacheCreation: 0 },
}), WIRE);
assert(r1 !== null, 'usage.record should parse');
assert(r1.model === 'kimi-k3', 'model from record');
assert(r1.inputTokens === 20993, 'inputOther → inputTokens');
assert(r1.outputTokens === 159, 'output');
assert(r1.cacheReadTokens === 0, 'inputCacheRead → cacheReadTokens');
assert(r1.cacheCreationTokens === 0, 'inputCacheCreation → cacheCreationTokens');
assert(r1.date !== null && typeof r1.date === 'string', 'date from time (ms)');
assert(r1.costUSD === null, 'costUSD null → pricing-table path');

// 2. zero usage → dropped (no phantom 0-token rows)
assert(parseKimiLine(JSON.stringify({
    type: 'usage.record', model: 'kimi-k3', time: 1785322886975,
    usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
}), WIRE) === null, 'zero-usage record dropped');

// 3. nested step.end duplicate (context.append_loop_event) → NOT counted
assert(parseKimiLine(JSON.stringify({
    type: 'context.append_loop_event',
    event: {
        type: 'step.end',
        usage: { inputOther: 20993, output: 159, inputCacheRead: 0, inputCacheCreation: 0 },
    },
    time: 1785322886975,
}), WIRE) === null, 'nested step.end usage not double-counted');

// 4. llm.request line → null
assert(parseKimiLine(JSON.stringify({
    type: 'llm.request', modelAlias: 'kimi-k3', time: 1785322859705,
}), WIRE) === null, 'llm.request ignored');

// 5. metadata line → null
assert(parseKimiLine(JSON.stringify({
    type: 'metadata', protocol_version: '1.4', created_at: 1785322830476,
}), WIRE) === null, 'metadata ignored');

// 6. missing model → fallback 'kimi'
const r6 = parseKimiLine(JSON.stringify({
    type: 'usage.record', usageScope: 'turn', time: 1785322886975,
    usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
}), WIRE);
assert(r6 !== null && r6.model === 'kimi', 'missing model falls back to kimi');

// 7. missing time → date null (the worker drops date-less rows)
const r7 = parseKimiLine(JSON.stringify({
    type: 'usage.record', model: 'kimi-k3',
    usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
}), WIRE);
assert(r7 !== null && r7.date === null, 'missing time → date null');

print('kimiParser tests passed');