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
    process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
    controller.auditLog('server.shutdown', { signal });
    controller.stop(`signal_${signal}`);
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      controller.logStream.end();
    };
    const forcedShutdownTimer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      finalize();
    }, 5000);
    server.close(() => {
      clearTimeout(forcedShutdownTimer);
      finalize();
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
