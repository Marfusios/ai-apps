/**
 * Node's HTTP parser refuses some requests before Fastify sees them (`clientError`: a
 * malformed request line or header, an oversized header, a request timeout). Fastify's
 * default handler answers without our security headers; this one writes a minimal
 * `ErrorResponse` with them straight to the socket and closes it.
 *
 * It must never throw: it runs on a socket that may already be destroyed or unwritable.
 */
import type { Socket } from 'node:net';
import type { ErrorResponse } from '../../shared/contracts/common.js';
import type { TrustedProxies } from './network-identity.js';
import { ERROR_MESSAGES } from './reply.js';

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 408: 'Request Timeout', 431: 'Request Header Fields Too Large' };

function statusOf(err: unknown): number {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ERR_HTTP_REQUEST_TIMEOUT') return 408;
  if (code === 'HPE_HEADER_OVERFLOW') return 431;
  return 400;
}

/** The raw response; `forbidden` answers 403 (a peer that is not the tunnel connector) instead of the parser's status. */
export function clientErrorResponse(err: unknown, headers: Readonly<Record<string, string>>, forbidden = false): string {
  const status = forbidden ? 403 : statusOf(err);
  const body: ErrorResponse = forbidden
    ? { error: 'forbidden', message: ERROR_MESSAGES.forbidden }
    : { error: 'bad_request', message: ERROR_MESSAGES.bad_request };
  const json = JSON.stringify(body);
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Bad Request'}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(json)}`,
    'Cache-Control: no-store',
    'Connection: close',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  return `${lines.join('\r\n')}\r\n\r\n${json}`;
}

export interface ClientErrorOptions {
  /** Tunnel mode: only these peers get an answer from us; any other peer gets 403. */
  trusted?: TrustedProxies | null;
}

/**
 * A `clientErrorHandler` for Fastify/Node, with the app's security headers. The socket is
 * destroyed after the answer is flushed: Node's HTTP server allows half-open sockets, so
 * `end()` alone would leave a silent client connected (and `close()` waiting) indefinitely.
 */
export function makeClientErrorHandler(
  headers: Readonly<Record<string, string>>,
  opts: ClientErrorOptions = {},
): (err: Error, socket: Socket) => void {
  return (err, socket) => {
    const destroy = () => {
      try {
        socket.destroy();
      } catch {
        // Nothing left to do for this connection.
      }
    };
    try {
      if (socket.destroyed || !socket.writable) return destroy();
      // A response on this socket (a pipelined request) has already started: a second one would corrupt it.
      if ((socket as { _httpMessage?: { _headerSent?: boolean } })._httpMessage?._headerSent) return destroy();
      let forbidden = false;
      if (opts.trusted) {
        const peer = socket.remoteAddress;
        if (!peer) return destroy();
        forbidden = !opts.trusted.contains(peer);
      }
      socket.end(clientErrorResponse(err, headers, forbidden), destroy);
      // If the peer never reads the answer, do not wait for it forever.
      setTimeout(destroy, 1_000).unref();
    } catch {
      destroy();
    }
  };
}
