import { Redis } from '@upstash/redis';
import { RedisProviderConnectionCredentialStore } from '../universal/provider-connections.js';
import { providerCredentialVaultFromEnvironment } from '../universal/credential-vault.js';

type Installation = { configurationId: string; teamId: string | null; connectedAt: string; token: string };

export interface VercelInstallationMetadata {
  readonly configurationId: string;
  readonly teamId: string | null;
  readonly connectedAt: string;
}
const prefix = 'conductor:vercel:connection:v1';
const stateTtl = 600;
export const VERCEL_RUNTIME_CONNECTION_ID = 'vercel-runtime-primary';
function configuration(): { redis: Redis; slug: string; clientId: string; clientSecret: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  const slug = process.env.CONDUCTOR_VERCEL_INTEGRATION_SLUG;
  const clientId = process.env.CONDUCTOR_VERCEL_CLIENT_ID;
  const clientSecret = process.env.CONDUCTOR_VERCEL_CLIENT_SECRET;
  if (!url || !token || !slug || !clientId || !clientSecret) {
    throw Object.assign(new Error('Vercel connection requires Redis and integration slug, client ID, and client secret'), { status: 503 });
  }
  if (!/^[a-z0-9-]+$/u.test(slug)) throw new Error('Invalid Vercel integration slug');
  return { redis: new Redis({ url, token, enableTelemetry: false }), slug, clientId, clientSecret };
}

function installationVault() {
  return providerCredentialVaultFromEnvironment(
    'vercel-installation',
  );
}

function parseInstallation(value: string): Installation {
  let parsed: Partial<Installation>;
  try {
    parsed = JSON.parse(value) as Partial<Installation>;
  } catch {
    throw new Error('Invalid Vercel connection payload');
  }
  if (
    typeof parsed.configurationId !== 'string' ||
    !/^icfg_[\w-]+$/u.test(parsed.configurationId) ||
    (parsed.teamId !== null && typeof parsed.teamId !== 'string') ||
    typeof parsed.connectedAt !== 'string' ||
    typeof parsed.token !== 'string' ||
    !parsed.token
  ) {
    throw new Error('Invalid Vercel connection payload');
  }
  return {
    configurationId: parsed.configurationId,
    teamId: parsed.teamId ?? null,
    connectedAt: parsed.connectedAt,
    token: parsed.token,
  };
}

function encrypt(value: Installation): string {
  return installationVault().seal(JSON.stringify(value));
}

function decrypt(value: string): {
  installation: Installation;
  replacement?: string;
} {
  const opened = installationVault().open(value);
  return {
    installation: parseInstallation(opened.plaintext),
    ...(opened.replacement
      ? { replacement: opened.replacement }
      : {}),
  };
}

export async function listVercelInstallationMetadata():
  Promise<readonly VercelInstallationMetadata[]> {
  const { redis } = configuration();
  const ids = (
    await redis.smembers<string[]>(prefix + ':ids')
  ).slice().sort();

  const result: VercelInstallationMetadata[] = [];
  for (const configurationId of ids) {
    if (!/^icfg_[\w-]+$/u.test(configurationId)) {
      continue;
    }
    const key =
      prefix + ':installation:' + configurationId;
    const record = await redis.get<string>(key);
    if (!record) continue;

    const opened = decrypt(record);
    if (opened.replacement) {
      await redis.set(key, opened.replacement);
    }
    const installation = opened.installation;
    if (
      installation.configurationId !== configurationId
    ) {
      throw new Error(
        'Stored Vercel installation identity mismatch'
      );
    }
    result.push(
      Object.freeze({
        configurationId:
          installation.configurationId,
        teamId: installation.teamId,
        connectedAt: installation.connectedAt,
      })
    );
  }
  return Object.freeze(result);
}

export async function vercelInstallationMetadata(
  configurationId: string
): Promise<VercelInstallationMetadata | undefined> {
  if (!/^icfg_[\w-]+$/u.test(configurationId)) {
    throw new Error('Invalid Vercel installation ID');
  }
  const { redis } = configuration();
  const key = prefix + ':installation:' + configurationId;
  const record = await redis.get<string>(key);
  if (!record) return undefined;
  const opened = decrypt(record);
  if (opened.replacement) {
    await redis.set(key, opened.replacement);
  }
  const installation = opened.installation;
  if (installation.configurationId !== configurationId) {
    throw new Error('Stored Vercel installation identity mismatch');
  }
  return Object.freeze({
    configurationId: installation.configurationId,
    teamId: installation.teamId,
    connectedAt: installation.connectedAt,
  });
}

export async function vercelInstallationToken(configurationId: string, teamId?: string): Promise<string | undefined> {
  const { redis } = configuration();
  const key = prefix + ':installation:' + configurationId;
  const record = await redis.get<string>(key);
  if (!record) return undefined;
  const opened = decrypt(record);
  if (opened.replacement) {
    await redis.set(key, opened.replacement);
  }
  const installation = opened.installation;
  if ((installation.teamId ?? undefined) !== teamId) return undefined;
  return installation.token;
}


export function vercelConnectionOAuthConfiguration(): {
  slug: string;
  clientId: string;
  clientSecret: string;
} {
  const { slug, clientId, clientSecret } = configuration();
  return { slug, clientId, clientSecret };
}

export async function createVercelConnectionState(state: string): Promise<void> {
  const { redis } = configuration();
  await redis.set(`${prefix}:state:${state}`, 'pending', { ex: stateTtl, nx: true });
}

export async function consumeVercelConnectionState(state: string): Promise<boolean> {
  const { redis } = configuration();
  return await redis.getdel(`${prefix}:state:${state}`) === 'pending';
}

export async function disconnectVercelInstallation(configurationId: string): Promise<void> {
  if (!/^icfg_[\w-]+$/u.test(configurationId)) throw new Error('Invalid Vercel installation ID');
  const { redis } = configuration();
  await redis.del(`${prefix}:installation:${configurationId}`);
  await redis.srem(`${prefix}:ids`, configurationId);
}

export async function storeVercelInstallation(input: {
  configurationId: string;
  teamId: string | null;
  connectedAt: string;
  token: string;
}): Promise<void> {
  if (!/^icfg_[\w-]+$/u.test(input.configurationId)) throw new Error('Invalid Vercel installation ID');
  const { redis } = configuration();
  await redis.set(
    `${prefix}:installation:${input.configurationId}`,
    encrypt({
      configurationId: input.configurationId,
      teamId: input.teamId,
      connectedAt: input.connectedAt,
      token: input.token,
    }),
  );
  await redis.sadd(`${prefix}:ids`, input.configurationId);
}

export async function vercelRuntimeCredentialConnected(): Promise<boolean> {
  const { redis } = configuration();
  const credentialStore = new RedisProviderConnectionCredentialStore(redis);
  return Boolean(await credentialStore.resolve({
    provider: 'vercel',
    connectionId: VERCEL_RUNTIME_CONNECTION_ID,
  }));
}

export async function connectVercelRuntimeCredential(token: string): Promise<void> {
  const { redis } = configuration();
  await new RedisProviderConnectionCredentialStore(redis).put({
    provider: 'vercel',
    connectionId: VERCEL_RUNTIME_CONNECTION_ID,
    token,
  });
}

export async function disconnectVercelRuntimeCredential(): Promise<void> {
  const { redis } = configuration();
  await new RedisProviderConnectionCredentialStore(redis).delete(
    'vercel',
    VERCEL_RUNTIME_CONNECTION_ID,
  );
}
