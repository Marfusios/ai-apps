import { EventEmitter } from 'node:events';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Client } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import { REQUEST_TIMEOUT_MS, buildApp } from '../../server/app.js';
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
