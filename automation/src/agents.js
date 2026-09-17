const { spawn } = require('node:child_process');

class OpportunityAgent {
  run(strategies) {
    const opportunities = strategies
      .map(strategy => ({
        ...strategy,
        score: strategy.expectedAprBps - strategy.riskScore * 10,
      }))
      .sort((a, b) => b.score - a.score);

    return {
      opportunities,
      discoveredAt: new Date().toISOString(),
    };
  }
}

class AllocationAgent {
  run(opportunityResult, policy) {
    const totalScore = opportunityResult.opportunities.reduce((sum, o) => sum + Math.max(o.score, 0), 0);
    const allocations = opportunityResult.opportunities.map(opportunity => {
      const proportionalCapital =
        totalScore > 0 ? (policy.totalCapitalUsd * Math.max(opportunity.score, 0)) / totalScore : 0;
      const bounded = Math.min(
        proportionalCapital,
        opportunity.maxCapitalUsd || policy.maxCapitalPerStrategyUsd,
        policy.maxCapitalPerStrategyUsd,
      );
      return {
        strategyId: opportunity.id,
        chainId: opportunity.chainId,
        protocol: opportunity.protocol,
        capitalUsd: Number(bounded.toFixed(2)),
        expectedAprBps: opportunity.expectedAprBps,
        action: opportunity.action,
      };
    });

    return { allocations };
  }
}

class GuardrailAgent {
  run(context, policy) {
    const reasons = [];

    if (context.market.gasGwei > policy.maxGasGwei) {
      reasons.push(`Gas ${context.market.gasGwei} > ${policy.maxGasGwei}`);
    }
    if (context.market.slippageBps > policy.maxSlippageBps) {
      reasons.push(`Slippage ${context.market.slippageBps} > ${policy.maxSlippageBps}`);
    }
    if (context.market.drawdownBps > policy.maxDrawdownBps) {
      reasons.push(`Drawdown ${context.market.drawdownBps} > ${policy.maxDrawdownBps}`);
    }

    const allocatedCapital = context.allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
    if (allocatedCapital > policy.totalCapitalUsd) {
      reasons.push(`Allocated ${allocatedCapital} > ${policy.totalCapitalUsd}`);
    }

    return {
      approved: reasons.length === 0,
      reasons,
      checkedAt: new Date().toISOString(),
    };
  }
}

class ExecutionAgent {
  constructor(executionConfig, auditLog) {
    this.executionConfig = executionConfig;
    this.auditLog = auditLog;
  }

  parseAllowlist(prefix) {
    return prefix
      .split(/\s+/)
      .map(token => token.trim())
      .filter(Boolean);
  }

  isAuthorized(tokens) {
    const allowlists = this.executionConfig.allowedCommandPrefixes.map(prefix => this.parseAllowlist(prefix));
    return allowlists.some(allowed => {
      if (allowed.length === 0 || tokens.length < allowed.length) return false;
      return allowed.every((token, i) => token === tokens[i]);
    });
  }

  signerPolicyReady() {
    const hotKey = this.executionConfig.hotSignerEnvVar;
    const coldKey = this.executionConfig.coldSignerAddressEnvVar;
    return Boolean(hotKey && process.env[hotKey]) && Boolean(coldKey && process.env[coldKey]);
  }

  childEnv() {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
    };
    const hotKey = this.executionConfig.hotSignerEnvVar;
    const coldKey = this.executionConfig.coldSignerAddressEnvVar;
    if (hotKey && process.env[hotKey]) env[hotKey] = process.env[hotKey];
    if (coldKey && process.env[coldKey]) env[coldKey] = process.env[coldKey];
    return env;
  }

  executeCommand(file, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        env: this.childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      child.stdout.on('data', chunk => out.push(chunk));
      child.stderr.on('data', chunk => err.push(chunk));
      child.on('error', error => reject(error));
      child.on('close', code => {
        if (code !== 0) {
          const stderr = Buffer.concat(err).toString('utf8').trim();
          const stdout = Buffer.concat(out).toString('utf8').trim();
          reject(new Error(stderr || stdout || `Command failed with code ${code}`));
          return;
        }
        resolve(Buffer.concat(out).toString('utf8').trim());
      });
    });
  }

  async run(allocations, options = {}) {
    const results = [];
    if (this.executionConfig.mode === 'live' && !options.simulationOnly && !this.signerPolicyReady()) {
      throw new Error('Live execution requires configured hot and cold signer settings');
    }

    for (const allocation of allocations) {
      if (allocation.capitalUsd <= 0) continue;
      const action = allocation.action || {};
      const tokens =
        typeof action.file === 'string' ? [action.file, ...(Array.isArray(action.args) ? action.args.map(String) : [])] : null;

      if (this.executionConfig.mode === 'live' && !options.simulationOnly && !tokens) {
        results.push({ strategyId: allocation.strategyId, status: 'skipped', reason: 'unstructured_command' });
        continue;
      }

      if (!tokens) {
        results.push({
          strategyId: allocation.strategyId,
          status: 'simulated',
          command: String(action.command || ''),
          capitalUsd: allocation.capitalUsd,
          note: 'simulation_only_unstructured_command',
        });
        continue;
      }

      const authorized = this.isAuthorized(tokens);
      if (!authorized) {
        results.push({ strategyId: allocation.strategyId, status: 'skipped', reason: 'command_not_allowed' });
        continue;
      }

      if (this.executionConfig.mode === 'dry-run' || options.simulationOnly) {
        results.push({
          strategyId: allocation.strategyId,
          status: 'simulated',
          command: tokens.join(' '),
          capitalUsd: allocation.capitalUsd,
        });
        continue;
      }

      const [file, ...args] = tokens;
      const output = await this.executeCommand(file, args);

      this.auditLog('execution.command_succeeded', {
        strategyId: allocation.strategyId,
        command: tokens.join(' '),
      });

      results.push({ strategyId: allocation.strategyId, status: 'executed', command: tokens.join(' '), output });
    }

    return { results, executedAt: new Date().toISOString() };
  }
}

module.exports = {
  OpportunityAgent,
  AllocationAgent,
  GuardrailAgent,
  ExecutionAgent,
};
