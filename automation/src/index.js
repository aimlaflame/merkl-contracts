const path = require('node:path');
const { loadConfig } = require('./config');
const { AutopilotController } = require('./controller');
const { createServer } = require('./server');

function main() {
  const rootDir = path.resolve(__dirname, '..', '..');
  const config = loadConfig(rootDir);
  const controller = new AutopilotController(config);

  controller.setMode(process.env.AUTOPILOT_MODE || 'manual');

  const server = createServer(controller, config);
  server.listen(config.api.port, config.api.host, () => {
    controller.auditLog('server.started', { host: config.api.host, port: config.api.port });
    // eslint-disable-next-line no-console
    console.log(`Merkl autopilot listening on http://${config.api.host}:${config.api.port}`);
  });
}

main();
