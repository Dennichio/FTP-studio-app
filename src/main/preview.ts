import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { assertSafeLocalPath, isDefaultExcluded, isSensitivePath } from '../core/workspace';

export const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm' };

/** Explicit local browser preview. No directory listing, PHP interpreter or upload route. */
export class PreviewServer {
  private servers = new Map<string, { server: Server; origin: string; token: string }>();
  private starting = new Map<string, Promise<void>>();
  private closed = false;
  async url(root: string, filename: string): Promise<string> {
    if (this.closed) throw new Error('De previewserver is gesloten.');
    root = await assertSafeLocalPath(root);
    filename = await assertSafeLocalPath(filename, root);
    if (this.closed) throw new Error('De previewserver is gesloten.');
    const relative = path.relative(root, filename).split(path.sep).join('/');
    if (isSensitivePath(relative) || isDefaultExcluded(relative)) throw new Error('Dit bestand mag niet via de previewserver worden gedeeld.');
    if (/\.(?:php\d*|phtml)$/i.test(filename)) throw new Error('PHP wordt niet automatisch uitgevoerd. Configureer een lokale PHP-preview-URL in het project.');
    if (!this.servers.has(root) && !this.starting.has(root)) {
      const start = (async () => {
      const token = randomBytes(24).toString('hex');
      // Cookies are scoped by hostname, not port: each project needs its own name.
      const cookieName = `ftp-preview-${token.slice(0, 16)}`;
      const server = createServer((req, res) => { void (async () => {
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
        if (req.headers.host !== host || req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(403).end(); return; }
        if (req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403).end(); return; }
        const requested = new URL(req.url || '/', `http://${host}`);
        // An HttpOnly cookie also permits root-relative asset URLs after opening the token URL.
        const authorized = req.headers.cookie?.split(';').some(c => c.trim() === `${cookieName}=${token}`);
        const prefix = `/__ftp_preview/${token}/`;
        let raw: string;
        if (requested.pathname.startsWith(prefix)) {
          raw = requested.pathname.slice(prefix.length);
          if (raw.startsWith('/')) { res.writeHead(403).end(); return; }
          res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
          res.writeHead(302, { Location: `/${raw}${requested.search}` }).end(); return;
        } else if (authorized) raw = requested.pathname.slice(1);
        else { res.writeHead(403).end('Previewtoegang geweigerd.'); return; }
        const decoded = decodeURIComponent(raw);
        if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..') || isSensitivePath(decoded) || isDefaultExcluded(decoded)) { res.writeHead(403).end(); return; }
        let target = await assertSafeLocalPath(path.resolve(root, decoded || '.'), root);
        let stat = await fs.stat(target);
        if (stat.isDirectory()) { target = await assertSafeLocalPath(path.join(target, 'index.html'), root); stat = await fs.stat(target); }
        const mime = mimeTypes[path.extname(target).toLowerCase()];
        if (!stat.isFile() || !mime || stat.size > 64 * 1024 * 1024) { res.writeHead(415).end('Bestandstype niet beschikbaar voor statische preview.'); return; }
        res.setHeader('Content-Type', mime); res.setHeader('Content-Length', stat.size);
        if (req.method === 'HEAD') res.end(); else res.end(await fs.readFile(target));
      })().catch(() => { if (!res.headersSent) res.writeHead(404); res.end('Bestand niet beschikbaar.'); }); });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      this.servers.set(root, { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token });
      })();
      this.starting.set(root, start);
      void start.finally(() => this.starting.delete(root)).catch(() => {});
    }
    await this.starting.get(root);
    const current = this.servers.get(root)!;
    return `${current.origin}/__ftp_preview/${current.token}/${relative.split('/').map(encodeURIComponent).join('/')}`;
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.starting.values()]); await Promise.all([...this.servers.values()].map(({ server }) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); this.servers.clear(); }
}
