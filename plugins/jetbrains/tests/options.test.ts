import { expect, test } from "bun:test"
import { parseOptions, providerDefinition } from "../src/models.ts"
import { loadPricingByModel, resolvePricing } from "../src/pricing.ts"
import { resolveLimits } from "../src/limits.ts"

const id = "gpt-6-luna"
const price = { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }

test("model settings take precedence over globals", () => {
  const options = parseOptions({
    contextLimit: 500000, outputLimit: 16000,
    usdPerMillionTokens: { ...price, input: 2 },
    models: { [id]: { limits: { context: 900000 }, usdPerMillionTokens: price } },
  })
  expect(resolveLimits(options, id, new Map())).toEqual({ context: 900000, output: 16000 })
  expect(resolvePricing(options, id, "OpenAI", undefined)).toMatchObject({ source: "model-override", prices: price })
  expect(resolveLimits(options, "gpt-6-sol", new Map())).toEqual({ context: 500000, output: 16000 })
  expect(resolvePricing(options, "gpt-6-sol", "OpenAI", undefined).prices?.input).toBe(2)
})

test("omitted model settings fall back to globals and defaults", () => {
  const options = parseOptions({
    models: { [id]: {} },
    outputLimit: 64000,
    usdPerMillionTokens: price,
  })
  expect(resolveLimits(options, id, new Map([[id, 1000000]]))).toEqual({ context: 1000000, output: 64000 })
  expect(resolvePricing(options, id, "OpenAI", undefined).prices).toEqual(price)
  const defaults = parseOptions({ models: { [id]: { limits: {} } } })
  expect(resolveLimits(defaults, id, new Map([[id, 1000000]]))).toEqual({ context: 1000000, output: 128000 })
})

test("model overrides reach registration and stay scoped to their model", async () => {
  const options = parseOptions({ models: {
    [id]: { limits: { context: 800000, output: 64000 }, usdPerMillionTokens: price },
    unknown: { limits: { output: 1000 }, usdPerMillionTokens: price },
  } })
  const ids = [id, "gpt-6-sol"]
  const pricing = await loadPricingByModel(options, ids, "OpenAI")
  const models = providerDefinition(options, pricing).models
  const luna = models.find(model => model.id === id)!
  expect(luna.limit).toEqual({ context: 800000, output: 64000 })
  expect(Number(luna.cost[0].input)).toBe(1)
  expect(models.find(model => model.id === "gpt-6-sol")!.limit.output).toBe(128000)
  expect(pricing.get("gpt-6-sol")?.source).toBe("junie")
  expect(models).toHaveLength(13)
  expect(models.some(model => model.id === "unknown")).toBe(false)
})

test("rejects invalid model overrides and misspelled fields", () => {
  for (const models of [null, [], 1, "models", { "": {} }, { [id]: null }, { [id]: [] },
    { [id]: { limit: {} } }, { [id]: { limits: null } }, { [id]: { limits: { context: "1000000" } } },
    { [id]: { limits: { context: 32000, output: 64000 } } }, { [id]: { usdPerMillionTokens: null } },
    { [id]: { usdPerMillionTokens: { input: 1 } } }, { [id]: { usdPerMillionTokens: { ...price, input: Infinity } } },
  ]) expect(() => parseOptions({ models })).toThrow()
  const options = parseOptions({ outputLimit: 128000, models: { [id]: { limits: { context: 64000 } } } })
  expect(() => resolveLimits(options, id, new Map())).toThrow("output limit")
})

test("rejects removed per-model maps and unknown global options", () => {
  for (const key of ["limitsByModel", "usdPerMillionTokensByModel", "contextLmit"]) {
    expect(() => parseOptions({ [key]: {} })).toThrow(`Unknown JetBrains option "${key}"`)
  }
})
