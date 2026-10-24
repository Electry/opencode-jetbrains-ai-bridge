import { expect, test } from "bun:test"
import { GPT_MODELS, parseOptions, providerDefinition } from "../src/models.ts"
import { loadBundledSnapshot, loadPricingByModel } from "../src/pricing.ts"
import { bundledContextLimits } from "../src/limits.ts"
import { GATEWAY } from "../src/constants.ts"
import { prepareRequest } from "../src/gateway.ts"

const expectedIDs = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"]

test("registers the seven supported GPT models with bundled prices", async () => {
  const options = parseOptions({})
  const pricing = await loadPricingByModel(options, GPT_MODELS.map(model => model.id), "OpenAI")
  const definition = providerDefinition(options, pricing, bundledContextLimits(await loadBundledSnapshot()))
  expect(definition.models.filter(model => model.id.startsWith("gpt-")).map(model => String(model.id))).toEqual(expectedIDs)
  for (const model of definition.models.filter(model => model.id.startsWith("gpt-"))) {
    expect(model.name).toBe(GPT_MODELS.find(entry => entry.id === model.id)!.name)
    expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"], temperature: false })
    expect(model.settings).toEqual({ reasoningEffort: "low", textVerbosity: "low" })
    expect(model.limit).toEqual({ context: 1000000, output: 128000 })
    expect(pricing.get(model.id)?.source).toBe("junie")
    expect(model.cost).toHaveLength(1)
    expect(Number(model.cost[0].input)).toBe(pricing.get(model.id)!.prices!.input)
  }
})

test("Astra and 6.1 Sol have five effort choices, other GPT models have six", () => {
  for (const model of providerDefinition(parseOptions({})).models.filter(model => model.id.startsWith("gpt-"))) {
    const efforts = ["low", "medium", "high", "xhigh", "max"]
    if (model.id !== "gpt-6-astra" && model.id !== "gpt-6.1-sol") efforts.unshift("none")
    expect(model.variants.map(variant => String(variant.id))).toEqual(efforts)
    for (const variant of model.variants) expect(variant.settings?.reasoningEffort).toBe(variant.id)
  }
})

test("pricing overrides apply to the selected model", async () => {
  const prices = { input: 99, output: 100, cache: { read: 1, write: 2 } }
  const options = parseOptions({ models: { "gpt-6-sol": { usdPerMillionTokens: prices }, "gpt-3.5-turbo": { usdPerMillionTokens: prices } } })
  const pricing = await loadPricingByModel(options, expectedIDs, "OpenAI")
  const models = providerDefinition(options, pricing).models
  expect(pricing.get("gpt-6-sol")?.source).toBe("model-override")
  expect(Number(models.find(model => model.id === "gpt-6-sol")!.cost[0].input)).toBe(99)
  expect(pricing.get("gpt-6-luna")?.source).toBe("junie")
  expect(models.filter(model => model.id.startsWith("gpt-")).map(model => String(model.id))).toEqual(expectedIDs)
})

test("all configured GPT model IDs and efforts survive gateway request preparation", async () => {
  for (const model of providerDefinition(parseOptions({})).models.filter(model => model.id.startsWith("gpt-"))) {
    for (const variant of model.variants) {
      const request = new Request(`${GATEWAY}/v1/responses`, {
        method: "POST", body: JSON.stringify({ model: model.id, reasoning: { effort: variant.id }, input: [] }),
      })
      const prepared = await prepareRequest(request, { key: "test", access: "fake", label: "test" }, "session", model.id, "primary", 0)
      const body = await prepared.json()
      expect(body.model).toBe(model.id)
      expect(body.reasoning.effort).toBe(variant.id)
      expect(prepared.headers.get("X-LLM-Model")).toBe("openai")
    }
  }
})
