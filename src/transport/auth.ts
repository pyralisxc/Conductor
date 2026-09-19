import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export const CONDUCTOR_READ_SCOPE = 'conductor.read';

export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

export interface JwtAccessTokenVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  requiredScopes?: string[];
}

export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly requiredScopes: string[];
  private readonly keySet: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: JwtAccessTokenVerifierOptions) {
    this.issuer = options.issuer.replace(/\/$/, '');
    this.audience = options.audience;
    this.requiredScopes = options.requiredScopes ?? [CONDUCTOR_READ_SCOPE];
    this.keySet = createRemoteJWKSet(new URL(options.jwksUrl));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verified = await jwtVerify(token, this.keySet, {
      issuer: this.issuer,
      audience: this.audience,
    });
    return authInfoFromJwt(token, verified.payload, this.audience, this.requiredScopes);
  }
}

export function authInfoFromJwt(
  token: string,
  payload: JWTPayload,
  audience: string,
  requiredScopes: string[] = [CONDUCTOR_READ_SCOPE],
): AuthInfo {
  const scopes = parseScopes(payload.scope, payload.scp);
  const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(`Access token is missing required scopes: ${missing.join(', ')}`);
  }
  const clientId = stringClaim(payload.client_id)
    ?? stringClaim(payload.azp)
    ?? stringClaim(payload.sub);
  if (!clientId) throw new Error('Access token has no stable client identity');

  return {
    token,
    clientId,
    scopes,
    expiresAt: payload.exp,
    resource: new URL(audience),
    extra: payload.sub ? { subject: payload.sub } : undefined,
  };
}

function parseScopes(scope: unknown, scp: unknown): string[] {
  if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(scp) && scp.every((value) => typeof value === 'string')) return scp;
  if (typeof scp === 'string') return scp.split(/\s+/).filter(Boolean);
  return [];
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
