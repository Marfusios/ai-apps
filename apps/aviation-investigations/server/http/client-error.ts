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
import { ERROR_MESSAGES } from './reply.js';

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 408: 'Request Timeout', 431: 'Request Header Fields Too Large' };

function statusOf(err: unknown): number {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ERR_HTTP_REQUEST_TIMEOUT') return 408;
  if (code === 'HPE_HEADER_OVERFLOW') return 431;
  return 400;
}

export function clientErrorResponse(err: unknown, headers: Readonly<Record<string, string>>): string {
  const status = statusOf(err);
  const body: ErrorResponse = { error: 'bad_request', message: ERROR_MESSAGES.bad_request };
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

/** A `clientErrorHandler` for Fastify/Node, with the app's security headers. */
export function makeClientErrorHandler(headers: Readonly<Record<string, string>>): (err: Error, socket: Socket) => void {
  return (err, socket) => {
    try {
      if (socket.destroyed || !socket.writable) {
        socket.destroy();
        return;
      }
      socket.end(clientErrorResponse(err, headers));
    } catch {
      try {
        socket.destroy();
      } catch {
        // Nothing left to do for this connection.
      }
    }
  };
}
