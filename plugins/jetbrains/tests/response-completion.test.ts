import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { observeResponseCompletion } from "../src/response-completion.ts"

test("normal EOF refreshes once and preserves the response", async () => {
  let calls = 0
  const response = observeResponseCompletion(new Response("streamed reply", {
    status: 201, statusText: "Created", headers: { "Content-Type": "text/event-stream", "X-Fixture": "preserved" },
  }), () => { calls++ })
  expect(calls).toBe(0)
  expect(response.status).toBe(201)
  expect(response.statusText).toBe("Created")
  expect(response.headers.get("X-Fixture")).toBe("preserved")
  expect(await response.text()).toBe("streamed reply")
  expect(calls).toBe(1)
})

test("Effect stopping at a protocol terminal event refreshes before HTTP EOF", async () => {
  let completed = 0
  let cancelled = 0
  let pulls = 0
  const chunks = ["delta", "response.completed"]
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new TextEncoder().encode(chunks[pulls++] ?? "trailing data")) },
    cancel() { cancelled++ },
  }, { highWaterMark: 0 })
  const response = observeResponseCompletion(new Response(source), () => { completed++ })
  await Effect.runPromise(Stream.fromReadableStream({ evaluate: () => response.body!, onError: error => error }).pipe(
    Stream.takeUntil(chunk => new TextDecoder().decode(chunk) === "response.completed"),
    Stream.runDrain,
  ))
  expect(completed).toBe(1)
  expect(cancelled).toBe(1)
})

test("cancellation propagates its reason and does not wait for the balance request", async () => {
  const balance = Promise.withResolvers<void>()
  const reason = new Error("consumer stopped")
  let received: unknown
  let calls = 0
  const source = new ReadableStream<Uint8Array>({ cancel(value) { received = value } })
  const response = observeResponseCompletion(new Response(source), () => { calls++; return balance.promise })
  await response.body!.cancel(reason)
  expect(received).toBe(reason)
  expect(calls).toBe(1)
  balance.resolve()
})

test("failed HTTP responses and absent bodies are unchanged", () => {
  for (const original of [new Response("failed", { status: 429 }), new Response(null, { status: 204 })]) {
    const response = observeResponseCompletion(original, () => { throw new Error("unexpected refresh") })
    expect(response).toBe(original)
  }
})

test("refresh failures do not affect response consumption", async () => {
  for (const refresh of [() => { throw new Error("balance failed") }, async () => { throw new Error("balance failed") }]) {
    const response = observeResponseCompletion(new Response("reply"), refresh)
    expect(await response.text()).toBe("reply")
  }
})

test("transport read errors reach the consumer", async () => {
  const error = new Error("transport failed")
  let calls = 0
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(error) } })
  const response = observeResponseCompletion(new Response(source), () => { calls++ })
  await expect(response.text()).rejects.toThrow("transport failed")
  expect(calls).toBe(0)
})
