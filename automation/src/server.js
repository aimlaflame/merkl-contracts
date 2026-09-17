const http = require('node:http');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function htmlDashboard() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Merkl Autopilot</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:0 auto;padding:16px;background:#0b1020;color:#e5e7eb}
    button,input{padding:10px;border-radius:8px;border:1px solid #334155;background:#111827;color:#e5e7eb}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
    pre{background:#111827;padding:12px;border-radius:8px;overflow:auto}
  </style>
</head>
<body>
  <h2>Merkl Autopilot Control</h2>
  <div class="row"><input id="key" placeholder="API key" style="width:100%"/></div>
  <div class="row">
    <button onclick="act('/start')">Start</button>
    <button onclick="act('/stop')">Stop</button>
    <button onclick="act('/run-now')">Run now</button>
    <button onclick="setMode('auto')">Mode auto</button>
    <button onclick="setMode('manual')">Mode manual</button>
    <button onclick="load()">Refresh</button>
  </div>
  <pre id="out">Loading...</pre>
  <script>
    async function req(path, method='GET', body){
      const key=document.getElementById('key').value.trim();
      const res=await fetch(path,{method,headers:{'content-type':'application/json','x-api-key':key},body:body?JSON.stringify(body):undefined});
      const data=await res.json();
      if(!res.ok) throw new Error(data.error||'request failed');
      return data;
    }
    async function load(){
      try{document.getElementById('out').textContent=JSON.stringify(await req('/status'),null,2)}
      catch(e){document.getElementById('out').textContent=e.message}
    }
    async function act(path){await req(path,'POST');await load();}
    async function setMode(mode){await req('/mode','POST',{mode});await load();}
    load();
  </script>
</body>
</html>`;
}

function createServer(controller, config) {
  function roleFor(req) {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string') return null;
    if (config.api.adminApiKeys.includes(key)) return 'admin';
    if (config.api.viewerApiKeys.includes(key)) return 'viewer';
    return null;
  }

  function requireRole(req, res, roles) {
    const role = roleFor(req);
    if (!role || !roles.includes(role)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return null;
    }
    return role;
  }

  async function handle(req, res) {
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlDashboard());
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, heartbeatAt: controller.state.health.lastHeartbeatAt }));
        return;
      }

      if (req.method === 'GET' && req.url === '/status') {
        if (!requireRole(req, res, ['admin', 'viewer'])) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(controller.getStatus()));
        return;
      }

      if (req.method === 'GET' && req.url === '/runs') {
        if (!requireRole(req, res, ['admin', 'viewer'])) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runs: controller.getRunHistory() }));
        return;
      }

      if (req.method === 'POST' && req.url === '/start') {
        if (!requireRole(req, res, ['admin'])) return;
        const data = controller.start();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'POST' && req.url === '/stop') {
        if (!requireRole(req, res, ['admin'])) return;
        const data = controller.stop();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'POST' && req.url === '/run-now') {
        if (!requireRole(req, res, ['admin'])) return;
        const run = await controller.runCycle('manual_api');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(run));
        return;
      }

      if (req.method === 'POST' && req.url === '/mode') {
        if (!requireRole(req, res, ['admin'])) return;
        const body = await parseBody(req);
        controller.setMode(body.mode);
        if (body.mode === 'auto' && !controller.state.paused) controller.startScheduler();
        if (body.mode === 'manual') controller.stopScheduler();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(controller.getStatus()));
        return;
      }

      if (req.method === 'POST' && req.url.startsWith('/alerts/')) {
        if (!requireRole(req, res, ['admin'])) return;
        const id = req.url.replace('/alerts/', '').replace('/ack', '');
        const ok = controller.acknowledgeAlert(id);
        res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  return http.createServer(handle);
}

module.exports = {
  createServer,
};
