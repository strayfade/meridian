/**
 * Unit tests for src/proxy/profileWeb.ts — the web login session lifecycle.
 *
 * Mirrors the createDesignLogin coverage in design-module.test.ts: session
 * start, code exchange with an injected fetch + store, single-use sessions,
 * expiry, and every rejection path. The token exchange shape matches the CLI
 * headless flow (completeManualOAuthLogin in profileCli.ts) so a credential
 * written here reads back identically there.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { createProfileWebLogin } from "../proxy/profileWeb"
import type { CredentialStore, CredentialsFile } from "../proxy/tokenRefresh"

function memoryStore(): CredentialStore & { data: CredentialsFile | null; dirs: string[] } {
  const box = {
    data: null as CredentialsFile | null,
    dirs: [] as string[],
    async read() { return box.data },
    async write(d: CredentialsFile) { box.data = d; return true },
  }
  return box
}

const NOW = 1_800_000_000_000

function sessionFactory() {
  let n = 0
  return () => {
    n++
    return {
      authorizeUrl: `https://claude.com/cai/oauth/authorize?state=web-state-${n}`,
      codeVerifier: `web-verifier-${n}`,
      state: `web-state-${n}`,
    }
  }
}

const CLAUDE_MAX = { id: "personal", type: "claude-max", claudeConfigDir: "/tmp/meridian-test/personal" }

function tokenFetch(calls: unknown[], tokenData: unknown = {
  access_token: "web-access",
  refresh_token: "web-refresh",
  expires_in: 28800,
  scope: "org:create_api_key user:profile user:inference",
}) {
  return (async (_url: unknown, init: { body: string }) => {
    calls.push(JSON.parse(init.body))
    return new Response(JSON.stringify(tokenData), { status: 200 })
  })
}

describe("createProfileWebLogin start", () => {
  it("returns an authorize URL, state, and profile", () => {
    const login = createProfileWebLogin({ createSession: sessionFactory(), now: () => NOW })
    const result = login.start(CLAUDE_MAX)
    expect(result.status).toBe(200)
    const body = result.body as { authorizeUrl: string; state: string; profile: string }
    expect(body.authorizeUrl).toContain("claude.com/cai/oauth/authorize")
    expect(body.state).toBe("web-state-1")
    expect(body.profile).toBe("personal")
  })

  it("rejects oauth-token profiles with a CLI-equivalent hint", () => {
    const login = createProfileWebLogin({ createSession: sessionFactory(), now: () => NOW })
    const result = login.start({ id: "ci", type: "oauth-token" })
    expect(result.status).toBe(400)
    expect((result.body as { error: { message: string } }).error.message).toContain("OAuth token")
  })

  it("rejects api profiles", () => {
    const login = createProfileWebLogin({ createSession: sessionFactory(), now: () => NOW })
    const result = login.start({ id: "direct", type: "api" })
    expect(result.status).toBe(400)
    expect((result.body as { error: { message: string } }).error.message).toContain("API key")
  })
})

describe("createProfileWebLogin exchange", () => {
  it("trades the code for stored credentials in the profile dir", async () => {
    const store = memoryStore()
    const seenDirs: string[] = []
    const calls: unknown[] = []
    const login = createProfileWebLogin({
      storeForDir: (dir: string) => {
        seenDirs.push(dir)
        return store
      },
      createSession: sessionFactory(),
      fetchFn: tokenFetch(calls) as never,
      planFields: async () => ({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" }),
      now: () => NOW,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    const result = await login.exchange({ profile: "personal", code: `some-code#${state}`, state })
    expect(result.status).toBe(200)
    expect((result.body as { success: boolean }).success).toBe(true)
    expect(seenDirs).toEqual(["/tmp/meridian-test/personal"])
    const sent = calls[0] as Record<string, string>
    expect(sent.grant_type).toBe("authorization_code")
    expect(sent.code).toBe("some-code")
    expect(sent.code_verifier).toBe("web-verifier-1")
    expect(store.data?.claudeAiOauth.accessToken).toBe("web-access")
    expect(store.data?.claudeAiOauth.refreshToken).toBe("web-refresh")
    expect(store.data?.claudeAiOauth.subscriptionType).toBe("max")
    expect(store.data?.claudeAiOauth.rateLimitTier).toBe("default_claude_max_5x")
    expect(store.data?.claudeAiOauth.expiresAt).toBe(NOW + 28800 * 1000)
  })

  it("accepts a full callback URL as the code", async () => {
    const store = memoryStore()
    const calls: unknown[] = []
    const login = createProfileWebLogin({
      storeForDir: () => store,
      createSession: sessionFactory(),
      fetchFn: tokenFetch(calls) as never,
      planFields: async () => ({}),
      now: () => NOW,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    const result = await login.exchange({
      profile: "personal",
      code: `https://platform.claude.com/oauth/code/callback?code=url-code&state=${state}`,
    })
    expect(result.status).toBe(200)
    expect((calls[0] as Record<string, string>).code).toBe("url-code")
  })

  it("falls back to the profile's own directory when no config dir is set", async () => {
    const seenDirs: string[] = []
    const store = memoryStore()
    const login = createProfileWebLogin({
      storeForDir: (dir: string) => {
        seenDirs.push(dir)
        return store
      },
      createSession: sessionFactory(),
      fetchFn: tokenFetch([]) as never,
      planFields: async () => ({}),
      now: () => NOW,
    })
    process.env.MERIDIAN_CONFIG_DIR = join("/tmp", "meridian-web-login-test")
    try {
      const { state } = login.startRaw({ id: "fresh", type: "claude-max" })
      const result = await login.exchange({ profile: "fresh", code: `c#${state}`, state })
      expect(result.status).toBe(200)
      expect(seenDirs).toEqual([join("/tmp", "meridian-web-login-test", "profiles", "fresh")])
    } finally {
      delete process.env.MERIDIAN_CONFIG_DIR
    }
  })

  it("rejects a code for a different profile than the session's", async () => {
    const login = createProfileWebLogin({
      storeForDir: () => memoryStore(),
      createSession: sessionFactory(),
      fetchFn: tokenFetch([]) as never,
      now: () => NOW,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    const result = await login.exchange({ profile: "work", code: `c#${state}`, state })
    expect(result.status).toBe(400)
    expect((result.body as { error: { type: string } }).error.type).toBe("invalid_request")
  })

  it("rejects an unknown or expired state", async () => {
    const login = createProfileWebLogin({ createSession: sessionFactory(), now: () => NOW })
    const missing = await login.exchange({ profile: "personal", code: "c#no-such-state", state: "no-such-state" })
    expect(missing.status).toBe(400)
    expect((missing.body as { error: { type: string } }).error.type).toBe("session_expired")
  })

  it("rejects a missing profile or code", async () => {
    const login = createProfileWebLogin({ createSession: sessionFactory(), now: () => NOW })
    expect(((await login.exchange({ code: "c" })).body as { error: { type: string } }).error.type).toBe("invalid_request")
    expect(((await login.exchange({ profile: "personal" })).body as { error: { type: string } }).error.type).toBe("invalid_request")
    expect(((await login.exchange({})).body as { error: { type: string } }).error.type).toBe("invalid_request")
  })

  it("sessions are single-use", async () => {
    const store = memoryStore()
    const login = createProfileWebLogin({
      storeForDir: () => store,
      createSession: sessionFactory(),
      fetchFn: tokenFetch([]) as never,
      planFields: async () => ({}),
      now: () => NOW,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    expect((await login.exchange({ profile: "personal", code: `c#${state}`, state })).status).toBe(200)
    expect((await login.exchange({ profile: "personal", code: `c#${state}`, state })).status).toBe(400)
  })

  it("sessions expire after 10 minutes", async () => {
    let now = NOW
    const login = createProfileWebLogin({
      storeForDir: () => memoryStore(),
      createSession: sessionFactory(),
      fetchFn: tokenFetch([]) as never,
      now: () => now,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    now += 11 * 60 * 1000
    const result = await login.exchange({ profile: "personal", code: `c#${state}`, state })
    expect(result.status).toBe(400)
    expect((result.body as { error: { type: string } }).error.type).toBe("session_expired")
  })

  it("a failed token exchange surfaces as 502", async () => {
    const login = createProfileWebLogin({
      storeForDir: () => memoryStore(),
      createSession: sessionFactory(),
      fetchFn: (async () => new Response("denied", { status: 403 })) as never,
      now: () => NOW,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    const result = await login.exchange({ profile: "personal", code: `c#${state}`, state })
    expect(result.status).toBe(502)
    expect((result.body as { error: { type: string } }).error.type).toBe("token_exchange_failed")
  })

  it("a token response missing the refresh token fails like the CLI flow", async () => {
    const login = createProfileWebLogin({
      storeForDir: () => memoryStore(),
      createSession: sessionFactory(),
      fetchFn: tokenFetch([], { access_token: "only-access" }) as never,
      now: () => NOW,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    const result = await login.exchange({ profile: "personal", code: `c#${state}`, state })
    expect(result.status).toBe(502)
    expect((result.body as { error: { type: string } }).error.type).toBe("token_exchange_failed")
  })

  it("a store write failure surfaces as 500", async () => {
    const failing: CredentialStore = {
      async read() { return null },
      async write() { return false },
    }
    const login = createProfileWebLogin({
      storeForDir: () => failing,
      createSession: sessionFactory(),
      fetchFn: tokenFetch([]) as never,
      planFields: async () => ({}),
      now: () => NOW,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    const result = await login.exchange({ profile: "personal", code: `c#${state}`, state })
    expect(result.status).toBe(500)
    expect((result.body as { error: { type: string } }).error.type).toBe("storage_error")
  })
})

describe("createProfileWebLogin read-only mode", () => {
  beforeEach(() => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
  })

  afterEach(() => {
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
  })

  it("refuses to start a login session", () => {
    const login = createProfileWebLogin({ createSession: sessionFactory(), now: () => NOW })
    const result = login.start(CLAUDE_MAX)
    expect(result.status).toBe(403)
  })

  it("refuses the exchange even with a valid session", async () => {
    // Mint the session while writable, then engage read-only: the exchange
    // must still refuse before touching the network or disk.
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    const login = createProfileWebLogin({
      storeForDir: () => memoryStore(),
      createSession: sessionFactory(),
      fetchFn: (() => { throw new Error("no fetch expected") }) as never,
      now: () => NOW,
    })
    const { state } = login.startRaw(CLAUDE_MAX)
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const result = await login.exchange({ profile: "personal", code: `c#${state}`, state })
    expect(result.status).toBe(403)
    expect((result.body as { error: { type: string } }).error.type).toBe("forbidden")
  })
})
