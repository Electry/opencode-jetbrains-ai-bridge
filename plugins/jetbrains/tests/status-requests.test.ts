import { expect, test } from "bun:test"
import { StatusRequests } from "../src/status-requests.ts"

test("manual refresh runs after an in-flight polling read", async () => {
  const requests = new StatusRequests<string>()
  const poll = Promise.withResolvers<string>()
  let refreshes = 0
  const polling = requests.run(false, () => poll.promise)
  const refresh = () => { refreshes++; return Promise.resolve("refreshed") }
  const first = requests.run(true, refresh)
  const second = requests.run(true, refresh)
  expect(first).toBe(second)
  expect(refreshes).toBe(0)
  poll.resolve("cached")
  expect(await polling).toBe("cached")
  expect(await first).toBe("refreshed")
  expect(refreshes).toBe(1)
})

test("polls and refreshes share an in-flight forced request", async () => {
  const requests = new StatusRequests<string>()
  const response = Promise.withResolvers<string>()
  const forced = requests.run(true, () => response.promise)
  const unexpected = async () => { throw new Error("duplicate request") }
  expect(requests.run(false, unexpected)).toBe(forced)
  expect(requests.run(true, unexpected)).toBe(forced)
  response.resolve("fresh")
  expect(await forced).toBe("fresh")
})

test("clearing requests discards queued refreshes and preserves new pending reads", async () => {
  const requests = new StatusRequests<string>()
  const old = Promise.withResolvers<string>()
  requests.run(false, () => old.promise)
  const refresh = requests.run(true, async () => { throw new Error("stale refresh") })
  requests.clear()
  const next = Promise.withResolvers<string>()
  const current = requests.run(false, () => next.promise)
  old.resolve("old")
  expect(await refresh).toBeUndefined()
  expect(requests.pending).toBe(current)
  next.resolve("new")
  expect(await current).toBe("new")
})

test("a failed polling read still allows its queued refresh", async () => {
  const requests = new StatusRequests<string>()
  const poll = requests.run(false, async () => { throw new Error("poll failed") })
  const refreshed = requests.run(true, async () => "fresh")
  await expect(poll).rejects.toThrow("poll failed")
  expect(await refreshed).toBe("fresh")
})

test("a new poll racing a queued refresh does not create a promise cycle", async () => {
  const requests = new StatusRequests<string>()
  const poll = Promise.withResolvers<string>()
  const polling = requests.run(false, () => poll.promise)
  const next = Promise.withResolvers<string>()
  void polling.then(() => requests.run(false, () => next.promise))
  const forced = requests.run(true, async () => "fresh")
  poll.resolve("cached")
  await polling
  next.resolve("new poll")
  expect(await forced).toBe("fresh")
})
