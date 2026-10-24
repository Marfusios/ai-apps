import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Client } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import { REQUEST_TIMEOUT_MS, buildApp, serializeLoggedError, withoutQueries } from '../../server/app.js';
import type { Db } from '../../server/db/client.js';
import { PRIVATE_NO_STORE, isNoStoreRoute } from '../../server/http/cache-headers.js';
import { clientErrorResponse, makeClientErrorHandler } from '../../server/http/client-error.js';
import { compileTrustedProxies } from '../../server/http/network-identity.js';
import { isHttpsUrl, securityHeaders } from '../../server/http/security-headers.js';

describe('cache headers by matched route', () => {
  it('covers AI, auth, account and brief routes, now and later', () => {
    for (const route of ['/api/ai/status', '/api/ai/ask', '/api/briefs', '/api/briefs/:id', '/api/auth/*', '/api/account', '/api/account/usage', '/api/AI/status']) {
      expect(isNoStoreRoute(route), route).toBe(true);
    }
    expect(PRIVATE_NO_STORE).toBe('private, no-store');
  });

  it('leaves public data routes and unmatched requests alone', () => {
    for (const route of ['/api/config', '/api/search', '/api/cases/:ntsbNo', '/api/dashboard', '/api/health', '/', '/*', '/api/aircraft', '/api/airports', '/api/authors', '/api/accounts', '/api/briefsX', undefined]) {
      expect(isNoStoreRoute(route), String(route)).toBe(false);
    }
  });
});

describe('isHttpsUrl', () => {
  it('reads the parsed scheme', () => {
    expect(isHttpsUrl('https://casebook.example')).toBe(true);
    expect(isHttpsUrl('HTTPS://casebook.example')).toBe(true);
    expect(isHttpsUrl('http://casebook.example')).toBe(false);
    expect(isHttpsUrl('http://x/https://')).toBe(false);
    expect(isHttpsUrl('not a url')).toBe(false);
  });
});

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  written = '';
  ended = false;
  remoteAddress: string | undefined = '203.0.113.2';
  _httpMessage: { _headerSent: boolean } | undefined;
  end(data: string, cb?: () => void) {
    this.written += data;
    this.ended = true;
    cb?.();
  }
  destroy() {
    this.destroyed = true;
  }
}

describe('client error handler', () => {
  const headers = securityHeaders({ hsts: true });

  it('writes a JSON ErrorResponse with the security headers and Connection: close', () => {
    const text = clientErrorResponse(Object.assign(new Error('x'), { code: 'HPE_INVALID_METHOD' }), headers);
    const [head, body] = text.split('\r\n\r\n') as [string, string];
    expect(head).toMatch(/^HTTP\/1\.1 400 Bad Request/);
    expect(head).toContain('Connection: close');
    expect(head).toContain('Cache-Control: no-store');
    expect(head).toContain('x-content-type-options: nosniff');
    expect(head).toContain('strict-transport-security: max-age=31536000');
    expect(head).toContain(`Content-Length: ${Buffer.byteLength(body)}`);
    expect(JSON.parse(body)).toEqual({ error: 'bad_request', message: 'The request is not valid.' });
    expect(clientErrorResponse(Object.assign(new Error('x'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }), headers)).toMatch(/^HTTP\/1\.1 408 /);
    expect(clientErrorResponse(Object.assign(new Error('x'), { code: 'HPE_HEADER_OVERFLOW' }), headers)).toMatch(/^HTTP\/1\.1 431 /);
  });

  it('does not write over a response already started on the socket (pipelining)', () => {
    const s = new FakeSocket();
    s._httpMessage = { _headerSent: true };
    makeClientErrorHandler(headers)(new Error('x'), s as unknown as Socket);
    expect(s.written).toBe('');
    expect(s.destroyed).toBe(true);
  });

  it('tunnel mode: a non-connector peer gets 403, an unknown peer nothing', () => {
    const trusted = compileTrustedProxies(['203.0.113.0/28']);
    const handle = makeClientErrorHandler(headers, { trusted });
    const stranger = new FakeSocket();
    stranger.remoteAddress = '192.0.2.5';
    handle(new Error('x'), stranger as unknown as Socket);
    expect(stranger.written).toMatch(/^HTTP\/1\.1 403 /);
    expect(stranger.written).toContain('"error":"forbidden"');
    const connector = new FakeSocket();
    handle(new Error('x'), connector as unknown as Socket);
    expect(connector.written).toMatch(/^HTTP\/1\.1 400 /);
    const unknown = new FakeSocket();
    unknown.remoteAddress = undefined;
    handle(new Error('x'), unknown as unknown as Socket);
    expect(unknown.written).toBe('');
    expect(unknown.destroyed).toBe(true);
  });

  it('never throws, whatever state the socket is in', () => {
    const handle = makeClientErrorHandler(headers);
    const ok = new FakeSocket();
    handle(new Error('x'), ok as unknown as Socket);
    expect(ok.ended).toBe(true);
    // The socket is destroyed once the answer is flushed (no lingering half-open client).
    expect(ok.destroyed).toBe(true);
    const gone = new FakeSocket();
    gone.destroyed = true;
    handle(new Error('x'), gone as unknown as Socket);
    expect(gone.written).toBe('');
    const unwritable = new FakeSocket();
    unwritable.writable = false;
    handle(new Error('x'), unwritable as unknown as Socket);
    expect(unwritable.destroyed).toBe(true);
    const throwing = {
      destroyed: false,
      writable: true,
      end() {
        throw new Error('EPIPE');
      },
      destroy() {
        throw new Error('already');
      },
    };
    expect(() => handle(new Error('x'), throwing as unknown as Socket)).not.toThrow();
    expect(() => handle(null as unknown as Error, throwing as unknown as Socket)).not.toThrow();
  });
});

