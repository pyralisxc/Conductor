import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';

export type GitHubPermissionLevel = 'read' | 'write' | 'admin' | string;

export interface GitHubIdentity {
  kind: 'static-token' | 'app';
  appId?: string;
  appSlug?: string;
}

export interface GitHubCredential {
  token: string;
  kind: 'static-token' | 'app-installation';
  identity: GitHubIdentity & {
    installationId?: number;
    account?: string;
  };
  repository?: string;
  repositorySelection?: 'all' | 'selected' | string;
  permissions?: Readonly<Record<string, GitHubPermissionLevel>>;
  expiresAt?: string;
}

export interface GitHubCredentialProvider {
  getIdentity(): Promise<GitHubIdentity>;
  getCredential(repository: string, options?: { forceRefresh?: boolean }): Promise<GitHubCredential>;
}

export class StaticGitHubCredentialProvider implements GitHubCredentialProvider {
  constructor(private readonly token: string) {}

  async getIdentity(): Promise<GitHubIdentity> {
    return { kind: 'static-token' };
  }

  async getCredential(repository: string, _options?: { forceRefresh?: boolean }): Promise<GitHubCredential> {
    return {
      token: this.token,
      kind: 'static-token',
      identity: { kind: 'static-token' },
      repository,
    };
  }
}

interface GitHubAppResponse {
  id: number;
  slug: string;
}

interface GitHubInstallationResponse {
  id: number;
  app_id?: number;
  account?: {
    id?: number;
    login?: string;
    type?: string;
  };
  target_type?: string;
  repository_selection?: 'all' | 'selected' | string;
  permissions?: Record<string, GitHubPermissionLevel>;
  suspended_at?: string | null;
}

interface GitHubInstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions: Record<string, GitHubPermissionLevel>;
  repository_selection?: 'all' | 'selected' | string;
}

interface CachedCredential {
  credential: GitHubCredential;
  expiresAtMs: number;
}

export interface GitHubInstallationAttestation {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: "User" | "Organization" | "Enterprise";
  repositorySelection: "all" | "selected";
  permissions: Readonly<Record<string, GitHubPermissionLevel>>;
  capabilities: readonly string[];
  verifiedAt: string;
}

export interface GitHubRepositoryAttestation {
  installationId: string;
  repository: string;
  accountId: string;
  accountLogin: string;
  accountType: "User" | "Organization" | "Enterprise";
  permissions: Readonly<Record<string, GitHubPermissionLevel>>;
  capabilities: readonly string[];
  verifiedAt: string;
}

export interface GitHubAppCredentialProviderOptions {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export class GitHubAppCredentialProvider implements GitHubCredentialProvider {
  private readonly appId: string;
  private readonly privateKey: KeyObject;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CachedCredential>();
  private identity?: GitHubIdentity;

