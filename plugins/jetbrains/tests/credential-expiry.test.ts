import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Integration, type Credential } from "@opencode/plugin"
import { TokenClient, type Fetch } from "../src/auth.ts"
import { canRenewQuotaOnly, inferenceExpiry, MIN_QUOTA_REFRESH_INTERVAL, QUOTA_RETRY_INTERVAL, REFRESH_WINDOW, scheduleCredential } from "../src/credential-expiry.ts"
import { readQuotaAuth } from "../src/quota-auth.ts"

const start = 1_800_000_000_000
const jwt = (expires: number) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: expires / 1000 })).toString("base64url")}.fixture-signature`
function credential(): Credential.OAuth {
  return { type: "oauth", methodID: Integration.MethodID.make("manual"), access: "inference-access", refresh: randomUUID(), expires: start + 3600_000 }
}

test("full OAuth refresh retains a valid ID token only when its replacement is omitted", async () => {
  const valid = jwt(start + 3600_000)
  for (const replacement of [undefined, valid, "invalid-replacement", null]) {
    const original = { ...credential(), expires: start + 1000, metadata: { jetbrainsQuota: {
      error: null, idToken: valid, managementToken: "old-management", expires: start + 3600_000,
    } } }
    const grants: string[] = []
    const renewed = await new TokenClient(async (url, init) => {
      if (String(url).endsWith("/ai-access-options")) return Response.json({ aiAccessOptions: [] })
      const fields = new URLSearchParams(String(init?.body))
      const grant = fields.get("grant_type")!
      grants.push(grant)
      if (grant === "refresh_token") return Response.json({ access_token: "new-inference", refresh_token: "rotated",
        expires_in: 3600, ...(replacement === undefined ? {} : { id_token: replacement }) })
      expect(fields.get("refresh_token")).toBe("rotated")
      return Response.json({ access_token: "new-management", expires_in: 3600 })
    }, () => start).refresh(original)
    expect(renewed.access).toBe("new-inference")
    expect(renewed.refresh).toBe("rotated")
    if (replacement === undefined || replacement === valid) {
      expect(readQuotaAuth(renewed)).toMatchObject({ idToken: valid, error: null, managementToken: "new-management" })
      expect(grants).toEqual(["refresh_token", "switch_audience"])
    } else {
      expect(readQuotaAuth(renewed)?.error).toContain("usable ID token")
      expect(grants).toEqual(["refresh_token"])
    }
  }
})

test("full refresh never reuses expired ID tokens", async () => {
  const original = { ...credential(), expires: start + 1000, metadata: { jetbrainsQuota: {
    error: null, idToken: jwt(start), managementToken: "old-management", expires: start + 3600_000,
  } } }
  let calls = 0
  const renewed = await new TokenClient(async () => {
    calls++
    return Response.json({ access_token: "new-inference", expires_in: 3600 })
  }, () => start).refresh(original)
  expect(calls).toBe(1)
  expect(readQuotaAuth(renewed)?.idToken).toBeUndefined()
  expect(readQuotaAuth(renewed)?.error).toContain("usable ID token")
})

test("an omitted ID token defers another full refresh until the retained token expires", async () => {
  for (const managementLifetime of [3600, 60]) {
    let now = start
    const idExpiry = start + 240_000
    const original = { ...credential(), expires: start + 1000, metadata: { jetbrainsQuota: {
      error: null, idToken: jwt(idExpiry), managementToken: "old-management", expires: idExpiry,
    } } }
    let fullRefreshes = 0
    let quotaRefreshes = 0
    const client = new TokenClient(async (url, init) => {
      if (String(url).endsWith("/ai-access-options")) return Response.json({ aiAccessOptions: [] })
      const grant = new URLSearchParams(String(init?.body)).get("grant_type")
      if (grant === "refresh_token") {
        fullRefreshes++
        return Response.json({ access_token: `inference-${fullRefreshes}`, expires_in: 3600 })
      }
      quotaRefreshes++
      return Response.json({ access_token: "management", expires_in: managementLifetime })
    }, () => now)
    let current = await client.refresh(original)
    expect(fullRefreshes).toBe(1)
    expect(current.metadata?.jetbrainsQuota).not.toHaveProperty("diagnostic")
    while (current.expires - REFRESH_WINDOW < idExpiry) {
      now = current.expires - REFRESH_WINDOW
      current = await client.refresh(current)
      expect(fullRefreshes).toBe(1)
      expect(current.access).toBe("inference-1")
    }
    expect(current.expires - REFRESH_WINDOW).toBe(idExpiry)
    expect(quotaRefreshes).toBe(managementLifetime === 60 ? 4 : 1)
    now = idExpiry
    current = await client.refresh(current)
    expect(fullRefreshes).toBe(2)
    expect(current.access).toBe("inference-2")
    expect(readQuotaAuth(current)?.idToken).toBeUndefined()
    expect(current.metadata?.jetbrainsIDTokenRefreshAfter).toBeNull()
  }
})

test("scheduled expiry tracks the earliest required token while retaining real inference expiry", () => {
  const original = { ...credential(), metadata: { custom: "preserved", jetbrainsQuota: {
    error: null, idToken: jwt(start + 3600_000), managementToken: "management", expires: start + 1200_000,
    workspace: { organizationID: "org", workspaceID: "workspace", token: "scoped", expires: start + 900_000 },
  } } }
  const scheduled = scheduleCredential(original, start)
  expect(scheduled.expires).toBe(start + 900_000)
  expect(inferenceExpiry(scheduled)).toBe(start + 3600_000)
  expect(scheduled.access).toBe(original.access)
  expect(scheduled.refresh).toBe(original.refresh)
  expect(scheduled.metadata?.custom).toBe("preserved")
  expect(scheduleCredential(scheduled, start).expires).toBe(scheduled.expires)
  expect(original.expires).toBe(start + 3600_000)
  expect(canRenewQuotaOnly(scheduled, start + 600_000)).toBe(true)
  expect(canRenewQuotaOnly(scheduled, start + 3300_000)).toBe(false)
})

test("short-lived optional tokens do not schedule immediate refresh loops", () => {
  const original = { ...credential(), metadata: { jetbrainsQuota: {
    error: null, idToken: jwt(start + 3600_000), managementToken: "management", expires: start + 120_000,
  } } }
  const scheduled = scheduleCredential(original, start)
  expect(scheduled.expires - REFRESH_WINDOW).toBe(start + MIN_QUOTA_REFRESH_INTERVAL)
  expect(scheduled.expires).toBeLessThan(inferenceExpiry(scheduled))
  const noQuota = scheduleCredential(credential(), start)
  expect(noQuota.expires).toBe(inferenceExpiry(noQuota))
  const failed = scheduleCredential({ ...original, metadata: { jetbrainsQuota: { ...original.metadata.jetbrainsQuota, error: "optional failure", expires: start - 1 } } }, start)
  expect(failed.expires - REFRESH_WINDOW).toBe(start + QUOTA_RETRY_INTERVAL)
})

test("quota renewals deduplicate, preserve inference access, and persist token rotation", async () => {
  let time = start
  let expectedRefresh = "login-refresh"
  const grants: string[] = []
  let rotations = 0
  const fetcher: Fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith("/ai-access-options")) return Response.json({ aiAccessOptions: [{ type: "workspace", orgId: "org", workspaceId: "workspace", aiAccessEnabled: true }] })
    if (path === "/org/orgsuserinfo") return new Response(jwt(time + 3600_000))
    const form = new URLSearchParams(String(init?.body))
    const grant = form.get("grant_type")!
    grants.push(grant)
    if (grant !== "switch_audience") {
      return Response.json({ access_token: `inference-${time}`, refresh_token: expectedRefresh, id_token: jwt(time + 3600_000), expires_in: 3600 })
    }
    expect(form.get("refresh_token")).toBe(expectedRefresh)
    expectedRefresh = `rotated-${++rotations}`
    return Response.json({ access_token: `${form.get("audience")}-${time}`, refresh_token: expectedRefresh, expires_in: 420 })
  }
  const client = new TokenClient(fetcher, () => time)
  const other = new TokenClient(fetcher, () => time)
  let current = await client.code("code", "proof", "https://fixture.invalid", "manual")
  const access = current.access
  expect(current.expires).toBe(start + 420_000)
  time += 120_000
  const [first, duplicate] = await Promise.all([client.refresh(current), other.refresh(current)])
  expect(first).toEqual(duplicate)
  expect(first.access).toBe(access)
  expect(first.refresh).toBe(expectedRefresh)
  expect(inferenceExpiry(first)).toBe(start + 3600_000)
  expect(first.expires).toBe(time + 420_000)
  expect(grants.filter(value => value === "refresh_token")).toHaveLength(0)
  expect(rotations).toBe(6)
  // A second quota renewal is due inside the previous five-minute grace TTL.
  time += 120_000
  current = await client.refresh(first)
  expect(current.expires).toBe(time + 420_000)
  expect(current.access).toBe(access)
  expect(rotations).toBe(9)
  expect(grants.filter(value => value === "refresh_token")).toHaveLength(0)
  time = start + 3300_000
  current = await client.refresh(current)
  expect(grants.filter(value => value === "refresh_token")).toHaveLength(1)
  expect(current.access).not.toBe(access)
  expect(inferenceExpiry(current)).toBe(time + 3600_000)
})

test("quota renewal failures keep inference usable and rotated refresh tokens persisted, with retry backoff", async () => {
  let time = start
  const original = scheduleCredential({ ...credential(), metadata: { jetbrainsQuota: {
    error: null, idToken: jwt(start + 3600_000), managementToken: "old-management", expires: start + 600_000,
  } } }, start)
  let calls = 0
  const client = new TokenClient(async (url, init) => {
    calls++
    if (String(url).includes("/ai-access-options")) return new Response("private", { status: 403 })
    const form = new URLSearchParams(String(init?.body))
    expect(form.get("grant_type")).toBe("switch_audience")
    return Response.json({ access_token: "management", refresh_token: "private-rotation", expires_in: 600 })
  }, () => time)
  time += 300_000
  const renewed = await client.refresh(original)
  expect(renewed.access).toBe(original.access)
  expect(inferenceExpiry(renewed)).toBe(start + 3600_000)
  expect(renewed.refresh).toBe("private-rotation")
  expect(renewed.expires - REFRESH_WINDOW).toBe(time + QUOTA_RETRY_INTERVAL)
  expect(readQuotaAuth(renewed)?.error).toContain("HTTP 403")
  expect(readQuotaAuth(renewed)?.error).not.toContain("private")
  expect(calls).toBe(2)
})

test("an expiring ID token or legacy credentials use normal managed inference refresh", async () => {
  for (const original of [credential(), { ...credential(), metadata: { jetbrainsQuota: { error: null, idToken: jwt(start + 240_000) } } }]) {
    const grants: string[] = []
    const client = new TokenClient(async (url, init) => {
      if (String(url).endsWith("/ai-access-options")) return Response.json({ aiAccessOptions: [] })
      const grant = new URLSearchParams(String(init?.body)).get("grant_type")!
      grants.push(grant)
      return Response.json({ access_token: grant === "refresh_token" ? "fresh-inference" : "management", expires_in: 3600 })
    }, () => start)
    expect(canRenewQuotaOnly(original, start)).toBe(false)
    expect((await client.refresh(original)).access).toBe("fresh-inference")
    expect(grants).toEqual(readQuotaAuth(original)?.idToken ? ["refresh_token", "switch_audience"] : ["refresh_token"])
  }
})

test("nonrotating refresh tokens do not reuse a due quota renewal from the grace cache", async () => {
  let time = start
  let audienceCalls = 0
  const initial = scheduleCredential({ ...credential(), metadata: { jetbrainsQuota: {
    error: null, idToken: jwt(start + 3600_000), managementToken: "initial", expires: start + 420_000,
  } } }, start)
  const client = new TokenClient(async (url, init) => {
    if (String(url).includes("/ai-access-options")) return Response.json({ aiAccessOptions: [{ type: "license", licenseId: "fixture-license", aiAccessEnabled: true }] })
    expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("switch_audience")
    return Response.json({ access_token: `management-${++audienceCalls}`, expires_in: 420 })
  }, () => time)
  time += 120_000
  const first = await client.refresh(initial)
  time += 120_000
  const second = await client.refresh(first)
  expect(second.refresh).toBe(initial.refresh)
  expect(second.access).toBe(initial.access)
  expect(audienceCalls).toBe(2)
  expect(second.expires).toBe(time + 420_000)
})
