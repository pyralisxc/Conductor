import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Redis } from '@upstash/redis';

// Pinned official Redis 7.2 image. No ports, host mounts, credentials or persistence.
const image = 'redis:7.2@sha256:46f15cf64fdef63e483dcda99e74e3d51c017b1175547b6bb874152ee2391aad';
const exec = promisify(execFile);
export async function disposableRedis() {
  const name = `conductor-lua-test-${randomUUID()}`;
  const docker = (...args: string[]) => exec('docker', args, { timeout: 120000, maxBuffer: 1048576 });
  await docker('run', '--detach', '--rm', '--network', 'none', '--name', name, image,
    'redis-server', '--port', '0', '--unixsocket', '/tmp/redis.sock', '--save', '', '--appendonly', 'no');
  const command = async (args: (string | number)[]): Promise<unknown> => {
    try {
      const { stdout } = await docker('exec', name, 'redis-cli', '-s', '/tmp/redis.sock', '--json', '-e', ...args.map(String));
      return JSON.parse(stdout);
    } catch (error) {
      const failure = error as Error & { stdout?: string };
      throw new Error(failure.stdout || failure.message);
    }
  };
  let beforeCommand: ((args: (string | number)[]) => Promise<void>) | undefined;
  // Only adapt the REST envelope to redis-cli/RESP. No command or Lua is modeled.
  // Real Upstash serialization, base64 decoding, get/eval result and errors are used.
  const encode = (value: unknown): unknown => typeof value === 'string'
    ? value === 'OK' ? value : Buffer.from(value).toString('base64')
    : Array.isArray(value) ? value.map(encode) : value;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const args = JSON.parse(Buffer.concat(chunks).toString()) as (string | number)[];
      if (beforeCommand) await beforeCommand(args);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: encode(await command(args)) }));
    } catch (error) {
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  try {
    // docker run returns before Redis has necessarily opened its socket.
    for (let attempt = 0; ; attempt++) {
      try { await command(['PING']); break; }
      catch (error) { if (attempt >= 49) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local test listener');
    const client = new Redis({ url: `http://127.0.0.1:${address.port}`, token: 'disposable-test-only',
      automaticDeserialization: false, enableAutoPipelining: false, enableTelemetry: false, retry: false });
    return { client, command, before(fn?: typeof beforeCommand) { beforeCommand = fn; },
      async close() { await new Promise<void>(resolve => server.close(() => resolve())); await docker('rm', '--force', name); } };
  } catch (error) {
    server.close(); await docker('rm', '--force', name); throw error;
  }
}
