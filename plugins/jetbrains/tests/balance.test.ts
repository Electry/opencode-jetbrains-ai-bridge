import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { BalanceService } from "../src/balance.ts"

function account() { return { key: randomUUID(), label: "Test account", access: "private-test-access" } }
const success = () => Response.json({ active: true, balanceLeft: 12_345_000, balanceUnit: "CREDITS", licenseType: "AIP", meta: null })

test("returns disconnected without fetching", async () => {
  const service = new BalanceService(async () => undefined, async () => { throw new Error("unexpected fetch") })
  expect((await service.get()).state).toBe("disconnected")
})

test("deduplicates credits requests across service instances and redacts extra fields", async () => {
  const user = account()
  let calls = 0
  const fetcher = async (url: string | URL | Request) => {
    if (!String(url).endsWith("/auth/test")) return new Response(null, { status: 400 })
    calls++; await Promise.resolve(); return success()
  }
  const a = new BalanceService(async () => user, fetcher)
  const b = new BalanceService(async () => user, fetcher)
  const [first, second] = await Promise.all([a.get(), b.get()])
  expect(calls).toBe(1)
  expect(first).toEqual(second)
  expect(first.balance).toBe(123.45)
  expect(first.rawBalance).toBe(12_345_000)
  expect(JSON.stringify(first)).not.toContain(user.access)
  expect(JSON.stringify(first)).not.toContain(user.key)
  await a.get(true)
  expect(calls).toBe(1)
})

test("rate-limit backoff retains a stale balance and cannot be bypassed by refresh", async () => {
  const user = account()
  let time = 100_000
  let calls = 0
  const service = new BalanceService(async () => user, async (url) => {
    if (!String(url).endsWith("/auth/test")) return new Response(null, { status: 400 })
    calls++
    return calls === 1 ? success() : new Response("private-error-details", { status: 429, headers: { "Retry-After": "120" } })
  }, () => time)
  await service.get()
  time += 5 * 60_000 + 1
  const stale = await service.get()
  expect(stale.state).toBe("stale")
  expect(stale.balance).toBe(123.45)
  expect(stale.error).toBe("Credit service returned HTTP 429.")
  time += 5000
  await service.get(true)
  expect(calls).toBe(2)
  time += 120_000
  await service.get()
  expect(calls).toBe(3)
})

test("account switching and logout never reuse another account's balance", async () => {
  let user: ReturnType<typeof account> | undefined = account()
  let calls = 0
  const service = new BalanceService(async () => user, async (url) => {
    if (!String(url).endsWith("/auth/test")) return new Response(null, { status: 400 })
    calls++; return success()
  })
  await service.get()
  user = account()
  await service.get()
  expect(calls).toBe(2)
  user = undefined
  expect((await service.get()).balance).toBeNull()
})

test("USD and unknown units are not scaled", async () => {
  for (const unit of ["USD", "UNKNOWN_UNIT"]) {
    const service = new BalanceService(async () => account(), async () => Response.json({ active: true, balanceLeft: 123.45, balanceUnit: unit }))
    const result = await service.get()
    expect(result.balance).toBe(123.45)
    expect(result.rawBalance).toBe(123.45)
    expect(result.unit).toBe(unit)
  }
})

test("invalid responses and transport errors never expose raw data", async () => {
  const user = account()
  const broken = new BalanceService(async () => user, async () => { throw new Error("private-secret") })
  const result = await broken.get()
  expect(result.state).toBe("error")
  expect(result.error).not.toContain("private-secret")
  const invalid = new BalanceService(async () => account(), async () => Response.json({ active: true, balanceLeft: "private-secret" }))
  expect((await invalid.get()).error).toBe("Credit service returned an invalid response.")
})

test("trial balance reporting never makes optional metadata requests", async () => {
  const calls: string[] = []
  const user = account()
  const service = new BalanceService(async () => user, async url => {
    calls.push(String(url))
    return Response.json({ active: true, balanceLeft: 5, balanceUnit: "USD", licenseType: "TRIAL" })
  })
  expect(await service.get()).toMatchObject({ state: "ready", balance: 5, unit: "USD", license: "TRIAL", error: null })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEndWith("/auth/test")
})
