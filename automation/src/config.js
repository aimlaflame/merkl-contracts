const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  dailyRunAtUtc: '08:00',
  maxAttempts: 3,
  backoffMs: 30000,
  maxGasGwei: 35,
  maxSlippageBps: 100,
  maxDrawdownBps: 1500,
  totalCapitalUsd: 8000,
  maxCapitalPerStrategyUsd: 5000,
  host: '0.0.0.0',
  port: 8787,
  logPath: 'automation/state/audit.log',
  learningStatePath: 'automation/state/learning_state.json',
  mode: 'dry-run',
  adaptiveEnabled: true,
  minConfidence: 0.4,
  maxConfidence: 1.6,
  successStep: 0.05,
  failureStep: 0.1,
  blockedStep: 0.03,
  cooldownFailureThreshold: 2,
  cooldownMinutes: 180,
};

function parseNumber(value, fallback, name, options = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be numeric`);
  }
  if (options.integer && !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  if (options.min !== undefined && n < options.min) {
    throw new Error(`${name} must be >= ${options.min}`);
  }
  return n;
}

function parseKeys(value) {
  if (!value) return [];
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function resolvePath(rootDir, target) {
  return path.isAbsolute(target) ? target : path.join(rootDir, target);
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('Boolean env var must be true/false');
}

function loadStrategies(rootDir) {
  const strategiesPath =
    process.env.AUTOPILOT_STRATEGIES_PATH || path.join(rootDir, 'automation/config/strategies.json');
  const fallbackPath = path.join(rootDir, 'automation/config/strategies.example.json');
  const sourcePath = fs.existsSync(strategiesPath) ? strategiesPath : fallbackPath;
  const strategies = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

  return strategies.filter(s => s.enabled !== false);
}

function loadConfig(rootDir) {
  const logPath = resolvePath(rootDir, process.env.AUTOPILOT_AUDIT_LOG_PATH || DEFAULTS.logPath);
  const learningStatePath = resolvePath(rootDir, process.env.AUTOPILOT_LEARNING_STATE_PATH || DEFAULTS.learningStatePath);
  const config = {
    scheduler: {
      dailyRunAtUtc: process.env.AUTOPILOT_DAILY_RUN_UTC || DEFAULTS.dailyRunAtUtc,
      maxAttempts: parseNumber(process.env.AUTOPILOT_RETRY_ATTEMPTS, DEFAULTS.maxAttempts, 'AUTOPILOT_RETRY_ATTEMPTS', {
        integer: true,
        min: 1,
      }),
      backoffMs: parseNumber(process.env.AUTOPILOT_RETRY_BACKOFF_MS, DEFAULTS.backoffMs, 'AUTOPILOT_RETRY_BACKOFF_MS', {
        integer: true,
        min: 0,
      }),
    },
    policy: {
      maxGasGwei: parseNumber(process.env.AUTOPILOT_MAX_GAS_GWEI, DEFAULTS.maxGasGwei, 'AUTOPILOT_MAX_GAS_GWEI', { min: 0 }),
      maxSlippageBps: parseNumber(
        process.env.AUTOPILOT_MAX_SLIPPAGE_BPS,
        DEFAULTS.maxSlippageBps,
        'AUTOPILOT_MAX_SLIPPAGE_BPS',
        { min: 0 },
      ),
      maxDrawdownBps: parseNumber(
        process.env.AUTOPILOT_MAX_DRAWDOWN_BPS,
        DEFAULTS.maxDrawdownBps,
        'AUTOPILOT_MAX_DRAWDOWN_BPS',
        { min: 0 },
      ),
      totalCapitalUsd: parseNumber(
        process.env.AUTOPILOT_TOTAL_CAPITAL_USD,
        DEFAULTS.totalCapitalUsd,
        'AUTOPILOT_TOTAL_CAPITAL_USD',
        { min: 0 },
      ),
      maxCapitalPerStrategyUsd: parseNumber(
        process.env.AUTOPILOT_MAX_CAPITAL_PER_STRATEGY_USD,
        DEFAULTS.maxCapitalPerStrategyUsd,
        'AUTOPILOT_MAX_CAPITAL_PER_STRATEGY_USD',
        { min: 0 },
      ),
    },
    execution: {
      mode: process.env.AUTOPILOT_EXECUTION_MODE || DEFAULTS.mode,
      allowedCommandPrefixes: parseKeys(process.env.AUTOPILOT_ALLOWED_COMMAND_PREFIXES || 'yarn foundry:script'),
      hotSignerEnvVar: process.env.AUTOPILOT_HOT_SIGNER_ENV || 'HOT_SIGNER_PRIVATE_KEY',
      coldSignerAddressEnvVar: process.env.AUTOPILOT_COLD_SIGNER_ADDR_ENV || 'COLD_SIGNER_ADDRESS',
    },
    api: {
      host: process.env.AUTOPILOT_HOST || DEFAULTS.host,
      port: parseNumber(process.env.AUTOPILOT_PORT, DEFAULTS.port, 'AUTOPILOT_PORT', { integer: true, min: 1 }),
      adminApiKeys: parseKeys(process.env.AUTOPILOT_ADMIN_API_KEYS),
      viewerApiKeys: parseKeys(process.env.AUTOPILOT_VIEWER_API_KEYS),
    },
    observability: {
      logPath,
      learningStatePath,
    },
    adaptive: {
      enabled: parseBool(process.env.AUTOPILOT_ADAPTIVE_ENABLED, DEFAULTS.adaptiveEnabled),
      minConfidence: parseNumber(process.env.AUTOPILOT_MIN_CONFIDENCE, DEFAULTS.minConfidence, 'AUTOPILOT_MIN_CONFIDENCE', {
        min: 0.01,
      }),
      maxConfidence: parseNumber(process.env.AUTOPILOT_MAX_CONFIDENCE, DEFAULTS.maxConfidence, 'AUTOPILOT_MAX_CONFIDENCE', {
        min: 0.01,
      }),
      successStep: parseNumber(process.env.AUTOPILOT_SUCCESS_STEP, DEFAULTS.successStep, 'AUTOPILOT_SUCCESS_STEP', { min: 0 }),
      failureStep: parseNumber(process.env.AUTOPILOT_FAILURE_STEP, DEFAULTS.failureStep, 'AUTOPILOT_FAILURE_STEP', { min: 0 }),
      blockedStep: parseNumber(process.env.AUTOPILOT_BLOCKED_STEP, DEFAULTS.blockedStep, 'AUTOPILOT_BLOCKED_STEP', { min: 0 }),
      cooldownFailureThreshold: parseNumber(
        process.env.AUTOPILOT_COOLDOWN_FAILURE_THRESHOLD,
        DEFAULTS.cooldownFailureThreshold,
        'AUTOPILOT_COOLDOWN_FAILURE_THRESHOLD',
        { integer: true, min: 1 },
      ),
      cooldownMinutes: parseNumber(
        process.env.AUTOPILOT_COOLDOWN_MINUTES,
        DEFAULTS.cooldownMinutes,
        'AUTOPILOT_COOLDOWN_MINUTES',
        { integer: true, min: 1 },
      ),
    },
    strategies: loadStrategies(rootDir),
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!/^\d{2}:\d{2}$/.test(config.scheduler.dailyRunAtUtc)) {
    throw new Error('AUTOPILOT_DAILY_RUN_UTC must use HH:MM UTC format');
  }
  const [hh, mm] = config.scheduler.dailyRunAtUtc.split(':').map(Number);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error('AUTOPILOT_DAILY_RUN_UTC must be a valid UTC time');
  }
  if (!['dry-run', 'live'].includes(config.execution.mode)) {
    throw new Error('AUTOPILOT_EXECUTION_MODE must be dry-run or live');
  }
  if (config.adaptive.maxConfidence < config.adaptive.minConfidence) {
    throw new Error('AUTOPILOT_MAX_CONFIDENCE must be >= AUTOPILOT_MIN_CONFIDENCE');
  }
  if (config.api.adminApiKeys.length === 0) {
    throw new Error('Configure AUTOPILOT_ADMIN_API_KEYS');
  }
  if (config.api.viewerApiKeys.length === 0) {
    config.api.viewerApiKeys = [...config.api.adminApiKeys];
  }
}

module.exports = {
  loadConfig,
};
