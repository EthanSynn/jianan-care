// Xingyun session signing stays on the server. The browser never receives App Secret.
const https = require('https');
const crypto = require('crypto');
const upstream = new URL('https://nebula-agent.xingyun3d.com/user/v1/ttsa_v2/session');
function compare(a, b) {
  const x = Array.from(a, c => c.codePointAt(0)), y = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort(compare).map(k => [k, sorted(value[k])]));
}
function sign(data, method, secret, timestamp) {
  const canonical = JSON.stringify(sorted(data)).replace(/[^\u0000-\u007e]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).replace(/ /g, '');
  return crypto.createHash('md5').update(upstream.pathname.toLowerCase() + method.toLowerCase() + canonical + secret + timestamp).digest('hex');
}
function handleAvatar(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const persona = requestUrl.searchParams.get('persona') || 'jianan';
  const prefix = {jianan:'XINGYUN_', xiaoxian:'XINGYUN_XIAONUAN_', anxin:'XINGYUN_ANXIN_'}[persona] || '';
  const appId = process.env[prefix + 'APP_ID'] || '', secret = process.env[prefix + 'APP_SECRET'] || '';
  const reply = (status, value) => { if (!res.writableEnded) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); } };
  const fail = (status, message) => reply(status, {error_code:status, error_message:message, message});
  if (!['jianan','xiaoxian','anxin'].includes(persona)) { fail(400, '该角色尚未接入数字人'); return; }
  const pathname = req.url.split('?')[0];
  if (pathname === '/api/avatar/config' && req.method === 'GET') {
    reply(200, {configured:!!(appId && secret), appId, gateway:'/api/avatar/session?persona=' + persona}); return;
  }
  if (pathname !== '/api/avatar/session' || !['POST','DELETE'].includes(req.method)) { fail(405, '不支持的请求'); return; }
  // A signing endpoint must not accept cross-site browser requests.
  // 注意：公网部署在反向代理（CLB）后面，req.headers.host 会被改写成内部地址，
  // 用 origin 与 host 逐字比对在本机 localhost 能通过、到公网必然 403。
  // 精确来源白名单兼容反向代理；Render 使用平台自动注入的公开地址。
  let foreignOrigin = req.headers['sec-fetch-site'] === 'cross-site';
  try {
    if (req.headers.origin) {
      const requestOrigin = new URL(req.headers.origin);
      const allowedOrigins = new Set([
        'https://jianan-care.app.workbuddy.host',
        ...(process.env.XINGYUN_ALLOWED_ORIGINS || '').split(','),
        process.env.RENDER_EXTERNAL_URL || ''
      ].map(value => {
        try { return new URL(value.trim()).origin; } catch { return ''; }
      }).filter(Boolean));
      const allowed = (['localhost','127.0.0.1'].includes(requestOrigin.hostname)
          && ['http:','https:'].includes(requestOrigin.protocol))
        || allowedOrigins.has(requestOrigin.origin);
      if (!allowed) foreignOrigin = true;
    }
  } catch { foreignOrigin = true; }
  if (foreignOrigin) { fail(403, '仅允许同源访问'); return; }
  if (!appId || !secret) { fail(503, '尚未配置星云凭证'); return; }
  let raw = '', size = 0;
  req.on('data', chunk => { size += chunk.length; if (size <= 65536) raw += chunk; });
  req.on('end', () => {
    if (size > 65536) { fail(413, '请求过大'); return; }
    let data;
    try { data = JSON.parse(raw); if (!data || Array.isArray(data) || typeof data !== 'object') throw Error(); }
    catch { fail(400, '请求格式错误'); return; }
    const timestamp = String(Math.floor(Date.now()/1000));
    const body = JSON.stringify(sorted(data));
    const outgoing = https.request(upstream, {method:req.method, headers:{
      'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body),
      'X-APP-ID':appId, 'X-TIMESTAMP':timestamp, 'X-TOKEN':sign(data, req.method, secret, timestamp)
    }}, upstreamRes => {
      res.writeHead(upstreamRes.statusCode, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      upstreamRes.pipe(res);
    });
    outgoing.setTimeout(30000, () => outgoing.destroy(Error('timeout')));
    outgoing.on('error', () => { if (!res.headersSent) fail(502, '星云连接失败，请稍后重试'); else res.destroy(); });
    outgoing.end(body);
  });
}
module.exports = {handleAvatar, sign};
