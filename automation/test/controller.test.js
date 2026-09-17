const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AutopilotController } = require('../src/controller');

function makeConfig(overrides = {}) {
  const base = {
    scheduler: { dailyRunAtUtc: '08:00', maxAttempts: 1, backoffMs: 1 },
    policy: {
      maxGasGwei: 30,
      maxSlippageBps: 100,
      maxDrawdownBps: 1000,
      totalCapitalUsd: 5000,
      maxCapitalPerStrategyUsd: 3000,
    },
    execution: {
      mode: 'dry-run',
      allowedCommandPrefixes: ['yarn foundry:script'],
      hotSignerEnvVar: 'HOT_SIGNER_PRIVATE_KEY',
      coldSignerAddressEnvVar: 'COLD_SIGNER_ADDRESS',
    },
    adaptive: {
      enabled: true,
      minConfidence: 0.4,
      maxConfidence: 1.6,
      successStep: 0.05,
      failureStep: 0.1,
      blockedStep: 0.03,
      cooldownFailureThreshold: 2,
      cooldownMinutes: 180,
    },
    api: { adminApiKeys: ['admin'], viewerApiKeys: ['viewer'] },
    observability: {
      logPath: path.join('/tmp', `autopilot-test-${Date.now()}-${Math.random()}.log`),
      learningStatePath: path.join('/tmp', `autopilot-learning-${Date.now()}-${Math.random()}.json`),
    },
    strategies: [
      {
        id: 'strat',
        chainId: 1,
        protocol: 'uniswap',
        expectedAprBps: 1500,
        riskScore: 10,
        maxCapitalUsd: 2000,
        action: { type: 'command', file: 'yarn', args: ['foundry:script', 'noop'] },
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    execution: {
      ...base.execution,
      ...(overrides.execution || {}),
    },
    adaptive: {
      ...base.adaptive,
      ...(overrides.adaptive || {}),
    },
  };
}

test('controller keeps scheduler stopped in manual mode', () => {
  const controller = new AutopilotController(makeConfig());
  controller.setMode('manual');
  controller.start();
  assert.equal(controller.state.scheduler.active, false);
  controller.stop();
});

test('controller enables and disables scheduler in auto mode', () => {
  const controller = new AutopilotController(makeConfig());
  controller.setMode('auto');
  controller.start();
  assert.equal(controller.state.scheduler.active, true);
  assert.equal(Boolean(controller.state.scheduler.nextRunAt), true);

  controller.setMode('manual');
  assert.equal(controller.state.scheduler.active, false);
  assert.equal(controller.state.scheduler.nextRunAt, null);
  controller.stop();
});

test('controller pauses after three consecutive execution failures', async () => {
  const controller = new AutopilotController(
    makeConfig({ execution: { mode: 'live', allowedCommandPrefixes: ['yarn foundry:script'] } }),
  );
  controller.executionAgent.run = () => {
    throw new Error('execution failed');
  };

  controller.setMode('manual');
  controller.start();

  await controller.runCycle('test');
  await controller.runCycle('test');
  await controller.runCycle('test');

  assert.equal(controller.state.consecutiveExecutionFailures, 3);
  assert.equal(controller.state.paused, true);
});

test('controller blocks and pauses when guardrail fails', async () => {
  const controller = new AutopilotController(makeConfig());
  controller.getMarketSnapshot = () => ({ gasGwei: 999, slippageBps: 20, drawdownBps: 100 });

  controller.setMode('auto');
  controller.start();
  const run = await controller.runCycle('test_guardrail');

  assert.equal(run.status, 'blocked');
  assert.equal(controller.state.counters.failed, 1);
  assert.equal(controller.state.paused, true);
  assert.equal(controller.state.scheduler.active, false);
});

test('controller rejects overlapping runs', async () => {
  const controller = new AutopilotController(makeConfig());
  controller.executionAgent.run = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { results: [], executedAt: new Date().toISOString() };
  };

  controller.setMode('manual');
  controller.start();
  const first = controller.runCycle('first');

  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(() => controller.runCycle('second'), error => error.statusCode === 409);

  await first;
});

test('controller self-corrects with cooldown and learns after success', async () => {
  const controller = new AutopilotController(
    makeConfig({
      adaptive: {
        enabled: true,
        minConfidence: 0.5,
        maxConfidence: 1.5,
        successStep: 0.1,
        failureStep: 0.2,
        blockedStep: 0.05,
        cooldownFailureThreshold: 2,
        cooldownMinutes: 120,
      },
    }),
  );

  controller.setMode('manual');
  controller.start();

  controller.executionAgent.run = async () => [{ status: 'skipped', reason: 'command_not_allowed' }];
  await controller.runCycle('t1');
  await controller.runCycle('t2');

  const stateAfterFailures = controller.learningStore.get('strat');
  assert.equal(Boolean(stateAfterFailures.cooldownUntil), true);
  const failedRun = await controller.runCycle('t3');
  assert.equal(failedRun.status, 'failed');

  stateAfterFailures.cooldownUntil = new Date(Date.now() - 1000).toISOString();
  controller.learningStore.save();
  controller.executionAgent.run = async () => ({ results: [{ strategyId: 'strat', status: 'simulated' }] });
  const successRun = await controller.runCycle('t4');
  assert.equal(successRun.status, 'success');
  assert.equal(controller.learningStore.get('strat').confidence > 0.5, true);
});
