/**
 * Per-profile Token authentication middleware.
 *
 * Replaces MERIDIAN_API_KEY with per-profile accessKey from profiles.json.
 * - Model routes (/v1/*): Token selects its profile (no header needed).
 * - Dashboard/mutation routes: any valid Token grants access.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { Context, Next } from "hono"
import type { ProfileConfig } from "./profiles"
import { findProfileByToken, anyProfileHasKey } from "./profileKeys"

const TOKEN_PREFIX = "mrd_"

/** Whether any profile has an accessKey (gate engagement). */
export function tokenAuthEnabled(profiles: ProfileConfig[]): boolean {
  return anyProfileHasKey(profiles)
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Hashes both values to ensure equal-length comparison regardless of input.
 */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHmac("sha256", "meridian-token").update(a).digest()
  const hashB = createHmac("sha256", "meridian-token").update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

/** Shared by Hono and standard-Request runtimes. */
export function hasValidToken(headers: Headers, profiles: ProfileConfig[]): boolean {
  if (!anyProfileHasKey(profiles)) return true
  const authorization = headers.get("authorization")
  const provided = headers.get("x-api-key") || (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined)
  if (!provided || !provided.startsWith(TOKEN_PREFIX)) return false
  return findProfileByToken(provided, profiles) !== undefined
}

/**
 * Extract the Token from the request.
 * Checks x-api-key header first, then Authorization: Bearer.
 */
export function extractToken(c: Context): string | undefined {
  const apiKey = c.req.header("x-api-key")
  if (apiKey) return apiKey

  const auth = c.req.header("authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice(7)

  return undefined
}

/**
 * Model-route auth: Token selects profile.
 * Stashes profileId on context for downstream resolution.
 * Returns matched profile or throws 401/403.
 */
export async function requireModelAuth(
  c: Context,
  next: Next,
  profiles: ProfileConfig[],
  explicitHeader?: string
): Promise<Response | void> {
  if (!anyProfileHasKey(profiles)) return next()

  const provided = extractToken(c)
  if (!provided || !provided.startsWith(TOKEN_PREFIX)) {
    return c.json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid or missing Token",
      },
    }, 401)
  }

  const matched = findProfileByToken(provided, profiles)
  if (!matched) {
    return c.json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid or missing Token",
      },
    }, 401)
  }

  // Explicit x-meridian-profile header must match Token's profile
  if (explicitHeader && explicitHeader !== matched.id) {
    return c.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `Token belongs to profile "${matched.id}", but x-meridian-profile header specifies "${explicitHeader}"`,
      },
    }, 403)
  }

  c.set("tokenProfileId", matched.id)
  return next()
}

/**
 * Dashboard/mutation auth: any valid Token grants access.
 * Does not select profile — just validates.
 */
export async function requireDashboardAuth(
  c: Context,
  next: Next,
  profiles: ProfileConfig[]
): Promise<Response | void> {
  if (!anyProfileHasKey(profiles)) return next()

  const provided = extractToken(c)
  if (!provided || !provided.startsWith(TOKEN_PREFIX)) {
    return c.json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid or missing Token",
      },
    }, 401)
  }

  const matched = findProfileByToken(provided, profiles)
  if (!matched) {
    return c.json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid or missing Token",
      },
    }, 401)
  }

  return next()
}