import { expect, test } from "bun:test"
import { bundledContextLimits, resolveLimits } from "../src/limits.ts"
import { parseOptions, providerDefinition } from "../src/models.ts"

const id = "gpt-6-luna"
const contexts = new Map([[id, 1_000_000]])

test("uses bundled context, 128000 output, and conservative context fallback", () => {
  expect(resolveLimits(parseOptions({}), id, contexts)).toEqual({ context: 1000000, output: 128000 })
  expect(resolveLimits(parseOptions({}), id, new Map())).toEqual({ context: 200000, output: 128000 })
})

test("per-field precedence is model override, global override, then bundled/default", () => {
  const options = parseOptions({
    contextLimit: 500000, outputLimit: 32000,
    models: { [id]: { limits: { context: 800000 } }, "gpt-6-sol": { limits: { output: 64000 } } },
  })
  expect(resolveLimits(options, id, contexts)).toEqual({ context: 800000, output: 32000 })
  expect(resolveLimits(options, "gpt-6-sol", contexts)).toEqual({ context: 500000, output: 64000 })
  expect(resolveLimits(options, "gpt-6-astra", contexts)).toEqual({ context: 500000, output: 32000 })
  expect(resolveLimits(parseOptions({ models: { [id]: { limits: { output: 64000 } } } }), id, contexts)).toEqual({ context: 1000000, output: 64000 })
})

test("invalid explicit budgets are rejected, including incompatible resolved defaults", () => {
  for (const value of [null, -1, 1.5, Infinity, NaN, "64000"]) {
    expect(() => parseOptions({ contextLimit: value })).toThrow()
    expect(() => parseOptions({ models: { [id]: { limits: { output: value } } } })).toThrow()
  }
  for (const limits of [null, [], 3, { typo: 2 }]) {
    expect(() => parseOptions({ models: { [id]: { limits } } })).toThrow()
  }
  expect(() => parseOptions({ models: { [id]: { limits: { context: 32000, output: 64000 } } } })).toThrow()
  expect(() => resolveLimits(parseOptions({ contextLimit: 64000 }), id, contexts)).toThrow("output limit")
  expect(() => resolveLimits(parseOptions({ models: { [id]: { limits: { context: 64000 } } } }), id, contexts)).toThrow("output limit")
  expect(resolveLimits(parseOptions({ contextLimit: 64000, outputLimit: 8192 }), id, contexts)).toEqual({ context: 64000, output: 8192 })
})

test("snapshot only supplies unique valid OpenAI context limits", () => {
  const entry = { id, provider: "OpenAI", limits: { context: 1000000 } }
  const snapshot = (models: unknown[]) => ({ schemaVersion: 1, models })
  expect(bundledContextLimits(snapshot([entry])).get(id)).toBe(1000000)
  for (const data of [undefined, {}, { schemaVersion: 2, models: [entry] },
    snapshot([entry, entry, entry]), snapshot([{ ...entry, provider: "Anthropic" }]),
    snapshot([{ ...entry, limits: { context: null } }]), snapshot([{ ...entry, limits: { context: -1 } }]),
  ]) expect(bundledContextLimits(data).size).toBe(0)
})

test("per-model limits apply to registration without enabling unknown models", () => {
  const options = parseOptions({ models: { [id]: { limits: { context: 900000, output: 96000 } }, unknown: { limits: { output: 1000 } } } })
  const models = providerDefinition(options, new Map(), contexts).models
  expect(models.find(model => model.id === id)!.limit).toEqual({ context: 900000, output: 96000 })
  expect(models).toHaveLength(13)
  expect(models.some(model => model.id === "unknown")).toBe(false)
})

test("context lookup separates Anthropic definitions from OpenAI definitions", () => {
  const snapshot = { schemaVersion: 1, models: [
    { id: "shared-id", provider: "OpenAI", limits: { context: 400000 } },
    { id: "shared-id", provider: "Anthropic", limits: { context: 1000000 } },
  ] }
  expect(bundledContextLimits(snapshot).get("shared-id")).toBe(400000)
  expect(bundledContextLimits(snapshot, "Anthropic").get("shared-id")).toBe(1000000)
})
