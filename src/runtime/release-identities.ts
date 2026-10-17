/** Technical budget for inline release identity, not a release/product size rule. */
export const RELEASE_IDENTITY_MAX_BYTES = 16 * 1024;

export function releaseIdentityFitsTransport(numbers: readonly unknown[]): boolean {
  return Buffer.byteLength(JSON.stringify(numbers), 'utf8') <= RELEASE_IDENTITY_MAX_BYTES;
}

export function assertReleaseIdentityTransport(numbers: readonly unknown[]): void {
  if (!releaseIdentityFitsTransport(numbers)) {
    throw { code: 'CONFLICT', message: `Inline release identity exceeds the ${RELEASE_IDENTITY_MAX_BYTES}-byte transport budget` };
  }
}
