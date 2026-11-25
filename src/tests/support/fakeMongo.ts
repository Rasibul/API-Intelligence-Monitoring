import mongoose from 'mongoose';
import { startTcpServer } from './tcpServer.js';
import type { FakeServer } from './tcpServer.js';

const { BSON } = mongoose.mongo;
type Document = Record<string, unknown>;

export interface FakeMongo extends FakeServer {
  readonly commands: string[];
  readonly uri: string;
}

/**
 * Minimal MongoDB wire-protocol peer, enough for the real Mongoose/driver pair
 * to connect, verify, ping and close. It stores nothing and proves nothing
 * about MongoDB itself.
 */
export async function startFakeMongo(
  options: {
    topology?: 'standalone' | 'replica_set' | 'sharded';
    auth?: 'none' | 'rejects_credentials' | 'requires_credentials';
    silent?: boolean;
  } = {},
): Promise<FakeMongo> {
  const { topology = 'replica_set', auth = 'none', silent = false } = options;
  const commands: string[] = [];
  const electionId = new BSON.ObjectId();

  function hello(): Document {
    const address = `127.0.0.1:${base.port}`;
    return {
      ok: 1,
      helloOk: true,
      ismaster: true,
      isWritablePrimary: true,
      maxBsonObjectSize: 16_777_216,
      maxMessageSizeBytes: 48_000_000,
      maxWriteBatchSize: 100_000,
      logicalSessionTimeoutMinutes: 30,
      minWireVersion: 0,
      maxWireVersion: 25,
      ...(topology === 'sharded' ? { msg: 'isdbgrid' } : {}),
      ...(topology === 'replica_set'
        ? {
            setName: 'rs0',
            setVersion: 1,
            electionId,
            hosts: [address],
            primary: address,
            me: address,
          }
        : {}),
    };
  }

  function reply(document: Document): Document {
    const name = Object.keys(document)[0]!;
    commands.push(name);
    if (['hello', 'ismaster', 'isMaster'].includes(name)) return hello();
    if (name.startsWith('sasl') && auth === 'rejects_credentials')
      return {
        ok: 0,
        code: 18,
        codeName: 'AuthenticationFailed',
        errmsg: 'Authentication failed for seeded-server-detail',
      };
    if (name === 'listCollections') {
      if (auth === 'requires_credentials')
        return {
          ok: 0,
          code: 13,
          codeName: 'Unauthorized',
          errmsg: 'requires authentication seeded-server-detail',
        };
      return {
        ok: 1,
        cursor: {
          id: BSON.Long.ZERO,
          ns: 'unit_test.$cmd.listCollections',
          firstBatch: [],
        },
      };
    }
    return { ok: 1 };
  }

  function respond(message: Buffer): Buffer {
    const requestId = message.readInt32LE(4);
    const opCode = message.readInt32LE(12);
    // OP_MSG carries one kind-0 section after its flags; OP_QUERY (the
    // driver's first handshake) a collection name and two integers.
    const start = opCode === 2013 ? 21 : message.indexOf(0, 20) + 9;
    const request = BSON.deserialize(
      message.subarray(start, start + message.readInt32LE(start)),
    ) as Document;
    const prefix = Buffer.alloc(opCode === 2013 ? 5 : 20);
    if (opCode !== 2013) prefix.writeInt32LE(1, 16);
    const body = Buffer.concat([prefix, BSON.serialize(reply(request))]);
    const header = Buffer.alloc(16);
    header.writeInt32LE(16 + body.length, 0);
    header.writeInt32LE(requestId, 8);
    header.writeInt32LE(opCode === 2013 ? 2013 : 1, 12);
    return Buffer.concat([header, body]);
  }

  const base = await startTcpServer((socket) => {
    let buffered: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (
        buffered.length >= 16 &&
        buffered.length >= buffered.readInt32LE(0)
      ) {
        const size = buffered.readInt32LE(0);
        const response = respond(buffered.subarray(0, size));
        buffered = buffered.subarray(size);
        if (!silent) socket.write(response);
      }
    });
  });

  return Object.defineProperties(base, {
    commands: { value: commands },
    uri: {
      get: () =>
        `mongodb://127.0.0.1:${base.port}/unit_test${topology === 'replica_set' ? '?replicaSet=rs0' : ''}`,
    },
  }) as FakeMongo;
}
