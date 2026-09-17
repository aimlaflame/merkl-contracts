const path = require('node:path');
const { loadConfig } = require('./config');
const { AutopilotController } = require('./controller');
const { createServer } = require('./server');

function main() {
  const rootDir = path.resolve(__dirname, '..', '..');
  const config = loadConfig(rootDir);
  const controller = new AutopilotController(config);

  controller.setMode(process.env.AUTOPILOT_MODE || 'manual');
  controller.start();

  const server = createServer(controller, config);
  let shuttingDown = false;
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(config.api.port, config.api.host, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : config.api.port;
    controller.auditLog('server.started', { host: config.api.host, port: boundPort });
    // eslint-disable-next-line no-console
    console.log(`Merkl autopilot listening on http://${config.api.host}:${boundPort}`);
  });

  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.auditLog('server.shutdown', { signal });
    controller.stop(`signal_${signal}`);
    const forcedShutdownTimer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      controller.logStream.end(() => process.exit(0));
    }, 5000);
    server.close(() => {
      clearTimeout(forcedShutdownTimer);
      controller.logStream.end(() => process.exit(0));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
