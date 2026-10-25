import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Integration } from "@opencode/plugin"
import type { Account } from "../src/account.ts"
import { QuotaCache } from "../src/quota-cache.ts"
import { emptyQuota } from "../src/quota.ts"
import type { QuotaResult } from "../src/quota-service.ts"
import { StatusService } from "../src/status-service.ts"

const account = (): Account => ({ key: randomUUID(), label: "Test", access: "private-access" })

test("slow quota enrichment never blocks balance reporting and emits an update on completion", async () => {
  const user = account()
  const management = Promise.withResolvers<Response>()
  const updated = Promise.withResolvers<void>()
  const now = 1_800_000_000_000
  const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString("base64url")}.signature`
  user.oauth = { type: "oauth", methodID: Integration.MethodID.make("manual"), access: user.access, refresh: "private-refresh", expires: now + 3600_000,
    metadata: { jetbrainsQuota: { idToken: jwt, managementToken: "management", expires: now + 3600_000, error: null } } }
  const service = new StatusService(async () => user, () => updated.resolve(), async url => {
    if (String(url).endsWith("/auth/test")) return Response.json({ active: true, balanceLeft: 123_456, balanceUnit: "CREDITS" })
    return management.promise
  }, () => now)
  const first = await service.get()
  expect(first.balance).toBe(1.23456)
  expect(first.quotaState).toBe("loading")
  management.resolve(Response.json({ aiAccessOptions: [] }))
  await updated.promise
  const next = await service.get()
  expect(next.balance).toBe(first.balance)
  expect(next.quotaState).toBe("error")
  expect(next.quotaError).toContain("No AI licenses")
  expect(JSON.stringify(next)).not.toContain("private")
})

test("quota cache deduplicates, applies cooldown and retains same-entitlement metadata on failure", async () => {
  let now = 100_000
  let calls = 0
  let result: QuotaResult = { ...emptyQuota(), identity: "license-a", refillAmount: 70, nextRefill: 1_800_000_000_000 }
  let changed = Promise.withResolvers<void>()
  const source = { get: async () => { calls++; return result } }
  const cache = new QuotaCache(source, () => changed.resolve(), () => now)
  const user = account()
  cache.get(user)
  cache.get(user, true)
  await changed.promise
  expect(calls).toBe(1)
  expect(cache.get(user).refillAmount).toBe(70)
  cache.get(user, true)
  expect(calls).toBe(1)
  now += 5001
  changed = Promise.withResolvers<void>()
  result = { ...emptyQuota(), identity: "license-a", quotaError: "Quota request failed." }
  cache.get(user, true)
  await changed.promise
  expect(cache.get(user)).toMatchObject({ quotaState: "stale", refillAmount: 70, quotaUpdatedAt: 100_000 })
  cache.get(user, true)
  expect(calls).toBe(2)
  now += 60_001
  changed = Promise.withResolvers<void>()
  result = { ...emptyQuota(), identity: "license-b", quotaError: "Quota request failed." }
  cache.get(user)
  await changed.promise
  expect(cache.get(user)).toMatchObject({ quotaState: "error", refillAmount: null, quotaUpdatedAt: null })
})

test("late quota results cannot contaminate a different account or credential", async () => {
  const pending = Promise.withResolvers<QuotaResult>()
  const changed = Promise.withResolvers<void>()
  const cache = new QuotaCache({ get: () => pending.promise }, () => changed.resolve())
  const first = account()
  cache.get(first)
  const second = account()
  expect(cache.get(second).refillAmount).toBeNull()
  pending.resolve({ ...emptyQuota(), refillAmount: 70 })
  await changed.promise
  const renewed = { ...first, access: "renewed-access" }
  expect(cache.get(renewed).refillAmount).toBeNull()
  expect(cache.get(first).refillAmount).toBe(70)
})

test("quota cache sanitizes transport errors, recovers, and ignores throwing event listeners", async () => {
  let now = 100_000
  let fail = true
  let changed = Promise.withResolvers<void>()
  const cache = new QuotaCache({ get: async () => {
    if (fail) throw new Error("private-server-details")
    return { ...emptyQuota(), refillAmount: 70 }
  } }, () => { changed.resolve(); throw new Error("subscriber disposed") }, () => now)
  const user = account()
  cache.get(user)
  await changed.promise
  expect(cache.get(user)).toMatchObject({ quotaState: "error", quotaError: "Plan details request failed. Try again later." })
  fail = false
  now += 60_001
  changed = Promise.withResolvers<void>()
  cache.get(user)
  await changed.promise
  expect(cache.get(user)).toMatchObject({ quotaState: "ready", quotaError: null, refillAmount: 70 })
})

test("shared quota requests notify every observing location without duplicate fetching", async () => {
  const pending = Promise.withResolvers<QuotaResult>()
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  let calls = 0
  const source = { get: () => { calls++; return pending.promise } }
  const user = account()
  const a = new QuotaCache(source, () => first.resolve())
  const b = new QuotaCache(source, () => second.resolve())
  a.get(user)
  b.get(user)
  pending.resolve({ ...emptyQuota(), refillAmount: 70 })
  await Promise.all([first.promise, second.promise])
  expect(calls).toBe(1)
  expect(b.get(user).refillAmount).toBe(70)
})

test("partial quota failures retain independently successful fields", async () => {
  const changed = Promise.withResolvers<void>()
  const cache = new QuotaCache({ get: async () => ({ ...emptyQuota(), identity: "license", subscriptionMaximum: 70, quotaError: "Refill request failed." }) }, () => changed.resolve())
  const user = account()
  cache.get(user)
  await changed.promise
  expect(cache.get(user)).toMatchObject({ quotaState: "stale", subscriptionMaximum: 70, refillAmount: null })
})

test("quota Retry-After survives partial responses and cannot be bypassed by manual refresh", async () => {
  let now = 100_000
  const changed = Promise.withResolvers<void>()
  let calls = 0
  const cache = new QuotaCache({ get: async () => {
    calls++
    return { ...emptyQuota(), subscriptionMaximum: 70, quotaError: "HTTP 429", retryAt: 400_000 }
  } }, () => changed.resolve(), () => now)
  const user = account()
  cache.get(user)
  await changed.promise
  expect(cache.get(user)).toMatchObject({ quotaState: "stale", subscriptionMaximum: 70 })
  expect(cache.get(user)).not.toHaveProperty("retryAt")
  for (now of [105_001, 160_001, 399_999]) {
    cache.get(user, true)
    expect(calls).toBe(1)
  }
  now = 400_000
  cache.get(user)
  expect(calls).toBe(2)
})
