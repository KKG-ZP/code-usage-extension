import { getPricingForModel } from '../modules/pricingResolver.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertKimiK3Pricing(modelId) {
    const pricing = getPricingForModel(modelId);
    assert(pricing !== null, `${modelId}: pricing should resolve`);
    assert(pricing.displayName === 'Kimi K3', `${modelId}: display name`);
    assert(pricing.currency === 'CNY', `${modelId}: currency`);
    assert(pricing.input === 20, `${modelId}: cache-miss input price`);
    assert(pricing.cacheRead === 2, `${modelId}: cache-hit input price`);
    assert(pricing.output === 100, `${modelId}: output price`);
    assert(pricing.cacheWrite === 0, `${modelId}: cache-write price`);
}

assertKimiK3Pricing('kimi-k3');
assertKimiK3Pricing('moonshotai/kimi-k3');

print('pricingResolver tests passed');
