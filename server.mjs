#!/usr/bin/env node
/**
 * AiLGNS 观测站 · 本地服务
 * 用法： node server.mjs  [端口]
 * 打开： http://localhost:8787
 * 页面上的「刷新」按钮会调用 POST /api/refresh，立即重新抓取一次。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

let collecting = null;
async function collect() {
  if (collecting) return collecting;
  collecting = (async () => {
    return await import('./collect-chain.mjs?t=' + Date.now());
  })().finally(() => { setTimeout(() => { collecting = null; }, 500); });
  return collecting;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);

  if (path === '/api/refresh') {
    if (req.method !== 'POST') { res.writeHead(405).end('use POST'); return; }
    try {
      const t0 = Date.now();
      await collect();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
         .end(JSON.stringify({ ok: true, ms: Date.now() - t0 }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
         .end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
    return;
  }

  if (path === '/api/addr') {
    res.writeHead(410, { 'content-type': 'application/json; charset=utf-8' })
       .end(JSON.stringify({ ok:false, error:'已切换为链上原生查询，请在 check.html 直接输入钱包地址' }));
    return;
  }

  if (path === '/') path = '/index.html';
  const file = join(DIR, path);
  if (!file.startsWith(DIR)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const s = await stat(file);
    if (s.isDirectory()) { res.writeHead(404).end('not found'); return; }
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(buf);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(PORT, () => {
  console.log('AiLGNS 观测站已启动： http://localhost:' + PORT);
  console.log('首次启动会自动抓取一次数据…');
  collect().catch(function (e) { console.error('抓取失败：', e.message); });
});
