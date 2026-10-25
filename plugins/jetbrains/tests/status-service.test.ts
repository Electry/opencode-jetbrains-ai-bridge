import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Integration } from "@opencode/plugin"
import { StatusService } from "../src/status-service.ts"
import type { Account } from "../src/account.ts"

function fixture() {
  let now = 1_800_000_000_000
  const expires = now + 2 * 3600_000
  const idToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: expires / 1000 })).toString("base64url")}.signature`
  const account: Account = { key: randomUUID(), label: "Test", access: "inference", oauth: {
    type: "oauth", methodID: Integration.MethodID.make("manual"), access: "inference", refresh: "refresh", expires,
    metadata: { jetbrainsQuota: { error: null, idToken, managementToken: "management", expires,
      workspace: { organizationID: "org", workspaceID: "workspace", token: "scoped", expires } } },
  } }
  const calls = { balance: 0, discovery: 0, quota: 0, updates: 0 }
  let balanceFails = false
  let changed = Promise.withResolvers<void>()
  const service = new StatusService(async () => account, () => { calls.updates++; changed.resolve() }, async url => {
    const path = new URL(String(url)).pathname
    if (path === "/auth/test") {
      calls.balance++
      if (balanceFails) return new Response(null, { status: 429, headers: { "Retry-After": "120" } })
      return Response.json({ active: true, balanceLeft: 123_456, balanceUnit: "CREDITS" })
    }
    if (path.endsWith("/ai-access-options")) {
      calls.discovery++
      return Response.json({ aiAccessOptions: [{ type: "workspace", orgId: "org", workspaceId: "workspace", aiAccessEnabled: true }] })
    }
    calls.quota++
    return Response.json({ current: {} })
  }, () => now)
  return { service, calls, advance: (ms: number) => { now += ms }, failBalance: () => { balanceFails = true },
    changed: () => changed.promise, resetChanged: () => { changed = Promise.withResolvers<void>() } }
}

test("background balance refreshes every five minutes and plan details every hour", async () => {
  const f = fixture()
  await f.service.get()
  await f.changed()
  expect(f.calls).toMatchObject({ balance: 1, discovery: 1, quota: 2 })
  f.advance(5 * 60_000 - 1)
  await f.service.get()
  expect(f.calls.balance).toBe(1)
  f.advance(1)
  await f.service.get()
  expect(f.calls).toMatchObject({ balance: 2, discovery: 1, quota: 2 })
  f.advance(55 * 60_000 - 1)
  await f.service.get()
  expect(f.calls.discovery).toBe(1)
  f.resetChanged()
  f.advance(1)
  await f.service.get()
  await f.changed()
  expect(f.calls).toMatchObject({ discovery: 2, quota: 4 })
})

test("response completion refreshes balance within its background TTL and respects cooldown", async () => {
  const f = fixture()
  await f.service.get()
  await f.changed()
  await f.service.refreshBalance()
  expect(f.calls.balance).toBe(1)
  f.advance(5000)
  await Promise.all([f.service.refreshBalance(), f.service.refreshBalance()])
  expect(f.calls).toMatchObject({ balance: 2, discovery: 1, quota: 2 })
  expect(f.calls.updates).toBeGreaterThan(1)
  await f.service.get()
  expect(f.calls).toMatchObject({ balance: 2, discovery: 1, quota: 2 })
})

test("manual refresh updates both balance and plan details before their TTLs", async () => {
  const f = fixture()
  await f.service.get()
  await f.changed()
  f.advance(5000)
  f.resetChanged()
  await f.service.get(true)
  await f.changed()
  expect(f.calls).toMatchObject({ balance: 2, discovery: 2, quota: 4 })
})

test("response completion respects balance failure backoff", async () => {
  const f = fixture()
  await f.service.get()
  await f.changed()
  f.failBalance()
  f.advance(5000)
  await f.service.refreshBalance()
  expect(f.calls.balance).toBe(2)
  f.advance(119_999)
  await f.service.refreshBalance()
  expect(f.calls.balance).toBe(2)
  f.advance(1)
  await f.service.refreshBalance()
  expect(f.calls).toMatchObject({ balance: 3, discovery: 1, quota: 2 })
})
