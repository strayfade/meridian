/**
 * Per-profile Token auth audit.
 *
 * With the new per-profile Token system (replacing MERIDIAN_API_KEY), every
 * dashboard/mutation route requires a valid Token from any profile. Model
 * routes require a Token from the specific profile being accessed.
 *
 * This test verifies that all non-public routes are gated by the dashboard
 * auth middleware when at least one profile has an accessKey.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import type { ProfileConfig } from "../proxy/profiles"

const { mintToken } = await import("../proxy/profileKeys")
const { createProxyServer } = await import("../proxy/server")

describe("Per-profile Token auth — /settings/api/* and all dashboard routes", () => {
  let token: string
  let profiles: ProfileConfig[]

  beforeAll(() => {
    token = mintToken()
    profiles = [{ id: "test", type: "claude-max", accessKey: token }]
  })

  it("rejects GET /settings/api/features without Token", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
    const res = await app.fetch(new Request("http://localhost/settings/api/features"))
    expect(res.status).toBe(401)
  })

  it("rejects PATCH /settings/api/features/:adapter without Token", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
    const res = await app.fetch(new Request("http://localhost/settings/api/features/opencode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sharedMemory: true }),
    }))
    expect(res.status).toBe(401)
  })

  it("rejects DELETE /settings/api/features/:adapter without Token", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
    const res = await app.fetch(new Request("http://localhost/settings/api/features/opencode", {
      method: "DELETE",
    }))
    expect(res.status).toBe(401)
  })

  it("serves GET /settings (HTML shell) without Token — data stays gated", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
    const res = await app.fetch(new Request("http://localhost/settings"))
    // The shell must load so browser navigation works once the tab holds a
    // Token (sessionStorage → x-api-key); gating it 401s the page itself with
    // raw authentication_error JSON before any JS can attach the key.
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
  })

  it("serves every HTML shell without Token while its JSON stays gated", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
    for (const shell of ["/telemetry", "/profiles", "/providers", "/settings", "/plugins", "/telemetry/icon.svg"]) {
      const res = await app.fetch(new Request(`http://localhost${shell}`))
      expect(res.status).toBe(200)
    }
    for (const gated of ["/telemetry/summary", "/profiles/list", "/providers/view", "/settings/api/features", "/plugins/list"]) {
      const res = await app.fetch(new Request(`http://localhost${gated}`))
      expect(res.status).toBe(401)
    }
  })

  it("accepts GET /settings/api/features with matching Token", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
    const res = await app.fetch(new Request("http://localhost/settings/api/features", {
      headers: { "x-api-key": token },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body).toBe("object")
  })

  it("accepts GET /settings/api/features with matching Bearer token", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
    const res = await app.fetch(new Request("http://localhost/settings/api/features", {
      headers: { "authorization": `Bearer ${token}` },
    }))
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Audit: any sensitive route added in the future must go through dashboardAuth.
// ---------------------------------------------------------------------------
describe("auth audit: every registered prefix is protected when profiles have accessKeys", () => {
  // Routes that are intentionally public. They serve read-only,
  // non-sensitive content (landing page; auth status; the two probes), plus
  // the full-page HTML shells: public so browser navigation works once the
  // tab holds a Token, with every data endpoint behind them still gated.
  const PUBLIC_PREFIXES = new Set([
    "/",
    "/health",
    "/livez",
    "/readyz",
    "/telemetry",
    "/telemetry/icon.svg",
    "/profiles",
    "/providers",
    "/settings",
    "/plugins",
  ])

  it("rejects unauthenticated requests to every non-public route prefix", async () => {
    const token = mintToken()
    const profiles: ProfileConfig[] = [{ id: "test", type: "claude-max", accessKey: token }]
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })

    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
    const prefixes = new Set<string>()
    for (const r of routes) {
      if (r.method === "ALL") continue
      const probePath = r.path.replace(/:\w+/g, "x")
      prefixes.add(probePath)
    }

    const failures: string[] = []
    for (const path of prefixes) {
      if (PUBLIC_PREFIXES.has(path)) continue
      const res = await app.fetch(new Request(`http://localhost${path}`))
      if (res.status !== 401) {
        failures.push(`${path} returned ${res.status} (expected 401 — not protected by dashboardAuth)`)
      }
    }

    expect(failures).toEqual([])
  })

  it("model route /v1/messages requires Token", async () => {
    const token = mintToken()
    const profiles: ProfileConfig[] = [{ id: "test", type: "claude-max", accessKey: token }]
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })

    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }))
    // /v1/messages requires model auth which also needs a Token
    expect(res.status).toBe(401)
  })

  it("model route /v1/messages accepts valid Token from matching profile", async () => {
    const token = mintToken()
    const profiles: ProfileConfig[] = [{ id: "test", type: "claude-max", accessKey: token }]
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })

    // This will fail with 503 (no real SDK) but should NOT be 401
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": token },
      body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }))
    expect(res.status).not.toBe(401)
  })
})