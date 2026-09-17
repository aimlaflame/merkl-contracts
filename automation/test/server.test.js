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
    api: { host: '127.0.0.1', port: 0, adminApiKeys: ['admin'], viewerApiKeys: ['viewer'] },
    observability: { logPath: path.join('/tmp', `autopilot-server-test-${Date.now()}-${Math.random()}.log`) },
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
  const { server, base } = await setup();
  try {
    const noAuth = await fetch(`${base}/`);
    assert.equal(noAuth.status, 401);

    const withAuth = await fetch(`${base}/`, { headers: { 'x-api-key': 'viewer' } });
    assert.equal(withAuth.status, 200);
  } finally {
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
    server.close();
  }
});
