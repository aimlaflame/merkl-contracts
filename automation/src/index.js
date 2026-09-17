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
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : config.api.port;
    controller.auditLog('server.started', { host: config.api.host, port: boundPort });
    // eslint-disable-next-line no-console
    console.log(`Merkl autopilot listening on http://${config.api.host}:${boundPort}`);
  });
}

main();
