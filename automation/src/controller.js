const fs = require('node:fs');
const path = require('node:path');
const {
  OpportunityAgent,
  AllocationAgent,
  GuardrailAgent,
  ExecutionAgent,
} = require('./agents');

function parseUtcWindow(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  return { hh, mm };
}

function msUntilNextRun(hhmm) {
  const now = new Date();
  const { hh, mm } = parseUtcWindow(hhmm);
  const next = new Date(now);
  next.setUTCHours(hh, mm, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class AutopilotController {
  constructor(config) {
    this.config = config;
    this.state = {
      paused: true,
      mode: 'manual',
      startedAt: null,
      scheduler: { active: false, nextRunAt: null },
      runs: [],
      alerts: [],
      counters: { success: 0, failed: 0 },
      consecutiveExecutionFailures: 0,
      pnl: { realizedUsd: 0, estimatedAprBps: 0 },
      health: { status: 'idle', lastHeartbeatAt: null },
    };

    this.opportunityAgent = new OpportunityAgent();
    this.allocationAgent = new AllocationAgent();
    this.guardrailAgent = new GuardrailAgent();
    this.executionAgent = new ExecutionAgent(config.execution, this.auditLog.bind(this));
    this.schedulerTimer = null;
    this.schedulerLoopToken = 0;
    this.runInProgress = false;

    this.ensureLogDir();
    const fd = fs.openSync(this.config.observability.logPath, 'a');
    fs.closeSync(fd);
    this.logStream = fs.createWriteStream(this.config.observability.logPath, { flags: 'a' });
    this.logStream.on('error', error => {
      this.state.health.status = 'degraded';
      // eslint-disable-next-line no-console
      console.error('autopilot audit log stream error', error.message);
    });
  }

  ensureLogDir() {
    const dir = path.dirname(this.config.observability.logPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  auditLog(event, payload = {}) {
    const row = { ts: new Date().toISOString(), event, payload };
    this.logStream.write(`${JSON.stringify(row)}\n`);
  }

  requireSignerPolicy() {
    const hotSigner = process.env[this.config.execution.hotSignerEnvVar];
    const coldSignerAddress = process.env[this.config.execution.coldSignerAddressEnvVar];
    return {
      hotSignerConfigured: Boolean(hotSigner),
      coldSignerAddressConfigured: Boolean(coldSignerAddress),
    };
  }

  getMarketSnapshot() {
    return {
      gasGwei: Number(process.env.AUTOPILOT_GAS_GWEI || 20),
      slippageBps: Number(process.env.AUTOPILOT_SLIPPAGE_BPS || 20),
      drawdownBps: Number(process.env.AUTOPILOT_DRAWDOWN_BPS || 200),
    };
  }

  getStatus() {
    const { runs, ...rest } = this.state;
    return {
      ...rest,
      recentRuns: runs.slice(-20).reverse(),
      signerPolicy: this.requireSignerPolicy(),
      executionMode: this.config.execution.mode,
      schedule: this.config.scheduler.dailyRunAtUtc,
      strategies: this.config.strategies.map(s => ({ id: s.id, chainId: s.chainId, protocol: s.protocol })),
    };
  }

  getRunHistory() {
    return this.state.runs.slice().reverse();
  }

  acknowledgeAlert(alertId) {
    const alert = this.state.alerts.find(a => a.id === alertId);
    if (!alert) return false;
    alert.acknowledged = true;
    alert.acknowledgedAt = new Date().toISOString();
    this.auditLog('alert.acknowledged', { alertId });
    return true;
  }

  setMode(mode) {
    if (!['manual', 'auto'].includes(mode)) {
      const error = new Error('mode must be manual or auto');
      error.statusCode = 400;
      throw error;
    }
    this.state.mode = mode;
    if (mode === 'manual') this.stopScheduler();
    if (mode === 'auto' && !this.state.paused) this.startScheduler();
    this.auditLog('controller.mode_set', { mode });
  }

  start() {
    this.state.paused = false;
    this.state.startedAt = new Date().toISOString();
    this.state.health.status = 'running';
    this.state.health.lastHeartbeatAt = new Date().toISOString();
    this.auditLog('controller.started');
    if (this.state.mode === 'auto') this.startScheduler();
    return this.getStatus();
  }

  stop(reason = 'manual_stop') {
    this.state.paused = true;
    this.state.health.status = 'stopped';
    this.stopScheduler();
    this.auditLog('controller.stopped', { reason });
    return this.getStatus();
  }

  startScheduler() {
    this.stopScheduler();
    this.state.scheduler.active = true;
    const token = ++this.schedulerLoopToken;

    const scheduleNext = () => {
      if (token !== this.schedulerLoopToken || this.state.paused || this.state.mode !== 'auto') return;
      const ms = msUntilNextRun(this.config.scheduler.dailyRunAtUtc);
      this.state.scheduler.nextRunAt = new Date(Date.now() + ms).toISOString();
      this.schedulerTimer = setTimeout(async () => {
        try {
          await this.runCycle('scheduled');
        } finally {
          scheduleNext();
        }
      }, ms);
    };

    scheduleNext();
  }

  stopScheduler() {
    this.state.scheduler.active = false;
    this.state.scheduler.nextRunAt = null;
    ++this.schedulerLoopToken;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  pushAlert(severity, message, details = {}) {
    const alert = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      severity,
      message,
      details,
      acknowledged: false,
      createdAt: new Date().toISOString(),
    };
    this.state.alerts.unshift(alert);
    this.state.alerts = this.state.alerts.slice(0, 100);
    this.auditLog('alert.created', alert);
    return alert;
  }

  async runCycle(trigger = 'manual') {
    if (this.state.paused) {
      const error = new Error('Autopilot is paused');
      error.statusCode = 409;
      throw error;
    }
    if (this.runInProgress) {
      const error = new Error('Run already in progress');
      error.statusCode = 409;
      throw error;
    }
    this.runInProgress = true;

    try {
      const run = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        trigger,
        startedAt: new Date().toISOString(),
        status: 'running',
        attempts: 0,
        steps: [],
        errors: [],
      };

      const maxAttempts = this.config.scheduler.maxAttempts;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        run.attempts = attempt;
        try {
          const market = this.getMarketSnapshot();

          const opportunities = this.opportunityAgent.run(this.config.strategies);
          run.steps.push({ step: 'opportunity', count: opportunities.opportunities.length });

          const allocation = this.allocationAgent.run(opportunities, this.config.policy);
          run.steps.push({ step: 'allocation', count: allocation.allocations.length });

          const guard = this.guardrailAgent.run({ market, allocations: allocation.allocations }, this.config.policy);
          run.steps.push({ step: 'guardrail', approved: guard.approved, reasons: guard.reasons });

          if (!guard.approved) {
            run.status = 'blocked';
            run.finishedAt = new Date().toISOString();
            run.guardrailReasons = guard.reasons;
            this.state.counters.failed += 1;
            this.pushAlert('high', 'Guardrail blocked execution', { reasons: guard.reasons, runId: run.id });
            this.stop('guardrail_blocked');
            break;
          }

          const execution = await this.executionAgent.run(allocation.allocations, {
            simulationOnly: this.config.execution.mode !== 'live',
          });
          run.steps.push({ step: 'execution', results: execution.results });
          run.status = 'success';
          run.finishedAt = new Date().toISOString();

          this.state.counters.success += 1;
          this.state.consecutiveExecutionFailures = 0;
          this.state.pnl.estimatedAprBps = this.estimateApr(allocation.allocations);
          this.state.pnl.realizedUsd += this.estimateDailyPnl(allocation.allocations);

          this.auditLog('run.success', { runId: run.id, trigger, attempts: attempt });
          break;
        } catch (error) {
          run.errors.push({ attempt, message: error.message });
          this.auditLog('run.error', { runId: run.id, attempt, message: error.message });
          if (attempt < maxAttempts) await delay(this.config.scheduler.backoffMs);
        }
      }

      if (run.status === 'running') {
        run.status = 'failed';
        run.finishedAt = new Date().toISOString();
        this.state.counters.failed += 1;
        this.state.consecutiveExecutionFailures += 1;
        this.pushAlert('critical', 'Run failed after retries', { runId: run.id, errors: run.errors });
        if (this.state.consecutiveExecutionFailures >= 3) this.stop('repeated_failures');
      }

      this.state.runs.push(run);
      this.state.runs = this.state.runs.slice(-200);
      this.state.health.lastHeartbeatAt = new Date().toISOString();
      this.auditLog('run.completed', run);
      return run;
    } finally {
      this.runInProgress = false;
    }
  }

  estimateApr(allocations) {
    const total = allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
    if (!total) return 0;
    const weighted = allocations.reduce((sum, a) => sum + a.capitalUsd * a.expectedAprBps, 0);
    return Math.round(weighted / total);
  }

  estimateDailyPnl(allocations) {
    const yearly = allocations.reduce((sum, a) => sum + (a.capitalUsd * a.expectedAprBps) / 10000, 0);
    return Number((yearly / 365).toFixed(2));
  }
}

module.exports = {
  AutopilotController,
};
