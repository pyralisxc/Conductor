import { RedisProviderConnectionCredentialStore } from '../universal/provider-connections.js';
import { providerCredentialVaultFromEnvironment } from '../universal/credential-vault.js';

export const SYMPHONY_PROVIDER_ID = 'oh-my-symphony';

export interface SymphonyRuntimeCredentialBinding {
  connectionId: string;
  repository: string;
}

type Env = Record<string, string | undefined>;

function store(environment: Env = process.env): RedisProviderConnectionCredentialStore {
  const url = environment.UPSTASH_REDIS_REST_URL ?? environment.KV_REST_API_URL;
  const redisToken = environment.UPSTASH_REDIS_REST_TOKEN ?? environment.KV_REST_API_TOKEN;
  if (!url || !redisToken) throw new Error('Symphony credential storage requires the configured provider credential store');
  return new RedisProviderConnectionCredentialStore(
    { url, token: redisToken },
    { vault: providerCredentialVaultFromEnvironment('provider-connection-credential-v1', environment) },
  );
}

export async function symphonyRuntimeCredentialConnected(
  binding: SymphonyRuntimeCredentialBinding,
  environment: Env = process.env,
): Promise<boolean> {
  return Boolean(await store(environment).resolve({ provider: SYMPHONY_PROVIDER_ID, connectionId: binding.connectionId, accountId: binding.repository }));
}

export async function connectSymphonyRuntimeCredential(
  binding: SymphonyRuntimeCredentialBinding,
  token: string,
  environment: Env = process.env,
): Promise<void> {
  await store(environment).put({ provider: SYMPHONY_PROVIDER_ID, connectionId: binding.connectionId, accountId: binding.repository, token });
}

export async function disconnectSymphonyRuntimeCredential(
  binding: SymphonyRuntimeCredentialBinding,
  environment: Env = process.env,
): Promise<void> {
  await store(environment).delete(SYMPHONY_PROVIDER_ID, binding.connectionId);
}
