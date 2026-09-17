const test = require('node:test');
const assert = require('node:assert/strict');
const { ExecutionAgent } = require('../src/agents');

function noopAudit() {}

test('execution agent simulates dry-run for allowed command', async () => {
  const agent = new ExecutionAgent(
    {
      mode: 'dry-run',
      allowedCommandPrefixes: ['node -e'],
      hotSignerEnvVar: 'HOT_SIGNER_PRIVATE_KEY',
      coldSignerAddressEnvVar: 'COLD_SIGNER_ADDRESS',
    },
    noopAudit,
  );

  const result = await agent.run([
    {
      strategyId: 's1',
      capitalUsd: 100,
      action: { command: 'node -e "console.log(1)"' },
    },
  ]);

  assert.equal(result.results[0].status, 'simulated');
});

test('execution agent skips disallowed command', async () => {
  const agent = new ExecutionAgent(
    {
      mode: 'dry-run',
      allowedCommandPrefixes: ['yarn foundry:script'],
      hotSignerEnvVar: 'HOT_SIGNER_PRIVATE_KEY',
      coldSignerAddressEnvVar: 'COLD_SIGNER_ADDRESS',
    },
    noopAudit,
  );

  const result = await agent.run([
    {
      strategyId: 's2',
      capitalUsd: 100,
      action: { command: 'node -e "console.log(1)"' },
    },
  ]);

  assert.equal(result.results[0].status, 'skipped');
  assert.equal(result.results[0].reason, 'command_not_allowed');
});

test('execution agent blocks live mode without signer policy', async () => {
  const oldHot = process.env.HOT_SIGNER_PRIVATE_KEY;
  const oldCold = process.env.COLD_SIGNER_ADDRESS;
  delete process.env.HOT_SIGNER_PRIVATE_KEY;
  delete process.env.COLD_SIGNER_ADDRESS;

  const agent = new ExecutionAgent(
    {
      mode: 'live',
      allowedCommandPrefixes: ['node -e'],
      hotSignerEnvVar: 'HOT_SIGNER_PRIVATE_KEY',
      coldSignerAddressEnvVar: 'COLD_SIGNER_ADDRESS',
    },
    noopAudit,
  );

  await assert.rejects(
    () =>
      agent.run([
        {
          strategyId: 's3',
          capitalUsd: 100,
          action: { command: 'node -e "console.log(1)"' },
        },
      ]),
    /Live execution requires configured hot and cold signer settings/,
  );

  if (oldHot !== undefined) process.env.HOT_SIGNER_PRIVATE_KEY = oldHot;
  if (oldCold !== undefined) process.env.COLD_SIGNER_ADDRESS = oldCold;
});

test('execution agent executes allowed live command asynchronously', async () => {
  const oldHot = process.env.HOT_SIGNER_PRIVATE_KEY;
  const oldCold = process.env.COLD_SIGNER_ADDRESS;
  process.env.HOT_SIGNER_PRIVATE_KEY = '0xabc';
  process.env.COLD_SIGNER_ADDRESS = '0x123';

  const agent = new ExecutionAgent(
    {
      mode: 'live',
      allowedCommandPrefixes: ['node -e'],
      hotSignerEnvVar: 'HOT_SIGNER_PRIVATE_KEY',
      coldSignerAddressEnvVar: 'COLD_SIGNER_ADDRESS',
    },
    noopAudit,
  );

  const result = await agent.run([
    {
      strategyId: 's4',
      capitalUsd: 100,
      action: { command: 'node -e "console.log(7)"' },
    },
  ]);

  assert.equal(result.results[0].status, 'executed');
  assert.equal(result.results[0].output, '7');

  if (oldHot !== undefined) process.env.HOT_SIGNER_PRIVATE_KEY = oldHot;
  else delete process.env.HOT_SIGNER_PRIVATE_KEY;
  if (oldCold !== undefined) process.env.COLD_SIGNER_ADDRESS = oldCold;
  else delete process.env.COLD_SIGNER_ADDRESS;
});
