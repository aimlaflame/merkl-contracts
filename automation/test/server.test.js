const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AutopilotController } = require('../src/controller');
const { createServer } = require('../src/server');

function makeConfig() {
  return {
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
    api: { host: '127.0.0.1', port: 0, adminApiKeys: ['admin'], viewerApiKeys: ['viewer'] },
    observability: {
      logPath: path.join('/tmp', `autopilot-server-test-${Date.now()}-${Math.random()}.log`),
      learningStatePath: path.join('/tmp', `autopilot-server-learning-${Date.now()}-${Math.random()}.json`),
    },
    strategies: [],
  };
}

async function setup() {
  const config = makeConfig();
  const controller = new AutopilotController(config);
  const server = createServer(controller, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return { controller, server, base };
}

test('dashboard endpoint requires auth', async () => {
  const { controller, server, base } = await setup();
  try {
    const noAuth = await fetch(`${base}/`);
    assert.equal(noAuth.status, 401);

    const withAuth = await fetch(`${base}/`, { headers: { 'x-api-key': 'viewer' } });
    assert.equal(withAuth.status, 200);
  } finally {
    controller.stop();
    server.close();
  }
});

test('only /alerts/:id/ack acknowledges alerts', async () => {
  const { controller, server, base } = await setup();
  try {
    const alert = controller.pushAlert('high', 'test alert');

    const wrongRoute = await fetch(`${base}/alerts/${alert.id}`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin' },
    });
    assert.equal(wrongRoute.status, 404);
    assert.equal(controller.state.alerts[0].acknowledged, false);

    const ackRoute = await fetch(`${base}/alerts/${alert.id}/ack`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin' },
    });
    assert.equal(ackRoute.status, 200);
    assert.equal(controller.state.alerts[0].acknowledged, true);
  } finally {
    controller.stop();
    server.close();
  }
});

test('mode endpoint supports valid and invalid requests', async () => {
  const { controller, server, base } = await setup();
  try {
    const startResp = await fetch(`${base}/start`, { method: 'POST', headers: { 'x-api-key': 'admin' } });
    assert.equal(startResp.status, 200);

    const valid = await fetch(`${base}/mode`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    });
    assert.equal(valid.status, 200);

    const invalidMode = await fetch(`${base}/mode`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'invalid' }),
    });
    assert.equal(invalidMode.status, 400);

    const invalidJson = await fetch(`${base}/mode`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin', 'content-type': 'application/json' },
      body: '{bad-json',
    });
    assert.equal(invalidJson.status, 400);
  } finally {
    controller.stop();
    server.close();
  }
});

test('run-now returns conflict while paused', async () => {
  const { controller, server, base } = await setup();
  try {
    const resp = await fetch(`${base}/run-now`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin' },
    });
    assert.equal(resp.status, 409);
  } finally {
    controller.stop();
    server.close();
  }
});

test('health endpoint returns 503 when paused and 200 when running', async () => {
  const { controller, server, base } = await setup();
  try {
    const paused = await fetch(`${base}/health`);
    assert.equal(paused.status, 503);

    await fetch(`${base}/start`, { method: 'POST', headers: { 'x-api-key': 'admin' } });
    const running = await fetch(`${base}/health`);
    assert.equal(running.status, 200);
  } finally {
    controller.stop();
    server.close();
  }
});

test('run-now succeeds when started', async () => {
  const { controller, server, base } = await setup();
  try {
    controller.config.strategies = [
      {
        id: 's1',
        chainId: 1,
        protocol: 'uniswap',
        expectedAprBps: 1200,
        riskScore: 10,
        maxCapitalUsd: 1000,
        action: { file: 'node', args: ['-e', 'console.log(1)'] },
      },
    ];
    const start = await fetch(`${base}/start`, { method: 'POST', headers: { 'x-api-key': 'admin' } });
    assert.equal(start.status, 200);
    const run = await fetch(`${base}/run-now`, { method: 'POST', headers: { 'x-api-key': 'admin' } });
    assert.equal(run.status, 200);
  } finally {
    controller.stop();
    server.close();
  }
});

test('run-now overlap returns conflict', async () => {
  const { controller, server, base } = await setup();
  try {
    controller.config.strategies = [
      {
        id: 's2',
        chainId: 1,
        protocol: 'uniswap',
        expectedAprBps: 1200,
        riskScore: 10,
        maxCapitalUsd: 1000,
        action: { file: 'node', args: ['-e', 'console.log(2)'] },
      },
    ];
    controller.executionAgent.run = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { results: [], executedAt: new Date().toISOString(), args };
    };

    await fetch(`${base}/start`, { method: 'POST', headers: { 'x-api-key': 'admin' } });
    const firstPromise = fetch(`${base}/run-now`, { method: 'POST', headers: { 'x-api-key': 'admin' } });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await fetch(`${base}/run-now`, { method: 'POST', headers: { 'x-api-key': 'admin' } });
    assert.equal(second.status, 409);
    const first = await firstPromise;
    assert.equal(first.status, 200);
  } finally {
    controller.stop();
    server.close();
  }
});

test('learning reset endpoint clears learning state', async () => {
  const { controller, server, base } = await setup();
  try {
    controller.learningStore.recordOutcome('seed', 'failed', { error: 'x' });
    const before = await fetch(`${base}/status`, { headers: { 'x-api-key': 'admin' } });
    const beforeJson = await before.json();
    assert.equal(Boolean(beforeJson.learning.strategies.seed), true);

    const reset = await fetch(`${base}/learning/reset`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin' },
    });
    assert.equal(reset.status, 200);

    const after = await fetch(`${base}/status`, { headers: { 'x-api-key': 'admin' } });
    const afterJson = await after.json();
    assert.equal(Object.keys(afterJson.learning.strategies).length, 0);
  } finally {
    controller.stop();
    server.close();
  }
});
