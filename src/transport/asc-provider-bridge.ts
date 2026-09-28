import { timingSafeEqual } from 'node:crypto';
import type {
  IncomingMessage,
  ServerResponse
} from 'node:http';

import {
  GitHubAppCredentialProvider,
  type GitHubInstallationAttestation
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

export interface AscProviderBridgeOptions {
  readonly secret: string;
  readonly githubApp: GitHubAppCredentialProvider;
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
  if (!installationId && !appIdentity) return false;

  if (req.method !== 'GET') {
    res.writeHead(405, {
      allow: 'GET',
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  const resolved = options ?? bridgeFromEnvironment();
  const supplied = bearerToken(req);
  if (
    !supplied ||
    !safeEqual(supplied, resolved.secret)
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

  const secret =
    process.env.CONDUCTOR_ASC_BRIDGE_SECRET?.trim();
  const appId =
    process.env.CONDUCTOR_GITHUB_APP_ID?.trim();
  const privateKey =
    process.env.CONDUCTOR_GITHUB_APP_PRIVATE_KEY?.trim();

  if (!secret || secret.length < 32) {
    throw new Error(
      'CONDUCTOR_ASC_BRIDGE_SECRET must be configured with at least 32 characters'
    );
  }
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
