const { exec } = require('node:child_process');

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

  executeCommand(command) {
    return new Promise((resolve, reject) => {
      exec(
        command,
        {
          env: this.childEnv(),
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.trim() || error.message));
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }

  async run(allocations, options = {}) {
    const results = [];

    for (const allocation of allocations) {
      if (allocation.capitalUsd <= 0) continue;
      const command = allocation.action?.command || '';
      const authorized = this.executionConfig.allowedCommandPrefixes.some(prefix => command.startsWith(prefix));
      if (!authorized) {
        results.push({ strategyId: allocation.strategyId, status: 'skipped', reason: 'command_not_allowed' });
        continue;
      }

      if (this.executionConfig.mode === 'dry-run' || options.simulationOnly) {
        results.push({ strategyId: allocation.strategyId, status: 'simulated', command, capitalUsd: allocation.capitalUsd });
        continue;
      }

      const output = await this.executeCommand(command);

      this.auditLog('execution.command_succeeded', {
        strategyId: allocation.strategyId,
        command,
      });

      results.push({ strategyId: allocation.strategyId, status: 'executed', command, output });
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
