/**
 * A minimal PostgreSQL server for offline tests of connection handling (gate 22 findings
 * 2 and 3): it completes the startup handshake (trust authentication, no TLS) and then
 * answers every query with one row (`1`), stalls (reads and never answers), or drops
 * connections, as the test asks. It speaks just enough of protocol 3.0 for node-postgres:
 * simple queries and the extended protocol (Parse, Bind, Describe, Execute, Sync).
 */
import { createServer, type Server, type Socket } from 'node:net';

export type FakePgMode = 'answer' | 'stall';

const SSL_REQUEST = 80877103;
const PROTOCOL_3 = 196608;

function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'ascii');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const int16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const cstring = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

/** The one column every answer has: its name, type (an OID, e.g. 23 int4, 16 bool) and text value. */
export interface FakeColumn {
  name: string;
  typeOid: number;
  value: string;
}

const rowDescription = (c: FakeColumn) =>
  message('T', Buffer.concat([int16(1), cstring(c.name), int32(0), int16(0), int32(c.typeOid), int16(-1), int32(-1), int16(0)]));
const dataRow = (c: FakeColumn) => message('D', Buffer.concat([int16(1), int32(Buffer.byteLength(c.value)), Buffer.from(c.value)]));
const COMMAND_COMPLETE = message('C', cstring('SELECT 1'));
const READY = message('Z', Buffer.from('I'));

export class FakePg {
  readonly sockets = new Set<Socket>();
  /** How queries are handled from now on (connections already open included). */
  mode: FakePgMode = 'answer';
  /** Query messages received (`Q` and `P`). */
  queries = 0;
  /** Connections accepted. */
  accepted = 0;
  /** What every query answers: one row of one column (default `?column?` int4 1). */
  column: FakeColumn = { name: '?column?', typeOid: 23, value: '1' };

  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakePg> {
    let fake: FakePg | null = null;
    const server = createServer((socket) => fake!.accept(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    fake = new FakePg(server, `postgres://tester:secret@127.0.0.1:${address.port}/fake`);
    return fake;
  }

  /** Drop every open connection at once (a PostgreSQL restart, an idle connection killed). */
  dropAll(): void {
    for (const s of this.sockets) s.destroy();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.accepted += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (!started) {
          if (buffered.length < 8) return;
          const length = buffered.readInt32BE(0);
          if (buffered.length < length) return;
          const code = buffered.readInt32BE(4);
          buffered = buffered.subarray(length);
          if (code === SSL_REQUEST) {
            socket.write('N');
            continue;
          }
          if (code !== PROTOCOL_3) {
            socket.destroy();
            return;
          }
          started = true;
          socket.write(
            Buffer.concat([message('R', int32(0)), message('S', Buffer.concat([cstring('server_version'), cstring('16.2')])), message('K', Buffer.concat([int32(1), int32(2)])), READY]),
          );
          continue;
        }
        if (buffered.length < 5) return;
        const type = String.fromCharCode(buffered[0]!);
        const length = buffered.readInt32BE(1);
        if (buffered.length < 1 + length) return;
        const body = buffered.subarray(5, 1 + length);
        buffered = buffered.subarray(1 + length);
        this.handle(socket, type, body);
      }
    });
  }

  private handle(socket: Socket, type: string, body: Buffer): void {
    if (type === 'X') {
      socket.end();
      return;
    }
    if (type === 'Q' || type === 'P') this.queries += 1;
    if (this.mode === 'stall') return;
    switch (type) {
      case 'Q':
        socket.write(Buffer.concat([rowDescription(this.column), dataRow(this.column), COMMAND_COMPLETE, READY]));
        return;
      case 'P':
        socket.write(message('1'));
        return;
      case 'B':
        socket.write(message('2'));
        return;
      case 'D':
        // A statement is described with its parameters first; a portal with its row only.
        socket.write(body[0] === 0x53 ? Buffer.concat([message('t', int16(0)), rowDescription(this.column)]) : rowDescription(this.column));
        return;
      case 'E':
        socket.write(Buffer.concat([dataRow(this.column), COMMAND_COMPLETE]));
        return;
      case 'C':
        socket.write(message('3'));
        return;
      case 'S':
        socket.write(READY);
        return;
      default:
        return;
    }
  }
}
