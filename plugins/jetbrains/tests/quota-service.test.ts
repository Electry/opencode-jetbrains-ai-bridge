import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Integration } from "@opencode/plugin"
import { TokenClient, type Fetch } from "../src/auth.ts"
import type { Account } from "../src/account.ts"
import { StatusService } from "../src/status-service.ts"
import { QuotaService } from "../src/quota-service.ts"
import { readQuotaAuth } from "../src/quota-auth.ts"

const now = new Date(2026, 9, 25, 12).getTime()
const jwt = (kind: string) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, kind })).toString("base64url")}.signature`
const license = { type: "license", licenseId: "private-license-id", aiAccessEnabled: true, validThrough: "2027-01-01" }

test("login through balance display uses distinct tokens on the correct hosts and never exposes quota secrets", async () => {
  const source = jwt("id")
  const grazie = jwt("grazie")
  const calls: string[] = []
  const fetcher: Fetch = async (url, init) => {
    const target = new URL(String(url))
    const headers = new Headers(init?.headers)
    calls.push(target.host + target.pathname)
    expect(init?.redirect).toBe("error")
    if (target.host === "oauth.account.jetbrains.com") {
      const grant = new URLSearchParams(String(init?.body)).get("grant_type")
      return Response.json(grant === "switch_audience"
        ? { access_token: "private-management-token", refresh_token: "private-audience-refresh", expires_in: 3600 }
        : { access_token: "inference-access", refresh_token: "private-normal-refresh", id_token: source, expires_in: 3600 })
    }
    if (target.host === "api.jetbrains.cloud") {
      expect(headers.get("Authorization")).toBe("Bearer private-management-token")
      return Response.json({ aiAccessOptions: [license] })
    }
    if (target.pathname === "/auth/jetbrains-jwt/provide-access/license/v2") {
      expect(target.host).toBe("api.jetbrains.ai")
      expect(headers.get("Authorization")).toBe(`Bearer ${source}`)
      expect(JSON.parse(String(init?.body))).toEqual({ licenseId: license.licenseId })
      return Response.json({ token: grazie })
    }
    if (target.pathname === "/auth/test") {
      expect(target.host).toBe("ingrazzio-cloud-prod.labs.jb.gg")
      expect(headers.get("Authorization")).toBe("Bearer inference-access")
      return Response.json({ active: true, balanceLeft: 6_440_000.123456, balanceUnit: "CREDITS", licenseType: "AIP" })
    }
    expect(target.host).toBe("api.jetbrains.ai")
    expect(headers.has("Authorization")).toBe(false)
    expect(headers.get("Grazie-Authenticate-JWT")).toBe(grazie)
    return Response.json(target.pathname.endsWith("/refill")
      ? { current: { next: now + 86_400_000, tariff: { amount: { amount: "7000000" }, period: { millis: 2_592_000_000 } } } }
      : { current: { tariffQuota: { available: "6440000", maximum: "7000000" }, topUpQuota: { available: "500000", maximum: "1000000" } } })
  }
  const oauth = await new TokenClient(fetcher, () => now).code("fixture-code", "proof", "https://fixture.invalid", "manual")
  const account: Account = { key: randomUUID(), label: "Test", access: oauth.access, oauth }
  expect(oauth.refresh).toBe("private-audience-refresh")
  const changed = Promise.withResolvers<void>()
  const balance = new StatusService(async () => account, () => changed.resolve(), fetcher, () => now)
  await balance.get()
  await changed.promise
  const result = await balance.get()
  expect(result).toMatchObject({ state: "ready", balance: 6_440_000.123456 / 100_000, subscriptionBalance: 64.4, topUpBalance: 5, refillAmount: 70, refillPeriodMs: 2_592_000_000, nextRefill: now + 86_400_000, quotaError: null })
  const serialized = JSON.stringify(result)
  for (const secret of [source, grazie, "private-management-token", "private-audience-refresh", license.licenseId]) expect(serialized).not.toContain(secret)
  await balance.get(true)
  expect(calls.length).toBe(8)
})

test("ambiguous or disabled entitlements stop before token exchange", async () => {
  for (const options of [[license, { ...license, licenseId: "second-private-license" }], [{ ...license, aiAccessEnabled: false }]]) {
    let calls = 0
    const quota = new QuotaService(async url => {
      calls++
      expect(new URL(String(url)).host).toBe("api.jetbrains.cloud")
      return Response.json({ aiAccessOptions: options })
    }, () => now)
    const account: Account = { key: randomUUID(), label: "Test", access: "access", oauth: {
      type: "oauth", methodID: Integration.MethodID.make("manual"), access: "access", refresh: "refresh", expires: now + 3_600_000,
      metadata: { jetbrainsQuota: { idToken: jwt("id"), managementToken: "management", expires: now + 3_600_000, error: null } },
    } }
    const result = await quota.get(account)
    expect(result.quotaError).toBeTruthy()
    expect(result.quotaError).not.toContain("private-license")
    expect(result.nextRefill).toBeNull()
    expect(calls).toBe(1)
  }
})

test("legacy, environment, failed and expired credentials degrade without network requests", async () => {
  const quota = new QuotaService(async () => { throw new Error("must not fetch") }, () => now)
  const account: Account = { key: randomUUID(), label: "Test", access: "access" }
  expect((await quota.get(account)).quotaError).toContain("saved OAuth login")
  account.oauth = { type: "oauth", methodID: Integration.MethodID.make("manual"), access: "access", refresh: "refresh", expires: now + 3600_000 }
  expect((await quota.get(account)).quotaError).toContain("next OAuth refresh")
  account.oauth = { ...account.oauth, metadata: { jetbrainsQuota: { error: "Quota audience exchange returned HTTP 403." } } }
  expect((await quota.get(account)).quotaError).toContain("HTTP 403")
  account.oauth = { ...account.oauth, metadata: { jetbrainsQuota: { error: null, idToken: jwt("id"), managementToken: "management", expires: now - 1 } } }
  expect((await quota.get(account)).quotaError).toContain("expired")
  account.oauth = { ...account.oauth, metadata: { jetbrainsQuota: { error: [] } } }
  expect(readQuotaAuth(account.oauth)).toBeUndefined()
})
