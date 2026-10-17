import { ValidationError } from '../domain/index.js';

// This is provenance of a server-verified /api/me response, not permission to
// publish. The upload/commit adapters must still check live CatsCo authority.
export function requireCatsCoIssuer(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value ||
        url.username || url.password) throw new Error();
    return value;
  } catch {
    throw new ValidationError('CatsCo identity authority is invalid.', 'catsco.publisher_issuer_invalid', 400);
  }
}

export function assertCatsCoIssuerMatches(profile, issuer) {
  // Legacy records remain legacy: a fresh login under today's configuration
  // cannot prove which service originally owned a historical UID.
  if (profile?.catsco_issuer != null && profile.catsco_issuer !== issuer) {
    throw new ValidationError('CatsCo publisher identity belongs to another authority.',
      'catsco.publisher_issuer_conflict', 409);
  }
}
