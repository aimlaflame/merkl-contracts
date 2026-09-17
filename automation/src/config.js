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
  mode: 'dry-run',
};

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  const config = {
    scheduler: {
      dailyRunAtUtc: process.env.AUTOPILOT_DAILY_RUN_UTC || DEFAULTS.dailyRunAtUtc,
      maxAttempts: parseNumber(process.env.AUTOPILOT_RETRY_ATTEMPTS, DEFAULTS.maxAttempts),
      backoffMs: parseNumber(process.env.AUTOPILOT_RETRY_BACKOFF_MS, DEFAULTS.backoffMs),
    },
    policy: {
      maxGasGwei: parseNumber(process.env.AUTOPILOT_MAX_GAS_GWEI, DEFAULTS.maxGasGwei),
      maxSlippageBps: parseNumber(process.env.AUTOPILOT_MAX_SLIPPAGE_BPS, DEFAULTS.maxSlippageBps),
      maxDrawdownBps: parseNumber(process.env.AUTOPILOT_MAX_DRAWDOWN_BPS, DEFAULTS.maxDrawdownBps),
      totalCapitalUsd: parseNumber(process.env.AUTOPILOT_TOTAL_CAPITAL_USD, DEFAULTS.totalCapitalUsd),
      maxCapitalPerStrategyUsd: parseNumber(
        process.env.AUTOPILOT_MAX_CAPITAL_PER_STRATEGY_USD,
        DEFAULTS.maxCapitalPerStrategyUsd,
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
      port: parseNumber(process.env.AUTOPILOT_PORT, DEFAULTS.port),
      adminApiKeys: parseKeys(process.env.AUTOPILOT_ADMIN_API_KEYS),
      viewerApiKeys: parseKeys(process.env.AUTOPILOT_VIEWER_API_KEYS),
    },
    observability: {
      logPath,
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
  if (!['dry-run', 'live'].includes(config.execution.mode)) {
    throw new Error('AUTOPILOT_EXECUTION_MODE must be dry-run or live');
  }
  if (config.api.adminApiKeys.length === 0) {
    throw new Error('Configure AUTOPILOT_ADMIN_API_KEYS');
  }
}

module.exports = {
  loadConfig,
};