describe('a request that never finishes arriving is ended (platform review P1)', () => {
  /** The app over nothing: these requests never reach a route that reads PostgreSQL or Elasticsearch. */
  async function listening(requestTimeoutMs?: number) {
    const app = buildApp({
      config: { appUrl: 'https://casebook.example', trustedProxyCidrs: [] },
      db: {} as Db,
      es: {} as Client,
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    return { app, port };
  }

  /** Send `head`, then `body` a byte every `trickleMs` (or nothing more); what came back and when the socket closed. */
  function stall(port: number, head: string, opts: { trickle?: string; trickleMs?: number; waitMs: number }) {
    return new Promise<{ response: string; closedAfterMs: number | null }>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      let response = '';
      const started = performance.now();
      let trickle: NodeJS.Timeout | undefined;
      const done = (closedAfterMs: number | null) => {
        clearInterval(trickle);
        clearTimeout(deadline);
        socket.destroy();
        resolve({ response, closedAfterMs });
      };
      const deadline = setTimeout(() => done(null), opts.waitMs);
      socket.on('data', (d) => (response += d.toString('utf8')));
      socket.on('error', () => undefined);
      socket.on('close', () => done(Math.round(performance.now() - started)));
      socket.write(head);
      if (opts.trickle) {
        let i = 0;
        trickle = setInterval(() => {
          if (i < opts.trickle!.length) socket.write(opts.trickle![i++]!);
        }, opts.trickleMs ?? 100);
      }
    });
  }

  const POST_HEAD = 'POST /api/briefs HTTP/1.1\r\nHost: casebook.example\r\nContent-Type: application/json\r\nContent-Length: 2000\r\n\r\n{"q';

  it('a body that stops arriving is answered 408 with the security headers, and the connection closed, within the bound', async () => {
    const { app, port } = await listening(1_000);
    try {
      const r = await stall(port, POST_HEAD, { waitMs: 6_000 });
      expect(r.closedAfterMs).not.toBeNull();
      expect(r.closedAfterMs!).toBeLessThan(3_000);
      expect(r.response).toMatch(/^HTTP\/1\.1 408 /);
      expect(r.response).toContain('x-content-type-options: nosniff');
      expect(r.response).toContain('Connection: close');
      expect(r.response.split('\r\n\r\n')[1]).toBe(JSON.stringify({ error: 'bad_request', message: 'The request is not valid.' }));
      // A body trickled a byte at a time is no different.
      const t = await stall(port, POST_HEAD, { trickle: 'x'.repeat(100), trickleMs: 100, waitMs: 6_000 });
      expect(t.closedAfterMs).not.toBeNull();
      expect(t.closedAfterMs!).toBeLessThan(3_000);
      expect(t.response).toMatch(/^HTTP\/1\.1 408 /);
      // Headers that never finish too.
      const h = await stall(port, 'GET /api/config HTTP/1.1\r\nHost: casebook.example\r\n', { waitMs: 6_000 });
      expect(h.closedAfterMs).not.toBeNull();
      expect(h.closedAfterMs!).toBeLessThan(3_000);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('the bound is a minute by default, with the headers inside it and stalled connections checked every 5 s', async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
    const { app } = await listening();
    try {
      expect(app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
      expect(app.server.headersTimeout).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
      // Every legitimate body here is at most 16 KB: a minute is ample.
      expect(app.initialConfig.bodyLimit).toBe(16 * 1024);
    } finally {
      await app.close();
    }
  });
});

describe('static files (platform review P6)', () => {
  it('never serves a dotfile or a dot directory from the web root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'casebook-web-'));
    try {
      writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
      writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      writeFileSync(join(root, '.env'), 'SECRET=1');
      mkdirSync(join(root, '.vite'));
      writeFileSync(join(root, '.vite', 'manifest.json'), '{"secret":true}');
      const app = buildApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: [] }, db: {} as Db, es: {} as Client, webRoot: root });
      try {
        const get = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '203.0.113.7' });
        expect((await get('/favicon.svg')).statusCode).toBe(200);
        for (const url of ['/.env', '/.vite/manifest.json', '/%2Eenv']) {
          const r = await get(url);
          expect(r.statusCode, url).toBe(404);
          expect(r.body, url).not.toContain('secret');
          expect(r.body, url).not.toContain('SECRET');
        }
      } finally {
        await app.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the brand assets in the web root', () => {
  it('the manifest is application/manifest+json; icons and the share card have their image types; all are revalidated hourly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'casebook-web-'));
    try {
      writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
      writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"AirCase"}\n');
      writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      writeFileSync(join(root, 'favicon.ico'), Buffer.from([0, 0, 1, 0, 0, 0]));
      mkdirSync(join(root, 'social'));
      writeFileSync(join(root, 'social', 'card.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      mkdirSync(join(root, 'assets'));
      writeFileSync(join(root, 'assets', 'app-0123abcd.js'), 'console.log(1);\n');
      const app = buildApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: [] }, db: {} as Db, es: {} as Client, webRoot: root });
      try {
        const get = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '203.0.113.7' });
        for (const [url, type] of [
          ['/manifest.webmanifest', 'application/manifest+json'],
          ['/favicon.svg', 'image/svg+xml'],
          ['/favicon.ico', 'image/vnd.microsoft.icon'],
          ['/social/card.png', 'image/png'],
        ] as const) {
          const r = await get(url);
          expect(r.statusCode, url).toBe(200);
          expect(r.headers['content-type'], url).toBe(type);
          expect(r.headers['cache-control'], url).toBe('public, max-age=3600');
        }
        // Vite's hashed bundles keep their long cache.
        expect((await get('/assets/app-0123abcd.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('logged errors carry their name and code, never their message (platform review P7)', () => {
  it('Fastify’s own warning about a reply sent twice keeps the request URL out of the log', async () => {
    const lines: string[] = [];
    const app = buildApp({
      config: { appUrl: 'https://casebook.example', trustedProxyCidrs: [] },
      db: {} as Db,
      es: {} as Client,
      logger: { level: 'debug', stream: { write: (line: string) => void lines.push(line) } },
    });
    // A handler that answers twice (a latent bug Fastify reports with the URL in the error message).
    app.get('/api/twice', async (_request, reply) => {
      void reply.code(200).send('{}');
      return reply.send('{}');
    });
    try {
      const r = await app.inject({ method: 'GET', url: '/api/twice?q=engine%20failure%20secret-term', remoteAddress: '203.0.113.7' });
      expect(r.statusCode).toBe(200);
      const warned = lines.map((l) => JSON.parse(l) as { err?: Record<string, unknown> }).find((l) => l.err?.code === 'FST_ERR_REP_ALREADY_SENT');
      expect(warned).toBeDefined();
      expect(Object.keys(warned!.err!).sort()).toEqual(['code', 'name']);
      for (const l of lines) expect(l).not.toContain('secret-term');
    } finally {
      await app.close();
    }
  });

  it('a message string keeps paths but loses their query strings', () => {
    expect(withoutQueries('Reply was already sent in the "/api/search?q=engine%20failure&page=2" (GET) route?')).toBe(
      'Reply was already sent in the "/api/search?…" (GET) route?',
    );
    expect(withoutQueries('no path here')).toBe('no path here');
    expect(withoutQueries('/api/cases/CEN24FA064')).toBe('/api/cases/CEN24FA064');
    expect(serializeLoggedError(Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:5432'), { code: 'ECONNREFUSED' }))).toEqual({ name: 'Error', code: 'ECONNREFUSED' });
    expect(serializeLoggedError({ name: 'ResponseError', type: 'search_phase_execution_exception' })).toEqual({ name: 'ResponseError', type: 'search_phase_execution_exception' });
    expect(serializeLoggedError({ name: 'has space', message: 'x' })).toEqual({});
  });
});
