/**
 * Web-driven Claude profile management.
 *
 * The browser equivalent of `meridian profile add|login|remove` (see
 * profileCli.ts): a PKCE OAuth session the dashboard starts, shows as a link,
 * and completes with a pasted code — plus disk add/remove for browser-login
 * profiles. Session mechanics mirror createDesignLogin in design.ts; the token
 * exchange mirrors completeManualOAuthLogin in profileCli.ts (same authorize
 * URL, same token endpoint, same credential file via buildLoginCredentials).
 *
 * This is a leaf module — no imports from server.ts or session/. server.ts
 * only mounts routes; all logic (including the HTTP result shapes) lives here
 * so it is unit-testable without a server.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { configPath } from "../configDir"
import { claudeLog } from "../logger"
import { isCredentialsReadOnly } from "./credentialsMode"
import { fetchOAuthPlanFields, type OAuthPlanFields } from "./oauthPlan"
import {
  buildLoginCredentials,
  createManualOAuthSession,
  dirsToRemoveOnProfileRemove,
  isValidProfileId,
  parseAuthorizationCodeInput,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  OAUTH_TOKEN_URL,
} from "./profileCli"
import {
  defaultProfilesConfigFile,
  defaultProfilesDir,
  loadProfileConfigFrom,
  reclaimAlias,
  saveProfileConfigTo,
} from "./profileRename"
import { createPlatformCredentialStore, type CredentialStore } from "./tokenRefresh"
import type { ProfileConfig } from "./profiles"

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Login sessions live only this long — same window as /design-login. */
const WEB_LOGIN_SESSION_TTL_MS = 10 * 60 * 1000

export interface ProfileWebResult {
  status: number
  body: unknown
}

export interface ProfileWebLogin {
  /** Start a login session; returns the JSON body for GET /auth/claude/start. */
  start(input: { id: string; type: string; claudeConfigDir?: string }): ProfileWebResult
  /** Like start() but also exposes the state, for tests. */
  startRaw(input: { id: string; type: string; claudeConfigDir?: string }): { authorizeUrl: string; state: string; profile: string }
  /** Handle POST /auth/claude/exchange: trade the pasted code for stored credentials. */
  exchange(body: unknown): Promise<ProfileWebResult>
}

interface LoginSession {
  codeVerifier: string
  profileId: string
  claudeConfigDir: string
  expiresAt: number
}

function errorBody(status: number, type: string, message: string): ProfileWebResult {
  return { status, body: { type: "error", error: { type, message } } }
}

function resolveLoginDir(input: { id: string; claudeConfigDir?: string }): string {
  // Same fallback as `meridian profile login`: an explicit config dir wins,
  // otherwise the profile's own directory under profiles/. A claude-max
  // profile with no explicit dir is served from the default ~/.claude store,
  // so a login written to profiles/<id>/ would not take effect for it — but
  // every profile `meridian profile add` writes carries its dir, and the web
  // add route below always sets one. Hand-made dir-less profiles keep the
  // CLI's behaviour rather than gaining a second one here.
  return input.claudeConfigDir ?? configPath("profiles", input.id)
}

