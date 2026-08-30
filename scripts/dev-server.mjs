import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
process.env.APP_ORIGIN ||= `http://localhost:${port}`;
process.env.TURSO_DATABASE_URL ||= `file:${path.join(root, '.local', 'development.db').replaceAll('\\', '/')}`;
await mkdir(path.join(root, '.local'), { recursive: true });

const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const routes = new Set(['status', 'session', 'login', 'logout', 'proposals', 'health', 'admin', 'admin-page']);

export const devServer = http.createServer(async (req, res) => {
  try {
    for (const header of config.headers?.find((entry) => entry.source === '/(.*)')?.headers || []) {
      // Development uses loopback HTTP; production retains the HTTPS upgrade.
      res.setHeader(header.key, header.key === 'Content-Security-Policy'
        ? header.value.replace('; upgrade-insecure-requests', '') : header.value);
    }
    const url = new URL(req.url, process.env.APP_ORIGIN);
    if (url.pathname === '/health.json') url.pathname = '/api/health';
    if (url.pathname === '/admin' || url.pathname === '/admin/') url.pathname = '/api/admin-page';
    if (url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(5);
      if (!routes.has(route)) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '요청한 경로가 없습니다.' } }));
      }
      req.query = Object.fromEntries(url.searchParams);
      const { default: handler } = await import(pathToFileURL(path.join(root, 'api', `${route}.js`)).href);
      return await handler(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch {
      res.writeHead(400);
      return res.end('Bad request');
    }
    const file = path.resolve(publicRoot, pathname === '/' ? 'index.html' : `.${pathname}`);
    const relative = path.relative(publicRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some((segment) => segment.startsWith('.'))) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const metadata = await stat(file);
    if (!metadata.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': metadata.size,
    });
    return res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch (error) {
    if (res.headersSent) return res.end();
    const status = error?.code === 'ENOENT' ? 404 : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(status === 404 ? 'Not found' : '요청 처리 중 오류가 발생했습니다.');
    if (status === 500) console.error('Local request failed; check application configuration.');
  }
});

devServer.listen(port, '127.0.0.1', () => console.log(`yourga.me development server: http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => devServer.close(() => process.exit(0)));
