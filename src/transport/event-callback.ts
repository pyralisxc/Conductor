import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');

export function publicCallbackAddress(address: string): boolean {
  // This narrow publisher uses IPv4 only; unsupported address families fail closed.
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}
export function callbackUrl(value: string, hostname: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== hostname || isIP(url.hostname) ||
      url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('Callback destination is not allowed');
  }
  return url;
}
export function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('Invalid webhook secret');
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded) throw new Error('Invalid webhook secret');
  return key;
}
export function webhookSignature(secret: string, id: string, timestamp: string, body: string): string {
  return `v1,${createHmac('sha256', signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}
export interface CallbackResponse { status: number; body: string }
export type CallbackPost = (url: string, body: string, headers: Record<string, string>) => Promise<CallbackResponse>;

/** Narrow I/O seam for offline DNS-to-socket tests. Production uses Node's resolver and HTTPS client. */
export interface CallbackNetwork {
  resolve(hostname: string, options: { all: true; family: 4 }): Promise<LookupAddress[]>;
  request(url: URL, options: RequestOptions, receive: (response: IncomingMessage) => void): ClientRequest;
}
const callbackNetwork: CallbackNetwork = { resolve: lookup, request };

/** DNS-only preflight; each actual send resolves and pins again. */
export async function validateCallbackRecipient(value: string, network: CallbackNetwork = callbackNetwork): Promise<void> {
  const url = callbackUrl(value, new URL(value).hostname);
  await resolveCallbackAddress(url, network);
}
async function resolveCallbackAddress(url: URL, network: CallbackNetwork): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    network.resolve(url.hostname, { all: true, family: 4 }),
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Callback DNS timeout')), 2000); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!addresses.length || addresses.some(({ address }) => !publicCallbackAddress(address))) throw new Error('Callback address is not public');
  return addresses[0].address;
}

export function safeCallbackPost(hostname: string, network: CallbackNetwork = callbackNetwork): CallbackPost {
  return async (value, body, headers) => {
    const url = callbackUrl(value, hostname);
    const address = await resolveCallbackAddress(url, network);
    return new Promise((resolve, reject) => {
      const req = network.request(url, {
        method: 'POST', headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        // Pin the validated address; the URL hostname remains the TLS identity. No redirects or connection reuse.
        agent: false, family: 4, rejectUnauthorized: true, servername: url.hostname, lookup: (_host, _options, done) => done(null, address, 4),
        signal: AbortSignal.timeout(5000),
      }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4096) res.destroy(new Error('Callback response exceeds limit'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.on('socket', socket => {
        const tls = socket as TLSSocket;
        tls.once('secureConnect', () => {
          if (!tls.authorized || tls.remoteAddress?.replace(/^::ffff:/, '') !== address) {
            req.destroy(new Error('Callback socket identity mismatch')); return;
          }
          req.end(body);
        });
      });
    });
  };
}
export async function signedCallback(post: CallbackPost, subscription: { id: string; url: string; secret: string; previousSecret?: string }, id: string, body: string): Promise<CallbackResponse> {
  if (Buffer.byteLength(body) > 262144) throw new Error('Event exceeds callback limit');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = webhookSignature(subscription.secret, id, timestamp, body);
  return post(subscription.url, body, {
    'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': subscription.previousSecret ? `${signature} ${webhookSignature(subscription.previousSecret, id, timestamp, body)}` : signature,
    'X-MCP-Subscription-Id': subscription.id,
  });
}
export async function verifyCallback(post: CallbackPost, subscription: { id: string; url: string; secret: string }): Promise<void> {
  const challenge = randomUUID();
  const response = await signedCallback(post, subscription, `verify_${randomUUID()}`, JSON.stringify({ type: 'verification', challenge }));
  const echoed: unknown = JSON.parse(response.body).challenge;
  if (response.status < 200 || response.status >= 300 || typeof echoed !== 'string' ||
      Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) || !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) {
    throw new Error('Callback challenge failed');
  }
}