export function createProfileWebLogin(deps: {
  storeForDir?: (claudeConfigDir: string) => CredentialStore
  createSession?: () => { authorizeUrl: string; codeVerifier: string; state: string }
  fetchFn?: FetchLike
  planFields?: (accessToken: string) => Promise<OAuthPlanFields>
  now?: () => number
}): ProfileWebLogin {
  const storeForDir = deps.storeForDir ?? ((dir: string) => createPlatformCredentialStore({ claudeConfigDir: dir }))
  const createSession = deps.createSession ?? createManualOAuthSession
  const fetchFn = deps.fetchFn ?? fetch
  const planFields = deps.planFields ?? fetchOAuthPlanFields
  const now = deps.now ?? Date.now
  const sessions = new Map<string, LoginSession>()

  const startRaw = (input: { id: string; type: string; claudeConfigDir?: string }) => {
    for (const [state, session] of sessions) {
      if (session.expiresAt < now()) sessions.delete(state)
    }
    const session = createSession()
    const claudeConfigDir = resolveLoginDir(input)
    sessions.set(session.state, {
      codeVerifier: session.codeVerifier,
      profileId: input.id,
      claudeConfigDir,
      expiresAt: now() + WEB_LOGIN_SESSION_TTL_MS,
    })
    return { authorizeUrl: session.authorizeUrl, state: session.state, profile: input.id }
  }

  return {
    startRaw,

    start(input) {
      if (input.type !== "claude-max") {
        const hint = input.type === "oauth-token"
          ? `Profile "${input.id}" uses an OAuth token; browser login does not apply. Remove it and add it again with a new token.`
          : `Profile "${input.id}" uses a direct API key; browser login does not apply.`
        return errorBody(400, "invalid_request", hint)
      }
      if (isCredentialsReadOnly()) {
        return errorBody(403, "forbidden", "MERIDIAN_CREDENTIALS_READONLY=1 — this instance may not modify credentials.")
      }
      const { authorizeUrl, state, profile } = startRaw(input)
      return {
        status: 200,
        body: {
          authorizeUrl,
          state,
          profile,
          instructions: "Open the URL in your browser and sign into the Claude account for this profile. Then paste the code Claude shows into the dashboard to complete the login.",
        },
      }
    },

    async exchange(rawBody) {
      const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as { profile?: string; code?: string; state?: string }
      if (!body.profile) {
        return errorBody(400, "invalid_request", "Missing 'profile' field.")
      }
      const parsed = body.code ? parseAuthorizationCodeInput(body.code) : null
      if (!parsed) {
        return errorBody(400, "invalid_request", "Missing or invalid 'code' field.")
      }

      const stateKey = parsed.state ?? body.state
      const stored = stateKey ? sessions.get(stateKey) : undefined
      if (!stateKey || !stored || stored.expiresAt < now()) {
        return errorBody(400, "session_expired", "OAuth session expired or not found. Start a new login to get a fresh link.")
      }
      if (stored.profileId !== body.profile) {
        return errorBody(400, "invalid_request", `This login link was started for profile "${stored.profileId}", not "${body.profile}". Start a new login for "${body.profile}".`)
      }
      sessions.delete(stateKey)

      if (isCredentialsReadOnly()) {
        return errorBody(403, "forbidden", "MERIDIAN_CREDENTIALS_READONLY=1 — this instance may not modify credentials.")
      }

      let response: Response
      try {
        response = await fetchFn(OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: OAUTH_CLIENT_ID,
            code: parsed.code,
            redirect_uri: OAUTH_REDIRECT_URI,
            code_verifier: stored.codeVerifier,
            state: stateKey,
          }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch (err) {
        claudeLog("auth.web_token_request_failed", { profile: stored.profileId, error: String(err) })
        return errorBody(502, "upstream_error", err instanceof Error ? err.message : String(err))
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        claudeLog("auth.web_token_bad_response", { profile: stored.profileId, status: response.status })
        return errorBody(502, "token_exchange_failed", `Token exchange failed (${response.status}): ${text.slice(0, 200)}`)
      }

      let tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number; scope?: string }
      try {
        tokenData = await response.json() as typeof tokenData
      } catch (err) {
        claudeLog("auth.web_token_parse_failed", { profile: stored.profileId, error: String(err) })
        return errorBody(502, "token_exchange_failed", "Token response was not valid JSON.")
      }

      // Same requirement as the CLI headless flow: both tokens must be
      // present, otherwise the login looks done and dies on first refresh.
      if (!tokenData.access_token || !tokenData.refresh_token) {
        return errorBody(502, "token_exchange_failed", "Token response did not include the required tokens.")
      }

      const plan = await planFields(tokenData.access_token)
      const credentials = buildLoginCredentials(
        { access_token: tokenData.access_token, refresh_token: tokenData.refresh_token, expires_in: tokenData.expires_in, expires_at: tokenData.expires_at, scope: tokenData.scope },
        plan,
        now(),
      )
      const written = await storeForDir(stored.claudeConfigDir).write(credentials)
      if (!written) {
        return errorBody(500, "storage_error", `Could not store credentials for profile "${stored.profileId}".`)
      }
      claudeLog("auth.web_login_completed", { profile: stored.profileId })
      return { status: 200, body: { success: true, profile: stored.profileId, scopes: credentials.claudeAiOauth.scopes } }
    },
  }
}

