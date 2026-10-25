import { expect, test } from "bun:test"
import { GrazieQuotaClient, GrazieTokens, type GrazieIdentity } from "../src/grazie.ts"

const start = 1_800_000_000_000
function jwt(expires = start + 3_600_000, extra: Record<string, unknown> = {}) {
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: expires / 1000, ...extra })).toString("base64url")}.fixture-signature`
}
function identity(): GrazieIdentity { return { accountKey: "fixture-account", licenseID: "private-license", idToken: jwt() } }

test("Grazie exchange uses ID-token bearer and license ID, deduplicates and caches", async () => {
  const user = identity()
  const token = jwt(start + 600_000)
  let calls = 0
  const service = new GrazieTokens(async (url, init) => {
    calls++
    expect(String(url)).toBe("https://api.jetbrains.ai/auth/jetbrains-jwt/provide-access/license/v2")
    expect(init?.method).toBe("POST")
    expect(init?.redirect).toBe("error")
    expect(JSON.parse(String(init?.body))).toEqual({ licenseId: user.licenseID })
    const headers = new Headers(init?.headers)
    expect(headers.get("Authorization")).toBe(`Bearer ${user.idToken}`)
    expect(headers.has("X-LLM-Model")).toBe(false)
    expect(headers.has("X-Keep-Path")).toBe(false)
    await Promise.resolve()
    return Response.json({ token, state: "PAID" })
  }, () => start)
  expect(await Promise.all([service.get(user), service.get(user)])).toEqual([token, token])
  expect(await service.get(user)).toBe(token)
  expect(calls).toBe(1)
})

test("cache refreshes before expiry and isolates accounts, licenses and source ID tokens", async () => {
  let time = start
  let calls = 0
  const user = identity()
  const service = new GrazieTokens(async () => { calls++; return Response.json({ token: jwt(time + 120_000, { generation: calls }) }) }, () => time)
  const first = await service.get(user)
  time += 60_000
  expect(await service.get(user)).not.toBe(first)
  await service.get({ ...user, accountKey: "another-account" })
  await service.get({ ...user, licenseID: "another-license" })
  await service.get({ ...user, idToken: jwt(start + 3_600_000, { generation: 2 }) })
  expect(calls).toBe(5)
  service.clearAccount(user.accountKey)
  await service.get(user)
  expect(calls).toBe(6)
})

test("cache never outlives the source ID token, and late rejection does not discard a newer token", async () => {
  let time = start
  let calls = 0
  const user = { ...identity(), idToken: jwt(start + 120_000) }
  const service = new GrazieTokens(async () => Response.json({ token: jwt(start + 3_600_000, { generation: ++calls }) }), () => time)
  const first = await service.get(user)
  service.invalidate(user, first)
  const second = await service.get(user)
  service.invalidate(user, first)
  expect(await service.get(user)).toBe(second)
  expect(calls).toBe(2)
  time += 120_000
  await expect(service.get(user)).rejects.toThrow("unexpired OAuth ID token")
  expect(calls).toBe(2)
})

test("clearing an account during exchange does not restore its pending credentials", async () => {
  const user = identity()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const service = new GrazieTokens(async () => { calls++; await wait; return Response.json({ token: jwt() }) }, () => start)
  const pending = service.get(user)
  service.clearAccount(user.accountKey)
  release()
  await expect(pending).rejects.toThrow("account state changed")
  await service.get(user)
  expect(calls).toBe(2)
})

test("invalid and expired tokens fail safely, without caching or disclosing raw data", async () => {
  for (const body of [{ token: "private-invalid-token" }, { token: jwt(start - 1000) }, null, { token: jwt(start + 1000, { exp: "private-exp" }) }]) {
    let calls = 0
    const service = new GrazieTokens(async () => { calls++; return Response.json(body) }, () => start)
    for (let i = 0; i < 2; i++) {
      try { await service.get(identity()); throw new Error("expected failure") }
      catch (error) { expect((error as Error).message).not.toContain("private") }
    }
    expect(calls).toBe(2)
  }
  const service = new GrazieTokens(async () => { throw new Error("must not fetch") }, () => start)
  await expect(service.get({ ...identity(), idToken: "not-a-jwt" })).rejects.toThrow("unexpired OAuth ID token")
  await expect(service.get({ ...identity(), licenseID: "private\nsecret" })).rejects.toThrow("valid license selection")
})

test("quota client uses Grazie auth, normalizes optional metadata, and retries 401 once", async () => {
  let exchanges = 0
  const tokens = new GrazieTokens(async () => Response.json({ token: jwt(start + 600_000, { generation: ++exchanges }) }), () => start)
  const paths: string[] = []
  let rejected = false
  const client = new GrazieQuotaClient(tokens, async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    const headers = new Headers(init?.headers)
    expect(headers.get("Grazie-Authenticate-JWT")).toBeTruthy()
    expect(headers.has("Authorization")).toBe(false)
    expect(headers.has("X-Keep-Path")).toBe(false)
    expect(init?.method).toBe("POST")
    expect(init?.body).toBe("{}")
    expect(init?.redirect).toBe("error")
    if (path.endsWith("/refill")) return Response.json({ current: { next: start + 86_400_000, tariff: { amount: { amount: "7000000" }, period: { millis: 2_592_000_000 } } } })
    if (!rejected) { rejected = true; return new Response(null, { status: 401 }) }
    return Response.json({ current: { tariffQuota: { available: "6440000", maximum: "7000000" } } })
  })
  expect(await client.get(identity())).toMatchObject({ quotaError: null, subscriptionBalance: 64.4, subscriptionMaximum: 70, refillAmount: 70, refillPeriodMs: 2_592_000_000, nextRefill: start + 86_400_000 })
  expect(exchanges).toBe(2)
  expect(paths.length).toBe(3)
})

test("quota authentication retry is bounded and errors do not expose response secrets", async () => {
  let calls = 0
  let exchanges = 0
  const tokens = new GrazieTokens(async () => Response.json({ token: jwt(start + 600_000, { generation: ++exchanges }) }), () => start)
  const client = new GrazieQuotaClient(tokens, async () => { calls++; return new Response("private-body", { status: 401 }) })
  const result = await client.get(identity())
  expect(calls).toBe(4)
  expect(result.refillAmount).toBeNull()
  expect(result.quotaError).toContain("HTTP 401")
  expect(result.quotaError).not.toContain("private")
  expect(exchanges).toBe(2)
})

test("quota failures preserve independently successful metadata and keep token errors safe", async () => {
  const tokens = new GrazieTokens(async () => Response.json({ token: jwt() }), () => start)
  const client = new GrazieQuotaClient(tokens, async url => String(url).endsWith("/refill")
    ? Response.json({ current: { next: start + 86_400_000 } })
    : new Response("private", { status: 403 }))
  expect(await client.get(identity())).toMatchObject({ nextRefill: start + 86_400_000, subscriptionBalance: null })
  expect((await client.get(identity())).quotaError).toContain("HTTP 403")
  const broken = new GrazieTokens(async () => { throw new Error("private-transport-error") }, () => start)
  const failed = new GrazieQuotaClient(broken, async () => { throw new Error("should not request quota") })
  expect((await failed.get(identity())).quotaError).toBe("Grazie token exchange failed or timed out.")
})
