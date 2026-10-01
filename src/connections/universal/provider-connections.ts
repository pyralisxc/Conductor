import { Redis } from '@upstash/redis';
import {
  VersionedProviderCredentialVault,
  providerCredentialVaultFromEnvironment,
} from './credential-vault.js';

export interface ProviderConnectionCredentialRequest {
  provider: string;
  connectionId: string;
  accountId?: string;
}

export interface ProviderConnectionCredential {
  provider: string;
  connectionId: string;
  accountId?: string;
  token: string;
  resolvedAt: string;
}

export interface ProviderConnectionCredentialResolver {
  resolve(request: ProviderConnectionCredentialRequest): Promise<ProviderConnectionCredential | undefined>;
}

export type ProviderConnectionCredentialLoader = (
  request: ProviderConnectionCredentialRequest,
) => Promise<string | undefined>;

export interface ProviderConnectionRecordStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface StoredProviderConnectionCredentialInput extends ProviderConnectionCredentialRequest {
  token: string;
}

type StoredCredential = {
  provider: string;
  connectionId: string;
  accountId?: string;
  token: string;
  connectedAt: string;
};

const providerConnectionPrefix = 'conductor:provider-connection:v1';

function validIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}

function isProviderConnectionRecordStore(value: ProviderConnectionRecordStore | { url: string; token: string }): value is ProviderConnectionRecordStore {
  const candidate = value as Partial<ProviderConnectionRecordStore>;
  return typeof candidate.get === 'function' && typeof candidate.set === 'function' && typeof candidate.del === 'function';
}

function credentialKey(provider: string, connectionId: string): string {
  return `${providerConnectionPrefix}:${encodeURIComponent(provider)}:${encodeURIComponent(connectionId)}`;
}

function parseStoredCredential(value: string): StoredCredential {
  let parsed: Partial<StoredCredential>;
  try {
    parsed = JSON.parse(value) as Partial<StoredCredential>;
  } catch {
    throw new Error('Invalid provider connection credential payload');
  }
  if (typeof parsed.provider !== 'string' || typeof parsed.connectionId !== 'string' || typeof parsed.token !== 'string' || typeof parsed.connectedAt !== 'string') {
    throw new Error('Invalid provider connection credential payload');
  }
  return {
    provider: validIdentity(parsed.provider, 'provider'),
    connectionId: validIdentity(parsed.connectionId, 'connectionId'),
    ...(parsed.accountId ? { accountId: validIdentity(parsed.accountId, 'accountId') } : {}),
    token: parsed.token,
    connectedAt: parsed.connectedAt,
  };
}

export class RedisProviderConnectionCredentialStore implements ProviderConnectionCredentialResolver {
  readonly #store: ProviderConnectionRecordStore;
  readonly #now: () => Date;
  readonly #vault: VersionedProviderCredentialVault;

  constructor(
    storeOrConfig: ProviderConnectionRecordStore | { url: string; token: string },
    options: {
      now?: () => Date;
      vault?: VersionedProviderCredentialVault;
    } = {},
  ) {
    this.#store = isProviderConnectionRecordStore(storeOrConfig)
      ? storeOrConfig
      : new Redis({ url: storeOrConfig.url, token: storeOrConfig.token, enableTelemetry: false });
    this.#now = options.now ?? (() => new Date());
    this.#vault = options.vault ?? providerCredentialVaultFromEnvironment(
      'provider-connection-credential-v1',
    );
  }

  async put(input: StoredProviderConnectionCredentialInput): Promise<void> {
    const provider = validIdentity(input.provider, 'provider');
    const connectionId = validIdentity(input.connectionId, 'connectionId');
    const accountId = input.accountId === undefined ? undefined : validIdentity(input.accountId, 'accountId');
    const token = input.token.trim();
    if (!token || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) throw new Error('Invalid provider credential');
    await this.#store.set(
      credentialKey(provider, connectionId),
      this.#vault.seal(JSON.stringify({
        provider,
        connectionId,
        ...(accountId ? { accountId } : {}),
        token,
        connectedAt: this.#now().toISOString(),
      })),
    );
  }

  async delete(providerInput: string, connectionIdInput: string): Promise<void> {
    const provider = validIdentity(providerInput, 'provider');
    const connectionId = validIdentity(connectionIdInput, 'connectionId');
    await this.#store.del(credentialKey(provider, connectionId));
  }

  async resolve(request: ProviderConnectionCredentialRequest): Promise<ProviderConnectionCredential | undefined> {
    const provider = validIdentity(request.provider, 'provider');
    const connectionId = validIdentity(request.connectionId, 'connectionId');
    const accountId = request.accountId === undefined ? undefined : validIdentity(request.accountId, 'accountId');
    const key = credentialKey(provider, connectionId);
    const encrypted = await this.#store.get<string>(key);
    if (!encrypted) return undefined;
    const opened = this.#vault.open(encrypted);
    const stored = parseStoredCredential(opened.plaintext);
    if (opened.replacement) {
      await this.#store.set(key, opened.replacement);
    }
    if (stored.provider !== provider || stored.connectionId !== connectionId) return undefined;
    if (accountId !== undefined && stored.accountId !== accountId) return undefined;
    return {
      provider,
      connectionId,
      ...(stored.accountId ? { accountId: stored.accountId } : {}),
      token: stored.token,
      resolvedAt: this.#now().toISOString(),
    };
  }
}

export class RoutedProviderConnectionCredentialResolver implements ProviderConnectionCredentialResolver {
  readonly #loaders: ReadonlyMap<string, ProviderConnectionCredentialLoader>;
  readonly #now: () => Date;

  constructor(
    loaders: Readonly<Record<string, ProviderConnectionCredentialLoader>>,
    options: { now?: () => Date } = {},
  ) {
    const entries = Object.entries(loaders).map(([provider, loader]) => [validIdentity(provider, 'provider'), loader] as const);
    if (entries.length === 0) throw new Error('At least one provider credential loader is required');
    this.#loaders = new Map(entries);
    this.#now = options.now ?? (() => new Date());
  }

  async resolve(request: ProviderConnectionCredentialRequest): Promise<ProviderConnectionCredential | undefined> {
    const provider = validIdentity(request.provider, 'provider');
    const connectionId = validIdentity(request.connectionId, 'connectionId');
    const accountId = request.accountId === undefined ? undefined : validIdentity(request.accountId, 'accountId');
    const loader = this.#loaders.get(provider);
    if (!loader) return undefined;
    const token = (await loader({ provider, connectionId, ...(accountId ? { accountId } : {}) }))?.trim();
    if (!token) return undefined;
    return {
      provider,
      connectionId,
      ...(accountId ? { accountId } : {}),
      token,
      resolvedAt: this.#now().toISOString(),
    };
  }
}
