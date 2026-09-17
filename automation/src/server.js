const http = require('node:http');
const crypto = require('node:crypto');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    const maxLength = 1024 * 32;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      totalLength += chunk.length;
      if (totalLength > maxLength) {
        const tooLarge = new Error('Request body too large');
        tooLarge.statusCode = 413;
        rejected = true;
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.destroy();
        reject(tooLarge);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        const parseError = new Error('Invalid JSON body');
        parseError.statusCode = 400;
        reject(parseError);
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
  <label for="key">API key</label>
  <div class="row"><input id="key" type="password" placeholder="API key" style="width:100%"/></div>
  <div id="sr-status" role="status" aria-live="polite"></div>
  <div class="row">
    <button id="start-btn">Start</button>
    <button id="stop-btn">Stop</button>
    <button id="run-btn">Run now</button>
    <button id="mode-auto-btn">Mode auto</button>
    <button id="mode-manual-btn">Mode manual</button>
    <button id="reset-learning-btn">Reset learning</button>
    <button id="refresh-btn">Refresh</button>
  </div>
  <pre id="out">Loading...</pre>
  <script>
    function announce(message){document.getElementById('sr-status').textContent=message;}
    let cachedApiKey='';
    async function req(path, method='GET', body){
      if(!cachedApiKey){
        cachedApiKey=document.getElementById('key').value.trim();
        document.getElementById('key').value='';
      }
      const key=cachedApiKey;
      const headers={'content-type':'application/json','x-api-key':key};
      if(method!=='GET'){
        const csrf=await req('/csrf');
        headers['x-csrf-token']=csrf.token;
      }
      const res=await fetch(path,{method,headers,body:body?JSON.stringify(body):undefined});
      const raw=await res.text();
      let data={};
      if(raw){
        try{data=JSON.parse(raw);}catch(_e){data={error:raw};}
      }
      if(!res.ok) throw new Error(data.error||('request failed: '+res.status));
      return data;
    }
    async function load(){
      try{document.getElementById('out').textContent=JSON.stringify(await req('/status'),null,2);announce('Status loaded');}
      catch(e){document.getElementById('out').textContent=e.message;announce('Request failed: '+e.message);}
    }
    async function act(path){await req(path,'POST');announce('Action completed');await load();}
    async function setMode(mode){await req('/mode','POST',{mode});announce('Mode updated to '+mode);await load();}
    async function resetLearning(){await req('/learning/reset','POST');announce('Learning state reset');await load();}
    document.getElementById('start-btn').addEventListener('click',()=>act('/start'));
    document.getElementById('stop-btn').addEventListener('click',()=>act('/stop'));
    document.getElementById('run-btn').addEventListener('click',()=>act('/run-now'));
    document.getElementById('mode-auto-btn').addEventListener('click',()=>setMode('auto'));
    document.getElementById('mode-manual-btn').addEventListener('click',()=>setMode('manual'));
    document.getElementById('reset-learning-btn').addEventListener('click',resetLearning);
    document.getElementById('refresh-btn').addEventListener('click',load);
    load();
  </script>
</body>
</html>`;
}

function createServer(controller, config) {
  const csrfTokens = new Set();

  function issueCsrfToken() {
    const token = crypto.randomUUID();
    csrfTokens.add(token);
    if (csrfTokens.size > 500) {
      const first = csrfTokens.values().next().value;
      csrfTokens.delete(first);
    }
    return token;
  }

  function verifyCsrf(req) {
    const methodNeedsCsrf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '');
    if (!methodNeedsCsrf) return true;
    if (!req.headers.origin && !req.headers.referer) return true;
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !csrfTokens.has(token)) return false;
    csrfTokens.delete(token);
    return true;
  }

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
        if (!requireRole(req, res, ['admin', 'viewer'])) return;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlDashboard());
        return;
      }

      if (req.method === 'GET' && req.url === '/csrf') {
        if (!requireRole(req, res, ['admin', 'viewer'])) return;
        const token = issueCsrfToken();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token }));
        return;
      }

      if (!verifyCsrf(req)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'csrf_validation_failed' }));
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        const ready =
          controller.state.health.status === 'running' &&
          controller.state.startedAt !== null &&
          controller.state.paused === false;
        res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: ready,
            liveness: true,
            readiness: ready,
            status: controller.state.health.status,
            heartbeatAt: controller.state.health.lastHeartbeatAt,
          }),
        );
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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(controller.getStatus()));
        return;
      }

      if (req.method === 'POST' && req.url === '/learning/reset') {
        if (!requireRole(req, res, ['admin'])) return;
        const learning = controller.resetLearning();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ learning }));
        return;
      }

      const alertAckMatch = req.method === 'POST' ? req.url.match(/^\/alerts\/([^/]+)\/ack$/) : null;
      if (alertAckMatch) {
        if (!requireRole(req, res, ['admin'])) return;
        let id;
        try {
          id = decodeURIComponent(alertAckMatch[1]);
        } catch (_error) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_alert_id' }));
          return;
        }
        const ok = controller.acknowledgeAlert(id);
        res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      const statusCode = error.statusCode || 500;
      const responseError = statusCode >= 500 ? 'internal_server_error' : error.message;
      if (statusCode >= 500 && typeof controller.auditLog === 'function') {
        controller.auditLog('server.error', { message: error.message, stack: error.stack });
      }
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: responseError }));
    }
  }

  return http.createServer(handle);
}

module.exports = {
  createServer,
};
