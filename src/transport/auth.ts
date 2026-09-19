import { createRemoteJWKSet, jwtVerify } from 'jose';
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
    const scopes = parseScopes(verified.payload.scope, verified.payload.scp);
    const missing = this.requiredScopes.filter((scope) => !scopes.includes(scope));
    if (missing.length > 0) {
      throw new Error(`Access token is missing required scopes: ${missing.join(', ')}`);
    }
    const clientId = stringClaim(verified.payload.client_id)
      ?? stringClaim(verified.payload.azp)
      ?? stringClaim(verified.payload.sub);
    if (!clientId) throw new Error('Access token has no stable client identity');

    return {
      token,
      clientId,
      scopes,
      expiresAt: verified.payload.exp,
      resource: new URL(this.audience),
      extra: verified.payload.sub ? { subject: verified.payload.sub } : undefined,
    };
  }
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
