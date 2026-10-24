import { readFile } from "node:fs/promises"
import type { Options } from "./models.ts"

export type TokenPrices = { input: number; output: number; cache: { read: number; write: number } }
export type Pricing = {
  prices?: TokenPrices
  source: "model-override" | "global-override" | "junie" | null
  version: string | null
  error: string | null
}

export function parsePrices(value: unknown): TokenPrices {
  const price = value as TokenPrices | undefined
  if (!price || [price.input, price.output, price.cache?.read, price.cache?.write]
    .some(x => typeof x !== "number" || !Number.isFinite(x) || x < 0)) {
    throw new Error("JetBrains token prices require finite nonnegative input, output, cache.read, and cache.write values.")
  }
  return { input: price.input, output: price.output, cache: { read: price.cache.read, write: price.cache.write } }
}

export function resolvePricing(options: Options, modelID: string, provider: string, snapshot: unknown): Pricing {
  const override = Object.hasOwn(options.models, modelID) ? options.models[modelID]?.usdPerMillionTokens : undefined
  if (override) return { prices: override, source: "model-override", version: null, error: null }
  if (options.usdPerMillionTokens) return { prices: options.usdPerMillionTokens, source: "global-override", version: null, error: null }
  try {
    const data = snapshot as {
      schemaVersion: number; pricingUnit: string; junie: { version: string }
      models: { id: string; provider: string; pricing: { input: number; output: number; cacheRead: number; cacheWrite: number } }[]
    }
    if (data?.schemaVersion !== 1 || data.pricingUnit !== "per-million-tokens" ||
        typeof data.junie?.version !== "string" || !/^\d+(?:\.\d+)*$/.test(data.junie.version) || !Array.isArray(data.models)) {
      throw new Error("Invalid Junie pricing snapshot.")
    }
    const matches = data.models.filter(model => model?.id === modelID && model.provider === provider)
    if (matches.length !== 1) throw new Error("Missing or ambiguous Junie model pricing.")
    const price = matches[0].pricing
    const prices = parsePrices({ input: price.input, output: price.output, cache: { read: price.cacheRead, write: price.cacheWrite } })
    return { prices, source: "junie", version: data.junie.version, error: null }
  } catch {
    return { source: null, version: null, error: "Couldn't load this model's prices from the Junie snapshot. Check for missing, invalid, or duplicate entries." }
  }
}

export async function loadPricing(options: Options, modelID: string, provider: string): Promise<Pricing> {
  return (await loadPricingByModel(options, [modelID], provider)).get(modelID)!
}

export async function loadPricingByModel(options: Options, modelIDs: readonly string[], provider: string): Promise<Map<string, Pricing>> {
  const snapshot = await loadBundledSnapshot()
  return new Map(modelIDs.map(id => [id, resolvePricing(options, id, provider, snapshot)]))
}

export async function loadBundledSnapshot(): Promise<unknown> {
  let snapshot: unknown
  try {
    snapshot = JSON.parse(await readFile(new URL("../junie-models.json", import.meta.url), "utf8"))
  } catch {
    // Keep running with configured prices or pricing unavailable.
  }
  return snapshot
}
