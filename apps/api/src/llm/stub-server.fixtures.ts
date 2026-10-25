// A local HTTP server standing in for a provider, so adapter tests run the REAL SDK over a real socket:
// the SDK builds the request body and constructs its own error classes, and we assert on both.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly json: unknown;
}

export interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  /** The parsed JSON body (or the raw text when it was not JSON). */
  readonly body: unknown;
}

export interface StubServer {
  readonly url: string;
  readonly requests: StubRequest[];
  /** Answer every request (and the next ones) with this. */
  reply(reply: StubReply): void;
  /** Never answer: for abort tests. */
  hang(): void;
  close(): Promise<void>;
}

export async function startStub(): Promise<StubServer> {
  const requests: StubRequest[] = [];
  let current: StubReply | 'hang' = { json: {} };
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    req.on('end', () => {
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep the raw text
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (current === 'hang') return;
      res.writeHead(current.status ?? 200, {
        'content-type': 'application/json',
        ...(current.headers ?? {}),
      });
      res.end(JSON.stringify(current.json));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply: (reply) => {
      current = reply;
    },
    hang: () => {
      current = 'hang';
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
