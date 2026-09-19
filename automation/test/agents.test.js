const test = require('node:test');
const assert = require('node:assert/strict');
const { AllocationAgent, GuardrailAgent } = require('../src/agents');

test('AllocationAgent caps capital per strategy', () => {
  const agent = new AllocationAgent();
  const result = agent.run(
    {
      opportunities: [
        { id: 'a', score: 1000, maxCapitalUsd: 10000, expectedAprBps: 1500, action: {} },
        { id: 'b', score: 200, maxCapitalUsd: 10000, expectedAprBps: 1000, action: {} },
      ],
    },
    {
      totalCapitalUsd: 9000,
      maxCapitalPerStrategyUsd: 3000,
    },
  );

  assert.equal(result.allocations[0].capitalUsd, 3000);
  assert.equal(result.allocations[1].capitalUsd <= 3000, true);
});

test('GuardrailAgent blocks high slippage', () => {
  const guardrail = new GuardrailAgent();
  const result = guardrail.run(
    {
      market: { gasGwei: 15, slippageBps: 180, drawdownBps: 500 },
      allocations: [{ capitalUsd: 1000 }],
    },
    {
      maxGasGwei: 30,
      maxSlippageBps: 100,
      maxDrawdownBps: 1000,
      totalCapitalUsd: 5000,
    },
  );

  assert.equal(result.approved, false);
  assert.equal(result.reasons.some(reason => reason.includes('Slippage')), true);
});
