import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

export interface FakeServer {
  readonly port: number;
  readonly sockets: ReadonlySet<Socket>;
  /** Drops every connection and refuses new ones. */
  stop(): Promise<void>;
  /** Listens again on the same port. */
  start(): Promise<void>;
}

/** Loopback TCP server whose outages can be switched on and off. */
export async function startTcpServer(
  onConnection: (socket: Socket) => void,
): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  let port = 0;
  async function start() {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  }
  await start();
  return {
    get port() {
      return port;
    },
    sockets,
    start,
    async stop() {
      if (!server.listening) return;
      const closed = once(server, 'close');
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
