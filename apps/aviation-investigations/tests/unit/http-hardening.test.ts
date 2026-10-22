import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PRIVATE_NO_STORE, isNoStoreRoute } from '../../server/http/cache-headers.js';
import { clientErrorResponse, makeClientErrorHandler } from '../../server/http/client-error.js';
import { isHttpsUrl, securityHeaders } from '../../server/http/security-headers.js';

describe('cache headers by matched route', () => {
  it('covers AI, auth, account and brief routes, now and later', () => {
    for (const route of ['/api/ai/status', '/api/ai/ask', '/api/briefs', '/api/briefs/:id', '/api/auth/*', '/api/account', '/api/account/usage', '/api/accounts']) {
      expect(isNoStoreRoute(route), route).toBe(true);
    }
    expect(PRIVATE_NO_STORE).toBe('private, no-store');
  });

  it('leaves public data routes and unmatched requests alone', () => {
    for (const route of ['/api/config', '/api/search', '/api/cases/:ntsbNo', '/api/dashboard', '/api/health', '/', '/*', undefined]) {
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
  end(data: string) {
    this.written += data;
    this.ended = true;
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

  it('never throws, whatever state the socket is in', () => {
    const handle = makeClientErrorHandler(headers);
    const ok = new FakeSocket();
    handle(new Error('x'), ok as unknown as Socket);
    expect(ok.ended).toBe(true);
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
