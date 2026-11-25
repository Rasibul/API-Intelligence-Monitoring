import { startTcpServer } from './tcpServer.js';
import type { FakeServer } from './tcpServer.js';

export interface FakeRedis extends FakeServer {
  readonly commands: string[];
  /** When false, accepts connections and commands but never replies. */
  responsive: boolean;
}

/**
 * Minimal RESP2 peer, enough for the real ioredis client to connect, ping and
 * quit. It is not Redis and proves nothing about Redis itself.
 */
export async function startFakeRedis(password?: string): Promise<FakeRedis> {
  const commands: string[] = [];
  const state = { responsive: true };

  const base = await startTcpServer((socket) => {
    let buffered = '';
    let authenticated = password === undefined;
    function reply(args: string[]): string {
      const name = args[0]!.toUpperCase();
      commands.push(name);
      if (name === 'AUTH') {
        authenticated = args.at(-1) === password;
        return authenticated
          ? '+OK\r\n'
          : '-WRONGPASS invalid username-password pair\r\n';
      }
      if (name === 'QUIT') return '+OK\r\n';
      if (!authenticated) return '-NOAUTH Authentication required.\r\n';
      if (name === 'PING') return '+PONG\r\n';
      if (name === 'INFO') {
        const info = 'redis_version:7.4.0\r\nloading:0\r\n';
        return `$${info.length}\r\n${info}\r\n`;
      }
      return '+OK\r\n';
    }
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      for (;;) {
        const lines = buffered.split('\r\n');
        const count = Number(lines[0]?.slice(1));
        // *N, then N pairs of $length and value, then a trailing fragment.
        if (!lines[0]?.startsWith('*') || lines.length < 2 * count + 2) return;
        const args = lines
          .slice(1, 2 * count + 1)
          .filter((_line, index) => index % 2 === 1);
        buffered = lines.slice(2 * count + 1).join('\r\n');
        if (!state.responsive) continue;
        socket.write(reply(args));
        if (args[0]!.toUpperCase() === 'QUIT') socket.end();
      }
    });
  });

  return Object.defineProperties(base, {
    commands: { value: commands },
    responsive: {
      get: () => state.responsive,
      set: (value: boolean) => {
        state.responsive = value;
      },
    },
  }) as FakeRedis;
}
