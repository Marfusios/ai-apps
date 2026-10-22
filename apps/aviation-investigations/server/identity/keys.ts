/**
 * Keys of the anonymous identity layer, derived from IDENTITY_HMAC_SECRET with
 * HKDF-SHA256 and a distinct label per use, so no key serves two purposes and none of
 * them is the raw secret (which `principalHash` keys with its own message prefixes):
 *
 * - `trial-cookie-signature`: the MAC that makes the trial cookie tamper-evident;
 * - `trial-cookie-lookup`: the HMAC of the cookie's random value, the only form in which
 *   a cookie is stored (`trial_identities.cookie_hash`);
 * - `turnstile-token`: the HMAC under which a presented Turnstile token is claimed
 *   (`turnstile_redemptions`), so stored rows cannot be replayed as tokens.
 *
 * Rotating the secret ends every trial cookie (visitors pass a new check) and resets
 * the anonymous counters keyed by principal HMACs.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { MIN_SECRET_LENGTH, QuotaConfigError } from '../quota/policy.js';

export type IdentityKeyPurpose = 'trial-cookie-signature' | 'trial-cookie-lookup' | 'turnstile-token';

const SALT = 'aviation-casebook identity keys';

/** A 32-byte key for one purpose. Throws (fail closed) for a missing or short secret. */
export function deriveIdentityKey(secret: string, purpose: IdentityKeyPurpose): Buffer {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new QuotaConfigError(`IDENTITY_HMAC_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters)`);
  }
  return Buffer.from(hkdfSync('sha256', secret, SALT, `${purpose} v1`, 32));
}

/** HMAC-SHA256 of `value` under a derived key, as 64 hex characters. */
export function keyedHash(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}
