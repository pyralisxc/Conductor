import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes
} from 'node:crypto';

export interface ProviderCredentialVaultEnvironment
  extends Record<string, string | undefined> {
  CONDUCTOR_PROVIDER_CREDENTIAL_KEY?: string;
  CONDUCTOR_PROVIDER_CREDENTIAL_PREVIOUS_KEYS_JSON?: string;
  CONDUCTOR_SESSION_SECRET?: string;
}

export interface ProviderCredentialVaultOptions {
  legacyPurpose: string;
  currentKey?: string;
  previousKeys?: readonly string[];
  legacySessionSecret?: string;
}

export interface OpenedProviderCredential {
  plaintext: string;
  source: 'current' | 'previous' | 'legacy';
  keyId?: string;
  replacement?: string;
}

export class ProviderCredentialVaultUnavailableError extends Error {
  readonly code = 'provider_credential_vault_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderCredentialVaultUnavailableError';
  }
}

type VaultKey = {
  id: string;
  material: Buffer;
};

const format = 'v2';

function normalizedSecret(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (
    normalized.length < 32 ||
    normalized.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ProviderCredentialVaultUnavailableError(
      label + ' must contain 32-4096 printable characters.',
    );
  }
  return normalized;
}

function keyId(secret: string): string {
  return createHash('sha256')
    .update('conductor/provider-credential-vault-key-id/v1\0')
    .update(secret)
    .digest('hex')
    .slice(0, 16);
}

function vaultKey(secret: string): VaultKey {
  return {
    id: keyId(secret),
    material: createHmac('sha256', secret)
      .update('conductor/provider-credential-vault/v2')
      .digest(),
  };
}

function legacyKey(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret)
    .update(`conductor/${purpose}/v1`)
    .digest();
}

function encryptedParts(
  plaintext: string,
  key: Buffer,
): readonly [string, string, string] {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ] as const;
}

function decryptParts(
  ivValue: string,
  tagValue: string,
  ciphertextValue: string,
  key: Buffer,
): string {
  try {
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    const ciphertext = Buffer.from(ciphertextValue, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) {
      throw new Error('invalid encrypted record');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ProviderCredentialVaultUnavailableError(
      'Provider credential could not be decrypted with the configured key.',
    );
  }
}

function parsePreviousKeys(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProviderCredentialVaultUnavailableError(
      'CONDUCTOR_PROVIDER_CREDENTIAL_PREVIOUS_KEYS_JSON must be a JSON array.',
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 4 ||
    parsed.some((entry) => typeof entry !== 'string')
  ) {
    throw new ProviderCredentialVaultUnavailableError(
      'CONDUCTOR_PROVIDER_CREDENTIAL_PREVIOUS_KEYS_JSON must contain at most four keys.',
    );
  }
  return parsed
    .map((entry) =>
      normalizedSecret(
        entry,
        'Previous provider credential key',
      ),
    )
    .filter((entry): entry is string => Boolean(entry));
}

export class VersionedProviderCredentialVault {
  readonly #legacyPurpose: string;
  readonly #current: VaultKey | undefined;
  readonly #keys: ReadonlyMap<string, VaultKey>;
  readonly #legacySessionSecret: string | undefined;

  constructor(options: ProviderCredentialVaultOptions) {
    const legacyPurpose = options.legacyPurpose.trim();
    if (
      !legacyPurpose ||
      legacyPurpose.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(legacyPurpose)
    ) {
      throw new ProviderCredentialVaultUnavailableError(
        'Provider credential legacy purpose is invalid.',
      );
    }

    const currentSecret = normalizedSecret(
      options.currentKey,
      'CONDUCTOR_PROVIDER_CREDENTIAL_KEY',
    );
    const previousSecrets = (options.previousKeys ?? [])
      .map((entry) =>
        normalizedSecret(
          entry,
          'Previous provider credential key',
        ),
      )
      .filter((entry): entry is string => Boolean(entry));
    const legacySessionSecret = normalizedSecret(
      options.legacySessionSecret,
      'CONDUCTOR_SESSION_SECRET',
    );

    const current = currentSecret
      ? vaultKey(currentSecret)
      : undefined;
    const keyMap = new Map<string, VaultKey>();
    if (current) keyMap.set(current.id, current);
    for (const secret of previousSecrets) {
      const key = vaultKey(secret);
      if (!keyMap.has(key.id)) keyMap.set(key.id, key);
    }

    this.#legacyPurpose = legacyPurpose;
    this.#current = current;
    this.#keys = keyMap;
    this.#legacySessionSecret = legacySessionSecret;
  }

  seal(plaintext: string): string {
    if (this.#current) {
      const [iv, tag, ciphertext] = encryptedParts(
        plaintext,
        this.#current.material,
      );
      return [
        format,
        this.#current.id,
        iv,
        tag,
        ciphertext,
      ].join('.');
    }

    if (this.#legacySessionSecret) {
      return encryptedParts(
        plaintext,
        legacyKey(
          this.#legacySessionSecret,
          this.#legacyPurpose,
        ),
      ).join('.');
    }

    throw new ProviderCredentialVaultUnavailableError(
      'Provider credential encryption key is not configured.',
    );
  }

  open(record: string): OpenedProviderCredential {
    const pieces = record.split('.');
    if (pieces[0] === format) {
      if (pieces.length !== 5) {
        throw new ProviderCredentialVaultUnavailableError(
          'Provider credential record format is invalid.',
        );
      }
      const [, id, iv, tag, ciphertext] = pieces;
      const key = this.#keys.get(id!);
      if (!key) {
        throw new ProviderCredentialVaultUnavailableError(
          'Provider credential key is unavailable for this record.',
        );
      }
      const plaintext = decryptParts(
        iv!,
        tag!,
        ciphertext!,
        key.material,
      );
      const current = this.#current;
      const source =
        current?.id === key.id
          ? 'current'
          : 'previous';
      return Object.freeze({
        plaintext,
        source,
        keyId: key.id,
        ...(source === 'previous' && current
          ? { replacement: this.seal(plaintext) }
          : {}),
      });
    }

    if (pieces.length !== 3) {
      throw new ProviderCredentialVaultUnavailableError(
        'Provider credential record format is invalid.',
      );
    }
    if (!this.#legacySessionSecret) {
      throw new ProviderCredentialVaultUnavailableError(
        'Legacy provider credential key is unavailable.',
      );
    }

    const plaintext = decryptParts(
      pieces[0]!,
      pieces[1]!,
      pieces[2]!,
      legacyKey(
        this.#legacySessionSecret,
        this.#legacyPurpose,
      ),
    );
    return Object.freeze({
      plaintext,
      source: 'legacy' as const,
      ...(this.#current
        ? { replacement: this.seal(plaintext) }
        : {}),
    });
  }
}

export function providerCredentialVaultFromEnvironment(
  legacyPurpose: string,
  environment: ProviderCredentialVaultEnvironment = process.env,
): VersionedProviderCredentialVault {
  return new VersionedProviderCredentialVault({
    legacyPurpose,
    ...(environment.CONDUCTOR_PROVIDER_CREDENTIAL_KEY
      ? {
          currentKey:
            environment.CONDUCTOR_PROVIDER_CREDENTIAL_KEY,
        }
      : {}),
    previousKeys: parsePreviousKeys(
      environment.CONDUCTOR_PROVIDER_CREDENTIAL_PREVIOUS_KEYS_JSON,
    ),
    ...(environment.CONDUCTOR_SESSION_SECRET
      ? {
          legacySessionSecret:
            environment.CONDUCTOR_SESSION_SECRET,
        }
      : {}),
  });
}
