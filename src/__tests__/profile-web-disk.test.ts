/**
 * Unit tests for the disk profile mutations in src/proxy/profileWeb.ts —
 * the server-side half of `meridian profile add|remove`.
 *
 * All tests point MERIDIAN_CONFIG_DIR at a temp dir (configPath resolves per
 * call, so no production file is touched) and restore the env afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addWebOAuthTokenProfile, addWebProfile, removeWebProfile } from "../proxy/profileWeb"

describe("web profile disk mutations", () => {
  let tempDir: string
  let savedConfigDir: string | undefined
  let savedReadonly: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    savedReadonly = process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    tempDir = mkdtempSync(join(tmpdir(), "meridian-web-disk-"))
    process.env.MERIDIAN_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
    else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    if (savedReadonly === undefined) delete process.env.MERIDIAN_CREDENTIALS_READONLY
    else process.env.MERIDIAN_CREDENTIALS_READONLY = savedReadonly
    rmSync(tempDir, { recursive: true, force: true })
  })

  function readProfiles(): Array<{ id: string; claudeConfigDir?: string; type?: string; oauthToken?: string }> {
    return JSON.parse(readFileSync(join(tempDir, "profiles.json"), "utf-8"))
  }

  it("add creates the entry, the config dir, and a 0600 profiles.json", async () => {
    const { statSync } = await import("node:fs")
    const result = addWebProfile("personal")
    expect(result.ok).toBe(true)
    expect(result.profile).toMatchObject({ id: "personal" })
    const dir = join(tempDir, "profiles", "personal")
    expect(existsSync(dir)).toBe(true)
    expect(readProfiles()).toEqual([{ id: "personal", claudeConfigDir: dir }])
    // Windows has no POSIX mode bits (writeFileSync mode is ignored there),
    // so the 0600 assertion only holds where modes exist.
    if (process.platform !== "win32") {
      expect(statSync(join(tempDir, "profiles.json")).mode & 0o777).toBe(0o600)
    }
  })

  it("add rejects duplicates and invalid ids", () => {
    expect(addWebProfile("personal").ok).toBe(true)
    expect(addWebProfile("personal").ok).toBe(false)
    expect(addWebProfile("personal").error).toContain("already exists")
    expect(addWebProfile("../escape").ok).toBe(false)
    expect(addWebProfile("has space").ok).toBe(false)
    expect(addWebProfile("").ok).toBe(false)
  })

  it("add reclaims an alias of the same name", () => {
    writeFileSync(
      join(tempDir, "profiles.json"),
      JSON.stringify([{ id: "work", claudeConfigDir: join(tempDir, "profiles", "work"), aliases: ["personal"] }]),
    )
    expect(addWebProfile("personal").ok).toBe(true)
    expect(readProfiles()).toEqual([
      { id: "work", claudeConfigDir: join(tempDir, "profiles", "work") },
      { id: "personal", claudeConfigDir: join(tempDir, "profiles", "personal") },
    ])
  })

  it("oauth-token add stores the token without echoing it back", () => {
    const result = addWebOAuthTokenProfile("ci", "sk-ant-oat01-secret")
    expect(result.ok).toBe(true)
    expect(result.profile).toEqual({ id: "ci", type: "oauth-token" })
    expect(readProfiles()).toEqual([{ id: "ci", type: "oauth-token", oauthToken: "sk-ant-oat01-secret" }])
    expect(addWebOAuthTokenProfile("empty", "   ").ok).toBe(false)
  })

  it("remove drops the entry and deletes the profile dir", () => {
    addWebProfile("personal")
    const dir = join(tempDir, "profiles", "personal")
    expect(existsSync(dir)).toBe(true)
    const result = removeWebProfile("personal")
    expect(result.ok).toBe(true)
    expect(readProfiles()).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it("remove reports unknown profiles", () => {
    expect(removeWebProfile("ghost").ok).toBe(false)
    expect(removeWebProfile("ghost").error).toContain("not found")
  })

  it("remove never touches a config dir outside the profiles directory", () => {
    const shared = join(tempDir, "shared-claude")
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, "marker.txt"), "shared")
    writeFileSync(
      join(tempDir, "profiles.json"),
      JSON.stringify([{ id: "imported", claudeConfigDir: shared }]),
    )
    expect(removeWebProfile("imported").ok).toBe(true)
    expect(existsSync(join(shared, "marker.txt"))).toBe(true)
  })

  it("mutations refuse under read-only credentials mode", () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    expect(addWebProfile("personal").ok).toBe(false)
    expect(addWebOAuthTokenProfile("ci", "tok").ok).toBe(false)
    expect(removeWebProfile("personal").ok).toBe(false)
    expect(existsSync(join(tempDir, "profiles.json"))).toBe(false)
  })
})
