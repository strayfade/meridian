/**
 * Per-profile dashboard/API Token generation and validation.
 *
 * Tokens are plaintext in profiles.json (re-viewable by design).
 * Uses constant-time comparison for validation.
 */

import { randomBytes } from "node:crypto"
import { createHmac, timingSafeEqual } from "node:crypto"
import type { ProfileConfig } from "./profiles"

/** Token prefix for easy identification */
const TOKEN_PREFIX = "mrd_"

/** Token entropy bytes (32 bytes = 256 bits) */
const TOKEN_ENTROPY_BYTES = 32

/**
 * Generate a new dashboard/API Token.
 * Format: mrd_<base64url-encoded-32-random-bytes>
 */
export function mintToken(): string {
  const entropy = randomBytes(TOKEN_ENTROPY_BYTES)
  const base64url = entropy.toString("base64url")
  return `${TOKEN_PREFIX}${base64url}`
}

/**
 * Constant-time comparison to prevent timing attacks.
 * Hashes both values to ensure equal-length comparison regardless of input.
 */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHmac("sha256", "meridian-token").update(a).digest()
  const hashB = createHmac("sha256", "meridian-token").update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

/**
 * Validate a Token against the effective profile list.
 * Returns the matching profile (with accessKey) or undefined.
 */
export function validateToken(
  provided: string,
  profiles: ProfileConfig[]
): ProfileConfig | undefined {
  if (!provided || !provided.startsWith(TOKEN_PREFIX)) return undefined
  for (const p of profiles) {
    if (p.accessKey && safeCompare(provided, p.accessKey)) {
      return p
    }
  }
  return undefined
}

/**
 * Check if any profile has an accessKey (used for bootstrap gate).
 */
export function anyProfileHasKey(profiles: ProfileConfig[]): boolean {
  return profiles.some(p => p.accessKey && p.accessKey.startsWith(TOKEN_PREFIX))
}

/**
 * Find profile by accessKey (for model-route profile selection).
 */
export function findProfileByToken(
  provided: string,
  profiles: ProfileConfig[]
): ProfileConfig | undefined {
  return validateToken(provided, profiles)
}