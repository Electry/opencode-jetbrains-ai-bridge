import { expect, test } from "bun:test"
import { LicenseDiscovery, selectLicense } from "../src/licenses.ts"

const today = "2026-10-25"
const license = { type: "license", licenseId: "fixture-license", aiAccessEnabled: true, validThrough: "2026-11-12" }
const response = (...aiAccessOptions: unknown[]) => ({ aiAccessOptions })

test("selects only one enabled, nonexpired license and drops personal details", () => {
  expect(selectLicense(response({ ...license, type: "LICENSE", licensedTo: "private-name", name: "private-plan", orgId: "private-org" }), today))
    .toEqual({ state: "selected", licenseID: "fixture-license" })
  expect(selectLicense(response({ ...license, validThrough: today }), today).state).toBe("selected")
  expect(selectLicense(response({ ...license, validThrough: null }), today).state).toBe("selected")
  expect(selectLicense(response({ ...license, validThrough: "" }), today).state).toBe("selected")
  expect(selectLicense(response(license, { ...license, licenseId: "disabled", aiAccessEnabled: false }, { ...license, licenseId: "expired", validThrough: "2026-10-24" }), today))
    .toEqual({ state: "selected", licenseID: "fixture-license" })
})

test("selects a single workspace and rejects ambiguous entitlements", () => {
  expect(selectLicense(response(), today)).toEqual({ state: "unavailable", reason: "no-options" })
  expect(selectLicense(response({ ...license, aiAccessEnabled: false }), today)).toEqual({ state: "unavailable", reason: "no-eligible-options" })
  expect(selectLicense(response({ ...license, aiAccessEnabled: undefined }), today).state).toBe("unavailable")
  expect(selectLicense(response({ ...license, validThrough: "2026-10-24" }), today).state).toBe("unavailable")
  expect(selectLicense(response(license, { ...license, licenseId: "second-license" }), today)).toEqual({ state: "unavailable", reason: "multiple-options" })
  const workspace = { type: "workspace", aiAccessEnabled: true, orgId: "private-org", workspaceId: "private-workspace" }
  expect(selectLicense(response(license, workspace), today)).toEqual({ state: "unavailable", reason: "multiple-options" })
  expect(selectLicense(response(workspace), today)).toEqual({ state: "workspace", organizationID: "private-org", workspaceID: "private-workspace" })
})

test("malformed discovery responses fail closed with sanitized errors", () => {
  for (const value of [null, [], {}, response(null), response({ ...license, aiAccessEnabled: "true" }), response({ ...license, licenseId: undefined }), response({ ...license, type: "unknown" }), response({ ...license, validThrough: "2026-02-30" }), response({ ...license, licenseId: "private\nsecret" }), response({ ...license, validThrough: "private-secret" })]) {
    expect(() => selectLicense(value, today)).toThrow("License discovery returned an invalid response.")
  }
  expect(() => selectLicense(response(license), "not-a-date")).toThrow("License discovery requires a valid local date.")
  for (const workspace of [
    { type: "workspace", aiAccessEnabled: true, orgId: "org" },
    { type: "workspace", aiAccessEnabled: true, orgId: "private\norg", workspaceId: "workspace" },
  ]) expect(() => selectLicense(response(workspace), today)).toThrow("License discovery returned an invalid response.")
})

test("discovery uses only a management bearer token on the verified host", async () => {
  let calls = 0
  const client = new LicenseDiscovery(async (url, init) => {
    calls++
    expect(String(url)).toBe("https://api.jetbrains.cloud/user-management/api/ai-access-options")
    expect(init?.method).toBe("GET")
    expect(init?.redirect).toBe("error")
    expect(init?.body).toBeUndefined()
    expect(init?.signal).toBeDefined()
    const headers = new Headers(init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer fixture-management-token")
    expect(headers.has("X-Keep-Path")).toBe(false)
    expect(headers.has("X-LLM-Model")).toBe(false)
    return Response.json(response(license))
  }, () => new Date(2026, 9, 25, 12).getTime())
  expect(await client.get("fixture-management-token")).toEqual({ state: "selected", licenseID: "fixture-license" })
  expect(calls).toBe(1)
})

test("discovery failures never expose tokens, server bodies, or transport errors", async () => {
  for (const fetcher of [async () => new Response("private-secret", { status: 403 }), async () => new Response("private-invalid-json"), async () => { throw new Error("private-transport-secret") }]) {
    const client = new LicenseDiscovery(fetcher)
    try { await client.get("private-management-token"); throw new Error("expected failure") }
    catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain("private")
    }
  }
})
