const fs = require('node:fs');
const path = require('node:path');

class StrategyLearningStore {
  constructor(config, auditLog) {
    this.config = config;
    this.auditLog = auditLog;
    this.filePath = config.observability.learningStatePath;
    this.state = { updatedAt: null, strategies: {} };
    this.load();
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    this.ensureDir();
    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.strategies && typeof parsed.strategies === 'object') {
        this.state = parsed;
      }
    } catch (_error) {
      this.state = { updatedAt: null, strategies: {} };
      this.save();
    }
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  defaults() {
    return {
      confidence: 1,
      consecutiveFailures: 0,
      cooldownUntil: null,
      totalRuns: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalBlocked: 0,
      lastOutcome: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
  }

  get(strategyId) {
    if (!this.state.strategies[strategyId]) {
      this.state.strategies[strategyId] = this.defaults();
      this.save();
    }
    return this.state.strategies[strategyId];
  }

  peek(strategyId) {
    return this.state.strategies[strategyId] || this.defaults();
  }

  isCoolingDown(strategyId, now = Date.now()) {
    const entry = this.peek(strategyId);
    if (!entry.cooldownUntil) return false;
    return new Date(entry.cooldownUntil).getTime() > now;
  }

  effectiveConfidence(strategyId) {
    const entry = this.peek(strategyId);
    return entry.confidence;
  }

  recordOutcome(strategyId, outcome, details = {}) {
    const entry = this.get(strategyId);
    const adaptive = this.config.adaptive;

    entry.totalRuns += 1;
    entry.lastOutcome = outcome;
    entry.lastError = details.error || null;

    if (outcome === 'success') {
      entry.totalSuccess += 1;
      entry.consecutiveFailures = 0;
      entry.cooldownUntil = null;
      entry.confidence = Math.min(adaptive.maxConfidence, Number((entry.confidence + adaptive.successStep).toFixed(4)));
    } else if (outcome === 'blocked') {
      entry.totalBlocked += 1;
      entry.confidence = Math.max(adaptive.minConfidence, Number((entry.confidence - adaptive.blockedStep).toFixed(4)));
    } else {
      entry.totalFailed += 1;
      entry.consecutiveFailures += 1;
      entry.confidence = Math.max(adaptive.minConfidence, Number((entry.confidence - adaptive.failureStep).toFixed(4)));
      if (entry.consecutiveFailures >= adaptive.cooldownFailureThreshold) {
        const cooldownUntil = new Date(Date.now() + adaptive.cooldownMinutes * 60 * 1000).toISOString();
        entry.cooldownUntil = cooldownUntil;
        entry.consecutiveFailures = 0;
      }
    }

    entry.updatedAt = new Date().toISOString();
    this.save();
    this.auditLog('learning.updated', { strategyId, outcome, entry });
    return entry;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  reset() {
    this.state = { updatedAt: null, strategies: {} };
    this.save();
    this.auditLog('learning.reset');
    return this.snapshot();
  }
}

module.exports = {
  StrategyLearningStore,
};
