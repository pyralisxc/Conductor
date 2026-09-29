import { timingSafeEqual } from 'node:crypto';
import type {
  IncomingMessage,
  ServerResponse
} from 'node:http';

import {
  GitHubAppCredentialProvider,
  type GitHubIdentity,
  type GitHubInstallationAttestation,
  type GitHubRepositoryAttestation
} from '../providers/github-auth.js';

function json(
  res: ServerResponse,
  status: number,
  value: unknown
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function safeEqual(
  left: string,
  right: string
): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(
  req: IncomingMessage
): string | undefined {
  const value = req.headers.authorization?.trim();
  if (!value?.startsWith('Bearer ')) return undefined;
  const token = value.slice('Bearer '.length).trim();
  return token || undefined;
}

function installationIdFromPath(
  pathname: string
): string | undefined {
  const match = /^\/internal\/asc\/github\/installations\/([1-9][0-9]{0,19})\/attest$/u.exec(
    pathname
  );
  return match?.[1];
}

function isGitHubAppIdentityPath(
  pathname: string
): boolean {
  return pathname === '/internal/asc/github/app';
}

function repositoryAttestationFromPath(
  pathname: string
):
  | {
      readonly installationId: string;
      readonly repository: string;
    }
  | undefined {
  const match =
    /^\/internal\/asc\/github\/installations\/([1-9][0-9]{0,19})\/repositories\/([^/]+)\/([^/]+)\/attest$/u.exec(
      pathname
    );

  if (!match) return undefined;

  const owner = decodeURIComponent(match[2] ?? '').trim();
  const repo = decodeURIComponent(match[3] ?? '').trim();
  if (
    !owner ||
    !repo ||
    owner.includes('/') ||
    repo.includes('/')
  ) {
    return undefined;
  }

  return Object.freeze({
    installationId: match[1]!,
    repository: owner + '/' + repo
  });
}

export function ascBridgeSecretFromEnvironment(): string {
  const secret =
    process.env.CONDUCTOR_ASC_BRIDGE_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      'CONDUCTOR_ASC_BRIDGE_SECRET must be configured with at least 32 characters'
    );
  }
  return secret;
}

export function ascBridgeRequestAuthorized(
  req: IncomingMessage,
  secret: string
): boolean {
  const supplied = bearerToken(req);
  return Boolean(
    supplied && safeEqual(supplied, secret)
  );
}

export interface AscGitHubAttestationProvider {
  getIdentity(): Promise<GitHubIdentity>;
  getInstallationAttestation(
    installationId: string | number
  ): Promise<GitHubInstallationAttestation>;
  getRepositoryAttestation(
    repository: string,
    expectedInstallationId: string | number
  ): Promise<GitHubRepositoryAttestation>;
}

export interface AscProviderBridgeOptions {
  readonly secret: string;
  readonly githubApp: AscGitHubAttestationProvider;
}

export async function handleAscProviderBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  options?: AscProviderBridgeOptions
): Promise<boolean> {
  const installationId = installationIdFromPath(
    requestUrl.pathname
  );
  const appIdentity = isGitHubAppIdentityPath(
    requestUrl.pathname
  );
  const repositoryAttestation =
    repositoryAttestationFromPath(
      requestUrl.pathname
    );
  if (
    !installationId &&
    !appIdentity &&
    !repositoryAttestation
  ) {
    return false;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, {
      allow: 'GET',
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  const resolved = options ?? bridgeFromEnvironment();
  if (
    !ascBridgeRequestAuthorized(
      req,
      resolved.secret
    )
  ) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  try {
    if (appIdentity) {
      const identity =
        await resolved.githubApp.getIdentity();
      if (
        identity.kind !== 'app' ||
        !identity.appId ||
        !identity.appSlug
      ) {
        throw new Error(
          'Configured GitHub identity is not an App'
        );
      }
      json(res, 200, {
        appId: identity.appId,
        appSlug: identity.appSlug,
      });
      return true;
    }

    if (repositoryAttestation) {
      const attestation =
        await resolved.githubApp.getRepositoryAttestation(
          repositoryAttestation.repository,
          repositoryAttestation.installationId
        );
      json(
        res,
        200,
        safeRepositoryAttestation(attestation)
      );
      return true;
    }

    const attestation =
      await resolved.githubApp.getInstallationAttestation(
        installationId!
      );
    json(res, 200, safeAttestation(attestation));
  } catch (error) {
    const status =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : 502;
    json(res, status, {
      error: 'github_installation_attestation_failed',
      message:
        error instanceof Error
          ? error.message
          : typeof error === 'object' &&
              error !== null &&
              'message' in error &&
              typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : 'GitHub installation attestation failed',
    });
  }

  return true;
}

function safeRepositoryAttestation(
  value: GitHubRepositoryAttestation
) {
  return {
    installationId: value.installationId,
    repository: value.repository,
    accountId: value.accountId,
    accountLogin: value.accountLogin,
    accountType: value.accountType,
    capabilities: value.capabilities,
    verifiedAt: value.verifiedAt,
  };
}

function safeAttestation(
  value: GitHubInstallationAttestation
) {
  return {
    installationId: value.installationId,
    accountId: value.accountId,
    accountLogin: value.accountLogin,
    accountType: value.accountType,
    repositorySelection: value.repositorySelection,
    capabilities: value.capabilities,
    verifiedAt: value.verifiedAt,
  };
}

let cachedEnvironmentBridge:
  | AscProviderBridgeOptions
  | undefined;

function bridgeFromEnvironment(): AscProviderBridgeOptions {
  if (cachedEnvironmentBridge) return cachedEnvironmentBridge;

  const secret = ascBridgeSecretFromEnvironment();
  const appId =
    process.env.CONDUCTOR_GITHUB_APP_ID?.trim();
  const privateKey =
    process.env.CONDUCTOR_GITHUB_APP_PRIVATE_KEY?.trim();

  if (!appId || !privateKey) {
    throw new Error(
      'ASC GitHub attestation requires Conductor GitHub App credentials'
    );
  }

  cachedEnvironmentBridge = Object.freeze({
    secret,
    githubApp: new GitHubAppCredentialProvider({
      appId,
      privateKey,
    }),
  });
  return cachedEnvironmentBridge;
}
