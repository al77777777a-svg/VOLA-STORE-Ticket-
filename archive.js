'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
function page(ticket, text) {
  const closed = ticket.closedAt ? new Date(ticket.closedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VOLA STORE • Ticket</title><style>body{margin:0;background:#08162d;color:#eaf2ff;font-family:Tahoma,Arial,sans-serif}main{max-width:980px;margin:auto;padding:30px 16px}header,.log{background:#0b1d3c;border:1px solid #45699f;border-radius:18px;padding:22px}h1{margin:0}p{color:#b9d2f6}.log{background:#061126;margin-top:16px;overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:14px/1.7 Consolas,monospace}.pill{display:inline-block;margin:10px 6px 0 0;padding:7px 11px;border:1px solid #385780;border-radius:999px;color:#b9d2f6}</style></head><body><main><header><h1>VOLA STORE • Ticket Transcript</h1><p>نسخة أرشيفية خاصة للتذكرة — لا تشارك الرابط خارج الإدارة.</p><span class="pill">Ticket: ' + escapeHtml(ticket.channelId) + '</span><span class="pill">Closed: ' + escapeHtml(closed) + '</span></header><section class="log"><pre>' + escapeHtml(text) + '</pre></section></main></body></html>';
}
function saveArchive(store, ticket, filename) {
  const token = crypto.randomBytes(32).toString('base64url');
  const dir = path.join(store.dir, 'web-transcripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, token + '.html'), page(ticket, fs.readFileSync(filename, 'utf8')), { mode: 0o600, flag: 'wx' });
  return token;
}
function startArchiveServer(store) {
  const port = Number(process.env.PORT || 3000);
  const server = require('node:http').createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
      if (url.pathname === '/' || url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(req.method === 'HEAD' ? '' : 'VOLA archive online'); }
      const match = /^\/tickets\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
      if (!match || !TOKEN.test(match[1])) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
      const file = path.join(store.dir, 'web-transcripts', match[1] + '.html');
      if (!fs.existsSync(file)) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
      const html = fs.readFileSync(file, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
      return res.end(req.method === 'HEAD' ? '' : html);
    } catch { res.writeHead(500, { 'Cache-Control': 'no-store' }); return res.end(); }
  });
  server.listen(port, '0.0.0.0');
  return server;
}
module.exports = { saveArchive, startArchiveServer };
