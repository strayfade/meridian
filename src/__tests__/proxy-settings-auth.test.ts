/**
 * Auth boundary: model routes are gated, the dashboard is not.
 *
 * The dashboard (pages, telemetry, metrics, profile/settings/plugin
 * management) is expected to sit behind a firewall, so it carries no sign-in
 * and needs no Token even when profiles have accessKeys. Token auth applies to
 * the model endpoints only (/v1/*, /messages, /design-login).
 */
import { describe, it, expect } from "bun:test"
import type { ProfileConfig } from "../proxy/profiles"

const { mintToken } = await import("../proxy/profileKeys")
const { createProxyServer } = await import("../proxy/server")

function gatedServer() {
  const token = mintToken()
  const profiles: ProfileConfig[] = [{ id: "test", type: "claude-max", accessKey: token }]
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
  return { app, token }
}

describe("dashboard is open when profiles have accessKeys", () => {
  it("serves every page without a Token", async () => {
    const { app } = gatedServer()
    for (const page of ["/", "/telemetry", "/profiles", "/providers", "/settings", "/plugins", "/telemetry/icon.svg"]) {
      const res = await app.fetch(new Request(`http://localhost${page}`, { headers: { accept: "text/html" } }))
      expect(res.status, page).toBe(200)
    }
  })

  it("serves every data endpoint the pages fetch without a Token", async () => {
    const { app } = gatedServer()
    for (const path of [
      "/telemetry/summary",
      "/telemetry/requests",
      "/telemetry/logs",
      "/profiles/list",
      "/profiles/health",
      "/providers/view",
      "/settings/api/features",
      "/settings/api/routing",
      "/settings/api/telemetry",
      "/settings/api/pricing",
      "/plugins/list",
      "/metrics",
      "/v1/usage/quota/all",
      "/v1/usage/quota",
    ]) {
      const res = await app.fetch(new Request(`http://localhost${path}`))
      expect(res.status, path).not.toBe(401)
    }
  })

  it("lets dashboard mutations through without a Token", async () => {
    const { app } = gatedServer()
    const patch = await app.fetch(new Request("http://localhost/settings/api/features/opencode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sharedMemory: true }),
    }))
    expect(patch.status).not.toBe(401)
    const del = await app.fetch(new Request("http://localhost/settings/api/features/opencode", { method: "DELETE" }))
    expect(del.status).not.toBe(401)
    const login = await app.fetch(new Request("http://localhost/auth/claude/start?profile=test"))
    expect(login.status).not.toBe(401)
  })

  it("still works when a Token is sent anyway", async () => {
    const { app, token } = gatedServer()
    const res = await app.fetch(new Request("http://localhost/settings/api/features", { headers: { "x-api-key": token } }))
    expect(res.status).toBe(200)
  })

  it("is open when only the global MERIDIAN_API_KEY is configured", async () => {
    const previous = process.env.MERIDIAN_API_KEY
    process.env.MERIDIAN_API_KEY = "global-secret"
    try {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      for (const path of ["/telemetry/summary", "/profiles/list", "/settings/api/features", "/v1/usage/quota/all"]) {
        const res = await app.fetch(new Request(`http://localhost${path}`))
        expect(res.status, path).not.toBe(401)
      }
      const model = await app.fetch(new Request("http://localhost/v1/models"))
      expect(model.status).toBe(401)
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_API_KEY
      else process.env.MERIDIAN_API_KEY = previous
    }
  })
})

describe("model routes keep their Token auth", () => {
  it("/v1/messages requires a Token", async () => {
    const { app } = gatedServer()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }))
    expect(res.status).toBe(401)
  })

  it("/v1/messages accepts a valid Token from the matching profile", async () => {
    const { app, token } = gatedServer()
    // Fails downstream (no real SDK) but must not be rejected as unauthenticated.
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": token },
      body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }))
    expect(res.status).not.toBe(401)
  })

  it("rejects a wrong Token on a model route", async () => {
    const { app } = gatedServer()
    const res = await app.fetch(new Request("http://localhost/v1/models", { headers: { "x-api-key": mintToken() } }))
    expect(res.status).toBe(401)
  })

  it("the dashboard usage-feed exemption does not cover other /v1 routes or methods", async () => {
    const { app } = gatedServer()
    for (const [method, path] of [
      ["GET", "/v1/models"],
      ["GET", "/v1/sessions/recover"],
      ["POST", "/v1/usage/quota/all"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/messages"],
      ["GET", "/design-login"],
    ] as const) {
      const res = await app.fetch(new Request(`http://localhost${path}`, { method }))
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
})

// ---------------------------------------------------------------------------
// Audit: every registered route is either a model route (401 without a Token)
// or part of the open dashboard (never 401). A new route that lands on the
// wrong side of that line fails here.
// ---------------------------------------------------------------------------
describe("auth audit: model routes are gated, everything else is open", () => {
  const DASHBOARD_V1_READS = new Set(["/v1/usage/quota", "/v1/usage/quota/all"])
  const isModelRoute = (path: string) =>
    (path.startsWith("/v1/") && !DASHBOARD_V1_READS.has(path)) || path === "/messages" || path === "/design-login"

  it("gates exactly the model routes", async () => {
    const { app } = gatedServer()

    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
    const paths = new Set<string>()
    for (const r of routes) {
      if (r.method === "ALL") continue
      paths.add(r.path.replace(/:\w+/g, "x"))
    }

    const failures: string[] = []
    for (const path of paths) {
      const res = await app.fetch(new Request(`http://localhost${path}`))
      const gated = res.status === 401
      if (isModelRoute(path) && !gated) failures.push(`${path} returned ${res.status} (model route must be gated)`)
      if (!isModelRoute(path) && gated) failures.push(`${path} returned 401 (dashboard route must be open)`)
    }

    expect(failures).toEqual([])
  })
})
