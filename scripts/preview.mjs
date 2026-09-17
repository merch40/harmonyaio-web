import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.HARMONY_PREVIEW_PORT || 4178);
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png', '.mp4':'video/mp4', '.vtt':'text/vtt; charset=utf-8', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };
const server = http.createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) {
      res.writeHead(403, {'content-type':'application/json'});
      return res.end(JSON.stringify({ error:'Local design preview. External services are disabled.' }));
    }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    let file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (!path.extname(file)) file += '.html';
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404); return res.end(); }
    const headers = { 'content-type':types[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-store', 'accept-ranges':'bytes', 'x-content-type-options':'nosniff' };
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]),info.size-1) : info.size-1;
      if (start >= info.size || end < start) { res.writeHead(416,{'content-range':`bytes */${info.size}`}); return res.end(); }
      res.writeHead(206,{...headers,'content-range':`bytes ${start}-${end}/${info.size}`,'content-length':end-start+1});
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file,{start,end}).pipe(res);
    }
    res.writeHead(200,{...headers,'content-length':info.size});
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404,{'content-type':'text/plain'}); res.end('Page not found.'); }
});
server.listen(port,'127.0.0.1',()=>console.log(`Harmony prototype: http://127.0.0.1:${port}`));
