import { expect, test } from "bun:test"
import { parseOptions, providerDefinition } from "../src/models.ts"
import { loadPricing, parsePrices, resolvePricing } from "../src/pricing.ts"

const prices = { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }
const entry = {
  id: "gpt-6-luna", provider: "OpenAI",
  pricing: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0.4 },
}
const snapshot = {
  schemaVersion: 1, pricingUnit: "per-million-tokens", junie: { version: "3813.10" }, models: [entry],
}
const resolve = (data: unknown) => resolvePricing(parseOptions({}), entry.id, entry.provider, data)

test("loads per-million Junie prices and leaves model limits unchanged", () => {
  const pricing = resolve(snapshot)
  expect(pricing).toEqual({
    prices: { input: 3, output: 4, cache: { read: 0.3, write: 0.4 } },
    source: "junie", version: "3813.10", error: null,
  })
  const definition = providerDefinition(parseOptions({}), new Map([[entry.id, pricing]]))
  expect(definition.models).toHaveLength(13)
  expect(definition.models[0].limit).toEqual({ context: 200000, output: 128000 })
})

test("model pricing overrides globals, which override the Junie snapshot", () => {
  const options = parseOptions({
    usdPerMillionTokens: prices,
    models: { "gpt-6-luna": { usdPerMillionTokens: { ...prices, input: 9 } }, other: { usdPerMillionTokens: prices } },
  })
  expect(resolvePricing(options, entry.id, entry.provider, snapshot)).toMatchObject({
    source: "model-override", prices: { input: 9 },
  })
  expect(resolvePricing(options, "another", entry.provider, snapshot)).toMatchObject({
    source: "global-override", prices,
  })
  expect(resolvePricing(parseOptions({ models: { other: { usdPerMillionTokens: prices } } }), entry.id, entry.provider, snapshot).source).toBe("junie")
})

test("overrides remain usable without a valid snapshot", () => {
  expect(resolvePricing(parseOptions({ usdPerMillionTokens: prices }), entry.id, entry.provider, undefined).prices).toEqual(prices)
  expect(resolvePricing(parseOptions({ models: { [entry.id]: { usdPerMillionTokens: prices } } }), entry.id, entry.provider, null).prices).toEqual(prices)
})

test("missing, invalid, duplicate and wrong-provider entries leave pricing unavailable", () => {
  for (const data of [
    undefined, {}, { ...snapshot, schemaVersion: 2 }, { ...snapshot, pricingUnit: "per-token" },
    { ...snapshot, models: [] }, { ...snapshot, models: [{ ...entry, provider: "other" }] },
    { ...snapshot, models: [entry, entry] },
    { ...snapshot, models: [{ ...entry, pricing: { ...entry.pricing, input: -1 } }] },
    { ...snapshot, models: [{ ...entry, pricing: { input: 1 } }] },
  ]) {
    const pricing = resolve(data)
    expect(pricing.source).toBeNull()
    expect(pricing.error).toBeString()
    expect(providerDefinition(parseOptions({}), new Map([[entry.id, pricing]])).models.find(model => model.id === entry.id)!.cost).toEqual([])
  }
})

test("validates every override and accepts explicit zero prices", () => {
  for (const input of [-1, NaN, Infinity, "1", null, undefined]) {
    expect(() => parsePrices({ ...prices, input })).toThrow()
    expect(() => parseOptions({ models: { other: { usdPerMillionTokens: { ...prices, input } } } })).toThrow()
  }
  for (const value of [null, [], 2, "prices"]) {
    expect(() => parseOptions({ models: { other: { usdPerMillionTokens: value } } })).toThrow()
  }
  expect(() => parseOptions({ models: { "": { usdPerMillionTokens: prices } } })).toThrow()
  expect(parsePrices({ input: 0, output: 0, cache: { read: 0, write: 0 } }).input).toBe(0)
})

test("bundled Luna pricing includes the Junie release version", async () => {
  const pricing = await loadPricing(parseOptions({}), entry.id, entry.provider)
  expect(pricing.source).toBe("junie")
  expect(pricing.version).toMatch(/^\d+(?:\.\d+)*$/)
  expect(pricing.error).toBeNull()
})
