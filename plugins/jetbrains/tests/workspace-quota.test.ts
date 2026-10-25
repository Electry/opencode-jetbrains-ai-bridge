import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Integration, type Credential } from "@opencode/plugin"
import { TokenClient, type Fetch } from "../src/auth.ts"
import type { Account } from "../src/account.ts"
import { StatusService } from "../src/status-service.ts"
import { readQuotaAuth } from "../src/quota-auth.ts"
import { QuotaService } from "../src/quota-service.ts"
import { WorkspaceQuotaClient } from "../src/workspace-quota.ts"
import { readQuota } from "../src/quota.ts"

const now = new Date(2026, 9, 25, 12).getTime()
const jwt = (kind: string) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, kind })).toString("base64url")}.fixture-signature`
const workspace = { type: "workspace", orgId: "private-org", workspaceId: "private-workspace", aiAccessEnabled: true }
const old = (): Credential.OAuth => ({ type: "oauth", methodID: Integration.MethodID.make("manual"), access: "old-access", refresh: randomUUID(), expires: now - 1 })

test("managed refresh acquires workspace credentials and balance reads use the workspace GET quota API", async () => {
  const source = jwt("id")
  const membership = jwt("private-membership")
  const audiences: string[] = []
  let latestRefresh = "normal-refresh"
  let quotaRequests = 0
  const fetcher: Fetch = async (url, init) => {
    const target = new URL(String(url))
    const headers = new Headers(init?.headers)
    expect(init?.redirect).toBe("error")
    if (target.host === "oauth.account.jetbrains.com") {
      const form = new URLSearchParams(String(init?.body))
      if (form.get("grant_type") === "refresh_token") return Response.json({ access_token: "inference-access", id_token: source, refresh_token: latestRefresh, expires_in: 3600 })
      expect(form.get("refresh_token")).toBe(latestRefresh)
      const audience = form.get("audience")!
      audiences.push(audience)
      if (audience === "ai-access") {
        expect(form.get("org_id")).toBe(workspace.orgId)
        expect(form.get("workspace_id")).toBe(workspace.workspaceId)
        expect(form.get("orgs_user_info")).toBe(membership)
      } else {
        expect(form.has("org_id")).toBe(false)
        expect(form.has("workspace_id")).toBe(false)
      }
      latestRefresh = `private-rotated-${audiences.length}`
      return Response.json({ access_token: `${audience}-token`, refresh_token: latestRefresh, expires_in: 3600 })
    }
    if (target.pathname.endsWith("/ai-access-options")) {
      expect(headers.get("Authorization")).toBe("Bearer jcp-user-management-token")
      return Response.json({ aiAccessOptions: [workspace] })
    }
    if (target.pathname === "/org/orgsuserinfo") {
      expect(target.host).toBe("api.jetbrains.cloud")
      expect(headers.get("Authorization")).toBe("Bearer org-service-token")
      return Response.json({ jwt: membership })
    }
    if (target.pathname === "/auth/test") {
      expect(headers.get("Authorization")).toBe("Bearer inference-access")
      return Response.json({ active: true, balanceLeft: 6_440_000, balanceUnit: "CREDITS", licenseType: "AIP" })
    }
    expect(target.host).toBe("api.jetbrains.ai")
    expect(target.pathname.startsWith("/quota/api/quota/")).toBe(true)
    expect(headers.get("Authorization")).toBe("Bearer ai-access-token")
    expect(headers.has("Grazie-Authenticate-JWT")).toBe(false)
    expect(headers.has("X-Keep-Path")).toBe(false)
    expect(headers.has("X-LLM-Model")).toBe(false)
    expect(init?.method).toBe("GET")
    expect(init?.body).toBeUndefined()
    quotaRequests++
    return Response.json(target.pathname.endsWith("/refill")
      ? { current: { next: now + 86_400_000, tariff: { amount: "7000000.0", period: 2_592_000_000 } } }
      : { current: { tariffQuota: { available: "6440000", maximum: "7000000" } } })
  }
  const oauth = await new TokenClient(fetcher, () => now).refresh(old())
  expect(oauth.access).toBe("inference-access")
  expect(oauth.refresh).toBe(latestRefresh)
  expect(audiences).toEqual(["jcp-user-management", "org-service", "ai-access"])
  expect(readQuotaAuth(oauth)?.error).toBeNull()
  expect(readQuotaAuth(oauth)?.workspace).toMatchObject({ organizationID: workspace.orgId, workspaceID: workspace.workspaceId, token: "ai-access-token" })
  const account: Account = { key: randomUUID(), label: "Test", access: oauth.access, oauth }
  const changed = Promise.withResolvers<void>()
  const status = new StatusService(async () => account, () => changed.resolve(), fetcher, () => now)
  await status.get()
  await changed.promise
  const result = await status.get()
  expect(result).toMatchObject({ balance: 64.4, quotaError: null, refillAmount: 70, refillPeriodMs: 2_592_000_000, nextRefill: now + 86_400_000, subscriptionBalance: 64.4 })
  expect(quotaRequests).toBe(2)
  expect(audiences.length).toBe(3)
  for (const value of [JSON.stringify(result)]) {
    for (const secret of [workspace.orgId, workspace.workspaceId, membership, source, latestRefresh, "ai-access-token"]) expect(value).not.toContain(secret)
  }
})

test("workspace mint retries rejected membership once and carries refresh rotation into failure results", async () => {
  for (const alwaysReject of [false, true]) {
    let memberships = 0
    let scopedMints = 0
    let latest = "refresh-initial"
    const client = new TokenClient(async (url, init) => {
      const target = new URL(String(url))
      if (target.pathname.endsWith("/ai-access-options")) return Response.json({ aiAccessOptions: [workspace] })
      if (target.pathname === "/org/orgsuserinfo") return new Response(jwt(`membership-${++memberships}`))
      const form = new URLSearchParams(String(init?.body))
      if (form.get("grant_type") === "refresh_token") return Response.json({ access_token: "inference", refresh_token: latest, id_token: jwt("id"), expires_in: 3600 })
      expect(form.get("refresh_token")).toBe(latest)
      if (form.get("audience") === "ai-access") {
        scopedMints++
        if (alwaysReject || scopedMints === 1) return Response.json({ error: { code: "invalid_orgs_user_info" }, error_description: "private-detail" }, { status: 400 })
      }
      latest = `rotated-${form.get("audience")}`
      return Response.json({ access_token: "token", refresh_token: latest, expires_in: 3600 })
    }, () => now)
    const oauth = await client.refresh(old())
    expect(oauth.access).toBe("inference")
    expect(oauth.refresh).toBe(latest)
    expect(scopedMints).toBe(2)
    expect(memberships).toBe(2)
    expect(JSON.stringify(oauth)).not.toContain("private-detail")
    if (alwaysReject) {
      expect(readQuotaAuth(oauth)?.workspace).toBeUndefined()
      expect(readQuotaAuth(oauth)?.error).toContain("invalid_orgs_user_info")
    } else expect(readQuotaAuth(oauth)?.error).toBeNull()
  }
})

test("workspace identity mismatches, missing and expired tokens never make quota or OAuth requests", async () => {
  for (const saved of [undefined, { organizationID: "other-org", workspaceID: workspace.workspaceId, token: "token", expires: now + 3600_000 }, { organizationID: workspace.orgId, workspaceID: workspace.workspaceId, token: "token", expires: now - 1 }]) {
    let calls = 0
    const service = new QuotaService(async url => {
      calls++
      expect(new URL(String(url)).pathname).toContain("/ai-access-options")
      return Response.json({ aiAccessOptions: [workspace] })
    }, () => now)
    const oauth = { ...old(), metadata: { jetbrainsQuota: { error: null, idToken: jwt("id"), managementToken: "management", expires: now + 3600_000, workspace: saved } } }
    const result = await service.get({ key: randomUUID(), label: "Test", access: oauth.access, oauth })
    expect(result.quotaError).toContain("OAuth refresh")
    expect(calls).toBe(1)
  }
})

test("failed workspace setup discards old workspace credentials but preserves final refresh rotation", async () => {
  const prior = { ...old(), metadata: { jetbrainsQuota: { error: null, workspace: { ...workspace, token: "private-stale-workspace-token" } } } }
  const client = new TokenClient(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith("/ai-access-options")) return Response.json({ aiAccessOptions: [workspace] })
    if (path === "/org/orgsuserinfo") return new Response(jwt("membership"))
    const form = new URLSearchParams(String(init?.body))
    if (form.get("grant_type") === "refresh_token") return Response.json({ access_token: "inference", id_token: jwt("id"), expires_in: 3600 })
    if (form.get("audience") === "ai-access") return Response.json({ refresh_token: "private-final-refresh", access_token: 123 })
    return Response.json({ access_token: "token", expires_in: 3600 })
  }, () => now)
  const oauth = await client.refresh(prior)
  expect(oauth.refresh).toBe("private-final-refresh")
  expect(oauth.access).toBe("inference")
  expect(readQuotaAuth(oauth)?.workspace).toBeUndefined()
  expect(readQuotaAuth(oauth)?.error).toContain("Workspace audience exchange")
  expect(JSON.stringify(oauth)).not.toContain("private-stale-workspace-token")
})

test("workspace HTTP and parsing failures remain optional and redact response bodies", async () => {
  const failures = [() => new Response("private", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }), () => new Response("private", { status: 403 }), () => new Response("private-invalid-json"), () => Response.json(null), () => { throw new Error("private-network-error") }]
  for (const failure of failures) {
    let calls = 0
    const client = new WorkspaceQuotaClient(async url => {
      calls++
      return String(url).endsWith("/refill") ? Response.json({ current: { next: now + 86_400_000 } }) : failure()
    })
    const result = await client.get("private-workspace-token")
    expect(result.nextRefill).toBe(now + 86_400_000)
    expect(result.quotaError).toBeTruthy()
    expect(result.quotaError).not.toContain("private")
    expect(calls).toBe(2)
  }
})

test("refill parser accepts IDE primitive and wrapped millisecond periods", () => {
  for (const value of [2_592_000_000, "2592000000", { millis: 2_592_000_000 }, { millis: "2592000000" }]) {
    expect(readQuota({}, { current: { tariff: { amount: "7000000", period: value } } })).toMatchObject({ refillAmount: 70, refillPeriodMs: 2_592_000_000 })
  }
  for (const value of [-1, "NaN", { millis: Infinity }, 1.2]) expect(readQuota({}, { current: { tariff: { period: value } } }).refillPeriodMs).toBeNull()
})
