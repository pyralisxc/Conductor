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

function validIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}

/**
 * Routes an opaque provider connection id to a provider-owned credential loader.
 *
 * The resolver deliberately knows nothing about provider APIs or project semantics.
 * It exists so provider adapters consume one stable connection contract today while
 * ASC can later supply scoped delegation handles without rewriting those adapters.
 */
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
