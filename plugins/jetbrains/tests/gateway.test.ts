import { expect, test } from "bun:test"
import { GATEWAY } from "../src/constants.ts"
import { prepareRequest, requestKeys } from "../src/gateway.ts"
import { parseOptions, providerDefinition } from "../src/models.ts"
import { loadPricing, resolvePricing } from "../src/pricing.ts"

const account = { key: "fake-account", label: "Test", access: "offline-test-token" }
const created = Date.UTC(2026, 9, 24, 12, 0, 0)

test("cache/execution identity is stable and scoped to account, model, and request kind", () => {
  const keys = requestKeys("account", "session", "model", "primary", created)
  expect(requestKeys("account", "session", "model", "primary", created)).toEqual(keys)
  expect(keys.execution).toMatch(/^session-261024-120000-[0-9a-f]{4}$/)
  expect(keys.cache.length).toBeLessThanOrEqual(64)
  for (const args of [
    ["other", "session", "model", "primary"],
    ["account", "other", "model", "primary"],
    ["account", "session", "other", "primary"],
    ["account", "session", "model", "title"],
  ]) expect(requestKeys(args[0], args[1], args[2], args[3], created).cache).not.toBe(keys.cache)
})

test("adds gateway fields while preserving OpenCode's request and cancellation", async () => {
  const abort = new AbortController()
  const request = new Request(`${GATEWAY}/v1/responses`, {
    method: "POST", signal: abort.signal,
    headers: { Authorization: "Bearer stale", "Content-Length": "1" },
    body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "fixture" }], stream: true, tools: [], reasoning: { effort: "low" } }),
  })
  const next = await prepareRequest(request, account, "session", "gpt-6-luna", "primary", created)
  expect(next.headers.get("Authorization")).toBe("Bearer offline-test-token")
  expect(next.headers.get("X-LLM-Model")).toBe("openai")
  expect(next.headers.get("Openai-Version")).toBe("2020-11-07")
  expect(next.headers.has("Content-Length")).toBe(false)
  expect(next.redirect).toBe("error")
  const data = await next.json()
  expect(data.input).toEqual([{ role: "user", content: "fixture" }])
  expect(data.prompt_cache_retention).toBe("24h")
  expect(data.store).toBe(false)
  abort.abort()
  expect(next.signal.aborted).toBe(true)
})

test("refuses unexpected credential destinations before reading the body", async () => {
  for (const url of ["https://example.com/v1/responses", `${GATEWAY}/other`, `${GATEWAY}/v1/responses?redirect=other`]) {
    await expect(prepareRequest(new Request(url, { method: "POST", body: "{}" }), account, "s", "m", "primary", created)).rejects.toThrow("unexpected endpoint")
  }
})

test("provider uses the Responses runtime with bundled Junie estimates", async () => {
  const options = parseOptions({})
  const pricing = await loadPricing(options, "gpt-6-luna", "OpenAI")
  const definition = providerDefinition(options, new Map([["gpt-6-luna", pricing]]))
  const model = definition.models.find(model => model.id === "gpt-6-luna")!
  expect(definition.info.package).toEndWith("openai-compatible/responses")
  expect(String(definition.info.integrationID)).toBe("jetbrains")
  expect(pricing.source).toBe("junie")
  expect(model.cost).toHaveLength(1)
  expect(Number(model.cost[0].input)).toBe(pricing.prices!.input)
  expect(model.capabilities.input).toEqual(["text"])
  expect(JSON.stringify(definition)).not.toContain("offline-test-token")
})

test("optional USD estimates require complete valid prices", () => {
  expect(() => parseOptions({ contextLimit: 1000 })).toThrow()
  expect(() => parseOptions({ usdPerMillionTokens: { input: 1 } })).toThrow()
  expect(() => parseOptions({ usdPerMillionTokens: { input: -1, output: 1, cache: { read: 1, write: 1 } } })).toThrow()
  const options = parseOptions({ usdPerMillionTokens: { input: 1, output: 2, cache: { read: 0.1, write: 1 } } })
  const pricing = new Map([["gpt-6-luna", resolvePricing(options, "gpt-6-luna", "OpenAI", undefined)]])
  expect(Number(providerDefinition(options, pricing).models.find(model => model.id === "gpt-6-luna")!.cost[0].cache.read)).toBe(0.1)
})

test("Luna effort variants reach the request body", async () => {
  const definition = providerDefinition(parseOptions({}))
  const model = definition.models.find(model => model.id === "gpt-6-luna")!
  expect(model.settings?.reasoningEffort).toBe("low")
  expect(model.variants.map(variant => String(variant.id))).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  expect(model.body).not.toHaveProperty("reasoning")
  for (const variant of model.variants) {
    expect(variant.settings?.reasoningEffort).toBe(String(variant.id))
    const request = new Request(`${GATEWAY}/v1/responses`, {
      method: "POST", body: JSON.stringify({ model: "gpt-6-luna", reasoning: { effort: variant.settings!.reasoningEffort } }),
    })
    const prepared = await prepareRequest(request, account, "session", "gpt-6-luna", "primary", created)
    expect((await prepared.json()).reasoning.effort).toBe(String(variant.id))
  }
})
