/**
 * HTTP integration tests for the web profile-management routes in
 * src/proxy/server.ts: GET /auth/claude/start, POST /auth/claude/exchange,
 * POST /profiles/add, POST /profiles/add-oauth-token, POST /profiles/remove.
 *
 * Follows profile-token-refresh-route.test.ts: file-backed credential
 * fixtures in a temp dir, global fetch mocked by URL, real Hono app via
 * createProxyServer. Credential-store writes are file-backed only on
 * Linux/Windows, so the exchange test skips on darwin like the refresh one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProxyServer } from "../proxy/server"
import { resetInflightRefresh, stopBackgroundRefresh } from "../proxy/tokenRefresh"

const TOKEN_RESPONSE = {
  access_token: "web-route-access",
  refresh_token: "web-route-refresh",
  expires_in: 3600,
  scope: "org:create_api_key user:profile user:inference",
}

const PLAN_RESPONSE = {
  organization: {
    organization_type: "claude_max",
    rate_limit_tier: "default_claude_max_5x",
    seat_tier: null,
  },
}

function credentials(accessToken: string, refreshToken: string) {
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3600000,
      subscriptionType: "max",
    },
  }
}

describe("web profile-management routes", () => {
  let originalFetch: typeof globalThis.fetch
  let tempDir: string
  let personalDir: string
  let savedConfigDir: string | undefined

  beforeEach(() => {
    originalFetch = globalThis.fetch
    tempDir = mkdtempSync(join(tmpdir(), "meridian-web-routes-"))
    personalDir = join(tempDir, "creds", "personal")
    mkdirSync(personalDir, { recursive: true })
    writeFileSync(join(personalDir, ".credentials.json"), JSON.stringify(credentials("personal-old", "personal-refresh")))
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    process.env.MERIDIAN_CONFIG_DIR = join(tempDir, "config")
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetInflightRefresh()
    stopBackgroundRefresh()
    if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
    else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    rmSync(tempDir, { recursive: true, force: true })
  })

  function mockUpstream() {
    const mockFetch: typeof fetch = Object.assign(
      async (input: unknown) => {
        const url = String(input)
        if (url.includes("platform.claude.com/v1/oauth/token")) {
          return new Response(JSON.stringify(TOKEN_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (url.includes("api.anthropic.com/api/oauth/profile")) {
          return new Response(JSON.stringify(PLAN_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        throw new Error(`unexpected upstream fetch: ${url}`)
      },
      { preconnect: originalFetch.preconnect },
    )
    globalThis.fetch = mockFetch
  }

  function createApp() {
    return createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [{ id: "personal", claudeConfigDir: personalDir }],
      defaultProfile: "personal",
      silent: true,
    })
  }

  it("starts a login session with an authorize URL", async () => {
    const { app } = createApp()
    const res = await app.fetch(new Request("http://localhost/auth/claude/start?profile=personal"))
    const body = (await res.json()) as { authorizeUrl?: string; state?: string; profile?: string }
    expect(res.status).toBe(200)
    expect(body.authorizeUrl).toContain("claude.com/cai/oauth/authorize")
    expect(body.state).toBeTruthy()
    expect(body.profile).toBe("personal")
  })

  it("start 404s unknown profiles and 400s a missing parameter", async () => {
    const { app } = createApp()
    const unknown = await app.fetch(new Request("http://localhost/auth/claude/start?profile=ghost"))
    expect(unknown.status).toBe(404)
    const missing = await app.fetch(new Request("http://localhost/auth/claude/start"))
    expect(missing.status).toBe(400)
  })

  // Skipped on macOS: the exchange writes through createPlatformCredentialStore,
  // which is Keychain-backed on darwin, so this cannot assert on a file there
  // without mutating the real login Keychain.
  it.skipIf(process.platform === "darwin")("completes a login and stores the credentials", async () => {
    mockUpstream()
    const { app } = createApp()

    const startRes = await app.fetch(new Request("http://localhost/auth/claude/start?profile=personal"))
    const start = (await startRes.json()) as { state: string }

    const exchangeRes = await app.fetch(new Request("http://localhost/auth/claude/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "personal", code: `pasted-code#${start.state}`, state: start.state }),
    }))
    const body = (await exchangeRes.json()) as { success?: boolean; profile?: string }
    expect(exchangeRes.status).toBe(200)
    expect(body).toMatchObject({ success: true, profile: "personal" })

    const stored = JSON.parse(readFileSync(join(personalDir, ".credentials.json"), "utf-8"))
    expect(stored.claudeAiOauth.accessToken).toBe("web-route-access")
    expect(stored.claudeAiOauth.refreshToken).toBe("web-route-refresh")
    expect(stored.claudeAiOauth.subscriptionType).toBe("max")
  })

  it("exchange rejects a stale session without touching upstream", async () => {
    let fetched = false
    const mockFetch: typeof fetch = Object.assign(
      async () => {
        fetched = true
        return new Response("{}", { status: 200 })
      },
      { preconnect: originalFetch.preconnect },
    )
    globalThis.fetch = mockFetch
    const { app } = createApp()
    const res = await app.fetch(new Request("http://localhost/auth/claude/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "personal", code: "c#no-such-state", state: "no-such-state" }),
    }))
    expect(res.status).toBe(400)
    expect(fetched).toBe(false)
  })

  it("adds and removes a profile on disk", async () => {
    const { app } = createApp()

    const addRes = await app.fetch(new Request("http://localhost/profiles/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "webacc" }),
    }))
    const added = (await addRes.json()) as { success?: boolean; profile?: { id: string; claudeConfigDir: string } }
    expect(addRes.status).toBe(200)
    expect(added.success).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(tempDir, "config", "profiles.json"), "utf-8"))
    expect(onDisk).toEqual([{ id: "webacc", claudeConfigDir: added.profile?.claudeConfigDir }])
    expect(existsSync(added.profile?.claudeConfigDir ?? "")).toBe(true)

    const dupRes = await app.fetch(new Request("http://localhost/profiles/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "webacc" }),
    }))
    expect(dupRes.status).toBe(400)

    const removeRes = await app.fetch(new Request("http://localhost/profiles/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "webacc" }),
    }))
    expect(removeRes.status).toBe(200)
    expect(JSON.parse(readFileSync(join(tempDir, "config", "profiles.json"), "utf-8"))).toEqual([])
    expect(existsSync(added.profile?.claudeConfigDir ?? "")).toBe(false)
  })

  it("adds an oauth-token profile without echoing the token", async () => {
    const { app } = createApp()
    const res = await app.fetch(new Request("http://localhost/profiles/add-oauth-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "webci", token: "sk-ant-oat01-secret" }),
    }))
    const body = (await res.json()) as { success?: boolean; profile?: Record<string, string> }
    expect(res.status).toBe(200)
    expect(body.profile).toEqual({ id: "webci", type: "oauth-token" })
    expect(JSON.stringify(body)).not.toContain("sk-ant-oat01-secret")
  })

  it("remove 400s unknown profiles", async () => {
    const { app } = createApp()
    const res = await app.fetch(new Request("http://localhost/profiles/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ghost" }),
    }))
    expect(res.status).toBe(400)
  })
})