// ---------------------------------------------------------------------------
// Disk profile add/remove — the server-side half of
// `meridian profile add|remove`, minus prompts and the login itself.
// ---------------------------------------------------------------------------

export interface WebProfileMutation {
  ok: boolean
  error?: string
  profile?: ProfileConfig
}

/**
 * Create a browser-login profile entry: validate, create its config dir,
 * append `{ id, claudeConfigDir }` to profiles.json (0600, reclaiming any
 * alias of the same name). The account itself is linked afterwards through
 * the web login flow — same split as `profile add --headless` failing before
 * its code prompt leaves a dir behind: the entry exists, login completes it.
 */
export function addWebProfile(id: string): WebProfileMutation {
  if (!isValidProfileId(id)) {
    return { ok: false, error: "Invalid profile ID. Use only letters, numbers, hyphens, underscores." }
  }
  if (isCredentialsReadOnly()) {
    return { ok: false, error: "MERIDIAN_CREDENTIALS_READONLY=1 — this instance may not modify credentials." }
  }
  const file = defaultProfilesConfigFile()
  let profiles = loadProfileConfigFrom(file)
  if (profiles.find(p => p.id === id)) {
    return { ok: false, error: `Profile "${id}" already exists.` }
  }
  profiles = reclaimAlias(profiles, id)
  const claudeConfigDir = join(defaultProfilesDir(), id)
  mkdirSync(claudeConfigDir, { recursive: true })
  const profile: ProfileConfig = { id, claudeConfigDir }
  profiles.push(profile)
  saveProfileConfigTo(file, profiles)
  return { ok: true, profile }
}

/**
 * Add an OAuth-token profile (`claude setup-token` value), the web
 * equivalent of `meridian profile add <id> --oauth-token <token>`.
 */
export function addWebOAuthTokenProfile(id: string, token: string): WebProfileMutation {
  if (!isValidProfileId(id)) {
    return { ok: false, error: "Invalid profile ID. Use only letters, numbers, hyphens, underscores." }
  }
  if (!token.trim()) {
    return { ok: false, error: "Empty token. Generate one with `claude setup-token`." }
  }
  if (isCredentialsReadOnly()) {
    return { ok: false, error: "MERIDIAN_CREDENTIALS_READONLY=1 — this instance may not modify credentials." }
  }
  const file = defaultProfilesConfigFile()
  let profiles = loadProfileConfigFrom(file)
  if (profiles.find(p => p.id === id)) {
    return { ok: false, error: `Profile "${id}" already exists.` }
  }
  profiles = reclaimAlias(profiles, id)
  const profile: ProfileConfig = { id, type: "oauth-token", oauthToken: token.trim() }
  profiles.push(profile)
  saveProfileConfigTo(file, profiles)
  return { ok: true, profile: { id, type: "oauth-token" } }
}

/**
 * Remove a profile entry and delete its on-disk credential directories —
 * the same directories `meridian profile remove` deletes (see
 * dirsToRemoveOnProfileRemove). Never touches a config dir outside the
 * profiles directory (e.g. an imported ~/.claude): the entry is dropped and
 * the shared credentials stay where they were.
 */
export function removeWebProfile(id: string): WebProfileMutation {
  if (isCredentialsReadOnly()) {
    return { ok: false, error: "MERIDIAN_CREDENTIALS_READONLY=1 — this instance may not modify credentials." }
  }
  const file = defaultProfilesConfigFile()
  const profiles = loadProfileConfigFrom(file)
  const idx = profiles.findIndex(p => p.id === id)
  if (idx === -1) {
    return { ok: false, error: `Profile "${id}" not found.` }
  }
  const removed = profiles[idx]
  if (!removed) {
    return { ok: false, error: `Profile "${id}" not found.` }
  }
  const dirsToRemove = dirsToRemoveOnProfileRemove(removed, defaultProfilesDir())
  profiles.splice(idx, 1)
  saveProfileConfigTo(file, profiles)
  for (const dir of dirsToRemove) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  return { ok: true, profile: { id } }
}
