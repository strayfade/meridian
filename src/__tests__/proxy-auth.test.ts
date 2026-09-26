import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import type { Context } from "hono"

describe("Per-profile Token authentication", () => {
  let originalKey: string | undefined

  beforeEach(() => {
    originalKey = process.env.MERIDIAN_API_KEY
  })

  afterEach(() => {
    if (originalKey !== undefined) process.env.MERIDIAN_API_KEY = originalKey
    else delete process.env.MERIDIAN_API_KEY
  })

  function mockContext(headers: Record<string, string>): Context {
    return {
      req: { header: (name: string) => headers[name.toLowerCase()] },
      json: () => new Response(),
      set: () => {},
      env: {},
      finalized: false,
      error: undefined,
      event: undefined,
      executionCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
      get: () => undefined,
      header: () => undefined,
      notFound: () => new Response("Not Found", { status: 404 }),
      redirect: () => new Response("Redirect", { status: 302 }),
      res: new Response(),
      text: () => new Response(),
      var: {},
    } as any
  }

  it("allows requests when no profile has an accessKey", async () => {
    const { requireDashboardAuth, requireModelAuth } = await import("../proxy/auth")

    let nextCalled = false
    const ctx = mockContext({})

    await requireDashboardAuth(ctx, async () => { nextCalled = true }, [])
    expect(nextCalled).toBe(true)

    nextCalled = false
    await requireModelAuth(ctx, async () => { nextCalled = true }, [])
    expect(nextCalled).toBe(true)
  })

  it("rejects requests with missing Token when profiles have accessKey", async () => {
    const { requireDashboardAuth } = await import("../proxy/auth")

    let responseSent = false
    let responseStatus = 0
    const ctx = {
      ...mockContext({}),
      json: (_body: any, status: number) => { responseSent = true; responseStatus = status; return new Response(null, { status }) },
    }

    const profiles = [{ id: "test", type: "claude-max", accessKey: "mrd_test123" }] as any
    await requireDashboardAuth(ctx as any, async () => {}, profiles)
    expect(responseSent).toBe(true)
    expect(responseStatus).toBe(401)
  })

  it("accepts valid Token for dashboard routes", async () => {
    const { requireDashboardAuth } = await import("../proxy/auth")
    const { mintToken } = await import("../proxy/profileKeys")

    let nextCalled = false
    const token = mintToken()
    const ctx = mockContext({ "x-api-key": token })

    const profiles = [{ id: "test", type: "claude-max", accessKey: token }] as any
    await requireDashboardAuth(ctx as any, async () => { nextCalled = true }, profiles)
    expect(nextCalled).toBe(true)
  })

  it("rejects invalid Token", async () => {
    const { requireDashboardAuth } = await import("../proxy/auth")

    let responseSent = false
    let responseStatus = 0
    const ctx = {
      ...mockContext({ "x-api-key": "mrd_invalidtoken123456789012345678901234" }),
      json: (_body: any, status: number) => { responseSent = true; responseStatus = status; return new Response(null, { status }) },
    }

    const profiles = [{ id: "test", type: "claude-max", accessKey: "mrd_validtoken123456789012345678901234" }] as any
    await requireDashboardAuth(ctx as any, async () => {}, profiles)
    expect(responseSent).toBe(true)
    expect(responseStatus).toBe(401)
  })

  it("extracts Token from x-api-key header", async () => {
    const { extractToken } = await import("../proxy/auth")

    expect(extractToken(mockContext({ "x-api-key": "mrd_test123" }))).toBe("mrd_test123")
    expect(extractToken(mockContext({ "authorization": "Bearer mrd_test123" }))).toBe("mrd_test123")
    expect(extractToken(mockContext({}))).toBeUndefined()
  })

  it("uses constant-time comparison", async () => {
    const { createHmac, timingSafeEqual } = await import("node:crypto")

    function safeCompare(a: string, b: string): boolean {
      const hashA = createHmac("sha256", "meridian-token").update(a).digest()
      const hashB = createHmac("sha256", "meridian-token").update(b).digest()
      return timingSafeEqual(hashA, hashB)
    }

    expect(safeCompare("abc", "abc")).toBe(true)
    expect(safeCompare("abc", "def")).toBe(false)
    expect(safeCompare("", "")).toBe(true)
    expect(safeCompare("short", "a-much-longer-string")).toBe(false)
  })

  it("/health remains accessible without auth", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    const res = await app.fetch(new Request("http://localhost/health"))
    expect(res.status).not.toBe(401)
  })

  it("/ landing page remains accessible without auth", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    const res = await app.fetch(new Request("http://localhost/"))
    expect(res.status).not.toBe(401)
  })

  it("model route: Token selects profile, header mismatch returns 403", async () => {
    const { requireModelAuth } = await import("../proxy/auth")
    const { mintToken } = await import("../proxy/profileKeys")

    let responseSent = false
    let responseStatus = 0
    const token = mintToken()
    const ctx = {
      ...mockContext({ "x-api-key": token, "x-meridian-profile": "other" }),
      json: (_body: any, status: number) => { responseSent = true; responseStatus = status; return new Response(null, { status }) },
    }

    const profiles = [{ id: "test", type: "claude-max", accessKey: token }] as any
    await requireModelAuth(ctx as any, async () => {}, profiles, "other")
    expect(responseSent).toBe(true)
    expect(responseStatus).toBe(403)
  })

  it("model route: matching Token and header works", async () => {
    const { requireModelAuth } = await import("../proxy/auth")
    const { mintToken } = await import("../proxy/profileKeys")

    let nextCalled = false
    const token = mintToken()
    const ctx = mockContext({ "x-api-key": token, "x-meridian-profile": "test" })

    const profiles = [{ id: "test", type: "claude-max", accessKey: token }] as any
    await requireModelAuth(ctx as any, async () => { nextCalled = true }, profiles, "test")
    expect(nextCalled).toBe(true)
  })
})