  constructor(options: GitHubAppCredentialProviderOptions) {
    if (!/^[1-9]\d*$/.test(options.appId)) throw new Error('GitHub App ID must be a positive integer');
    this.appId = options.appId;
    this.privateKey = createPrivateKey(normalizePrivateKey(options.privateKey));
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getIdentity(): Promise<GitHubIdentity> {
    if (this.identity) return this.identity;
    const response = await this.fetch(`${this.apiBaseUrl}/app`, {
      headers: await this.appHeaders(),
    });
    if (!response.ok) throw await githubAppResponseError(response);
    const app = await response.json() as GitHubAppResponse;
    if (String(app.id) !== this.appId) {
      throw { code: 'CONFLICT', source: 'github', message: 'GitHub App identity does not match the configured App ID' };
    }
    this.identity = { kind: 'app', appId: String(app.id), appSlug: app.slug };
    return this.identity;
  }

  async getInstallationAttestation(
    installationIdInput: string | number
  ): Promise<GitHubInstallationAttestation> {
    const installationId = String(installationIdInput).trim();
    if (!/^[1-9]\d{0,19}$/u.test(installationId)) {
      throw {
        code: 'NOT_FOUND',
        source: 'github',
        message: 'GitHub installation ID is invalid',
      };
    }

    const response = await this.fetch(
      `${this.apiBaseUrl}/app/installations/${installationId}`,
      { headers: await this.appHeaders() },
    );
    if (!response.ok) throw await githubAppResponseError(response);

    const installation = await response.json() as GitHubInstallationResponse;
    if (String(installation.id) !== installationId) {
      throw {
        code: 'CONFLICT',
        source: 'github',
        message: 'GitHub installation attestation returned a different installation ID',
      };
    }
    if (
      installation.app_id !== undefined &&
      String(installation.app_id) !== this.appId
    ) {
      throw {
        code: 'CONFLICT',
        source: 'github',
        message: 'GitHub installation belongs to a different GitHub App',
      };
    }
    if (installation.suspended_at) {
      throw {
        code: 'AUTH_REQUIRED',
        source: 'github',
        message: 'GitHub App installation is suspended',
      };
    }

    const accountId = String(installation.account?.id ?? '').trim();
    const accountLogin = installation.account?.login?.trim() ?? '';
    const accountTypeRaw =
      installation.account?.type?.trim() ??
      installation.target_type?.trim() ??
      '';
    const accountType =
      accountTypeRaw === 'Organization' ||
      accountTypeRaw === 'Enterprise'
        ? accountTypeRaw
        : accountTypeRaw === 'User'
          ? 'User'
          : undefined;
    const repositorySelection =
      installation.repository_selection === 'all'
        ? 'all'
        : installation.repository_selection === 'selected'
          ? 'selected'
          : undefined;

    if (
      !/^[1-9]\d*$/u.test(accountId) ||
      !accountLogin ||
      !accountType ||
      !repositorySelection
    ) {
      throw {
        code: 'CONFLICT',
        source: 'github',
        message: 'GitHub installation attestation is missing safe account metadata',
      };
    }

    const permissions = Object.freeze({
      ...(installation.permissions ?? {}),
    });

    return Object.freeze({
      installationId,
      accountId,
      accountLogin,
      accountType,
      repositorySelection,
      permissions,
      capabilities: githubCapabilitiesFromPermissions(permissions),
      verifiedAt: this.now().toISOString(),
    });
  }

  async getRepositoryAttestation(
    repositoryInput: string,
    expectedInstallationIdInput: string | number
  ): Promise<GitHubRepositoryAttestation> {
    const [owner, name] = splitRepository(repositoryInput);
    const expectedInstallationId =
      String(expectedInstallationIdInput).trim();

    if (!/^[1-9]\d{0,19}$/u.test(expectedInstallationId)) {
      throw {
        code: 'NOT_FOUND',
        source: 'github',
        message: 'Expected GitHub installation ID is invalid',
      };
    }

    const response = await this.fetch(
      `${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      { headers: await this.appHeaders() },
    );
    if (!response.ok) throw await githubAppResponseError(response);

    const installation =
      await response.json() as GitHubInstallationResponse;

    if (String(installation.id) !== expectedInstallationId) {
      throw {
        code: 'CONFLICT',
        source: 'github',
        message:
          'GitHub repository is attached to a different App installation',
      };
    }
    if (
      installation.app_id !== undefined &&
      String(installation.app_id) !== this.appId
    ) {
      throw {
        code: 'CONFLICT',
        source: 'github',
        message: 'GitHub repository installation belongs to a different GitHub App',
      };
    }
    if (installation.suspended_at) {
      throw {
        code: 'AUTH_REQUIRED',
        source: 'github',
        message: 'GitHub repository installation is suspended',
      };
    }

    const accountId = String(
      installation.account?.id ?? ''
    ).trim();
    const accountLogin =
      installation.account?.login?.trim() ?? '';
    const accountTypeRaw =
      installation.account?.type?.trim() ??
      installation.target_type?.trim() ??
      '';
    const accountType =
      accountTypeRaw === 'Organization' ||
      accountTypeRaw === 'Enterprise'
        ? accountTypeRaw
        : accountTypeRaw === 'User'
          ? 'User'
          : undefined;

    if (
      !/^[1-9]\d*$/u.test(accountId) ||
      !accountLogin ||
      !accountType
    ) {
      throw {
        code: 'CONFLICT',
        source: 'github',
        message:
          'GitHub repository attestation is missing safe account metadata',
      };
    }

    const permissions = Object.freeze({
      ...(installation.permissions ?? {}),
    });

    return Object.freeze({
      installationId: expectedInstallationId,
      repository: `${owner}/${name}`,
      accountId,
      accountLogin,
      accountType,
      permissions,
      capabilities:
        githubCapabilitiesFromPermissions(permissions),
      verifiedAt: this.now().toISOString(),
    });
  }

  async getCredential(repository: string, options: { forceRefresh?: boolean } = {}): Promise<GitHubCredential> {
    const cached = this.cache.get(repository.toLowerCase());
    if (!options.forceRefresh && cached && cached.expiresAtMs - this.now().getTime() > 5 * 60_000) {
      return cached.credential;
    }

    const [owner, name] = splitRepository(repository);
    const identity = await this.getIdentity();
    const installationResponse = await this.fetch(
      `${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      { headers: await this.appHeaders() },
    );
    if (!installationResponse.ok) throw await githubAppResponseError(installationResponse);
    const installation = await installationResponse.json() as GitHubInstallationResponse;

    const tokenResponse = await this.fetch(
      `${this.apiBaseUrl}/app/installations/${installation.id}/access_tokens`,
      {
        method: 'POST',
        headers: await this.appHeaders(),
        body: JSON.stringify({ repositories: [name] }),
      },
    );
    if (!tokenResponse.ok) throw await githubAppResponseError(tokenResponse);
    const token = await tokenResponse.json() as GitHubInstallationTokenResponse;
    const expiresAtMs = Date.parse(token.expires_at);
    if (!token.token || !Number.isFinite(expiresAtMs) || expiresAtMs <= this.now().getTime()) {
      throw { code: 'AUTH_REQUIRED', source: 'github', message: 'GitHub returned an unusable installation token' };
    }
    const credential: GitHubCredential = {
      token: token.token,
      kind: 'app-installation',
      identity: {
        ...identity,
        installationId: installation.id,
        account: installation.account?.login,
      },
      repository,
      repositorySelection: token.repository_selection ?? installation.repository_selection,
      permissions: token.permissions ?? installation.permissions,
      expiresAt: token.expires_at,
    };
    this.cache.set(repository.toLowerCase(), {
      credential,
      expiresAtMs,
    });
    return credential;
  }

  private async appHeaders(): Promise<Record<string, string>> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await this.createAppJwt()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Conductor-Tool-Runtime',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async createAppJwt(): Promise<string> {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    return await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuedAt(nowSeconds - 60)
      .setExpirationTime(nowSeconds + 9 * 60)
      .setIssuer(this.appId)
      .sign(this.privateKey);
  }
}

function normalizePrivateKey(value: string): string {
  const normalized = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  if (!normalized.includes('PRIVATE KEY')) throw new Error('GitHub App private key is not a PEM private key');
  return normalized;
}

function splitRepository(repository: string): [string, string] {
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw { code: 'NOT_FOUND', message: `Repository ${repository} is not a valid owner/repository identity` };
  }
  return [parts[0], parts[1]];
}

async function githubAppResponseError(response: Response): Promise<unknown> {
  const requestId = response.headers.get('x-github-request-id');
  const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
  return {
    status: response.status,
    source: 'github',
    message: body?.message ?? `GitHub App request failed with status ${response.status}`,
    diagnostics: requestId ? [{
      level: 'error',
      source: 'github',
      message: 'GitHub App request failed',
      details: { requestId },
    }] : undefined,
  };
}


export function githubCapabilitiesFromPermissions(
  permissions: Readonly<Record<string, GitHubPermissionLevel>>
): readonly string[] {
  const output = new Set<string>();

  const add = (
    permission: string,
    readCapability: string,
    writeCapability?: string
  ) => {
    const level = permissions[permission];
    if (!level) return;
    if (level === 'read' || level === 'write' || level === 'admin') {
      output.add(readCapability);
    }
    if (
      writeCapability &&
      (level === 'write' || level === 'admin')
    ) {
      output.add(writeCapability);
    }
  };

  add('metadata', 'repository.read');
  add('contents', 'source.read', 'source.write');
  add('issues', 'issue.read', 'issue.write');
  add(
    'pull_requests',
    'pull_request.read',
    'pull_request.write'
  );
  add('actions', 'actions.read', 'actions.write');
  add('checks', 'checks.read', 'checks.write');
  add(
    'commit_statuses',
    'commit_status.read',
    'commit_status.write'
  );
  add(
    'deployments',
    'deployment.read',
    'deployment.write'
  );

  return Object.freeze([...output].sort());
}
