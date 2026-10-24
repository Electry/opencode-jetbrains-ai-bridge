import { Model, Provider, Integration } from "@opencode/plugin"
import { Schema } from "effect"
import { ANTHROPIC_HEADERS, COMMON_HEADERS, GATEWAY, HEADERS, PROVIDER_ID } from "./constants.ts"
import { parsePrices, type Pricing, type TokenPrices } from "./pricing.ts"
import { parseLimit, parseLimitOverrides, resolveLimits, type LimitOverrides } from "./limits.ts"
import { MODEL_CATALOG } from "./catalog.ts"
export { GPT_MODELS } from "./catalog.ts"

export type Options = {
  models: Record<string, { limits?: LimitOverrides; usdPerMillionTokens?: TokenPrices }>
  contextLimit?: number
  outputLimit?: number
  usdPerMillionTokens?: TokenPrices
}

export function parseOptions(value: Record<string, unknown>): Options {
  for (const key of Object.keys(value)) {
    if (!["models", "contextLimit", "outputLimit", "usdPerMillionTokens"].includes(key)) {
      throw new Error(`Unknown JetBrains option "${key}". Use models for per-model overrides.`)
    }
  }
  const contextLimit = value.contextLimit === undefined ? undefined : parseLimit(value.contextLimit, "context")
  const outputLimit = value.outputLimit === undefined ? undefined : parseLimit(value.outputLimit, "output")
  if (contextLimit !== undefined && outputLimit !== undefined && outputLimit >= contextLimit) {
    throw new Error("JetBrains outputLimit must be below contextLimit.")
  }
  const rawModels = value.models === undefined ? {} : value.models
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) throw new Error("JetBrains models must be an object keyed by model ID.")
  const models = Object.fromEntries(Object.entries(rawModels).map(([id, entry]) => {
    if (!id.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid JetBrains model override.")
    const raw = entry as Record<string, unknown>
    if (Object.keys(raw).some(key => key !== "limits" && key !== "usdPerMillionTokens")) throw new Error("JetBrains model overrides only accept limits and usdPerMillionTokens.")
    return [id, {
      limits: raw.limits === undefined ? undefined : parseLimitOverrides(raw.limits),
      usdPerMillionTokens: raw.usdPerMillionTokens === undefined ? undefined : parsePrices(raw.usdPerMillionTokens),
    }]
  }))
  return {
    models, contextLimit, outputLimit,
    usdPerMillionTokens: value.usdPerMillionTokens === undefined ? undefined : parsePrices(value.usdPerMillionTokens),
  }
}

export function providerDefinition(options: Options, pricing: ReadonlyMap<string, Pricing> = new Map(), contexts: ReadonlyMap<string, number> = new Map(), outputs: ReadonlyMap<string, number> = new Map()) {
  const providerID = Provider.ID.make(PROVIDER_ID)
  const models: Model.Info[] = MODEL_CATALOG.map((entry) => ({
    ...Model.Info.default(providerID, Model.ID.make(entry.id)),
    name: entry.name,
    capabilities: { tools: true, input: ["text"], output: ["text"], temperature: false },
    package: entry.protocol === "anthropic" ? "@opencode/ai/providers/anthropic" : "@opencode/ai/providers/openai-compatible/responses",
    settings: entry.protocol === "anthropic"
      ? { effort: "high", thinking: { type: "adaptive", ...(entry.summarizedThinking ? { display: "summarized" } : {}), block_binding: { prefix_mismatch_behavior: "drop_block" } } }
      : { reasoningEffort: "low", textVerbosity: "low" },
    headers: entry.protocol === "anthropic" ? { ...ANTHROPIC_HEADERS } : { ...HEADERS },
    body: entry.protocol === "anthropic" ? {} : { parallel_tool_calls: true, include: ["reasoning.encrypted_content"], store: false },
    variants: ["none", "low", "medium", "high", "xhigh", "max"]
      .filter(effort => effort !== "none" || (entry.protocol === "openai" && entry.supportsNone))
      .filter(effort => effort !== "max" || entry.protocol === "openai" || entry.supportsMax).map((effort) => ({
      id: Model.VariantID.make(effort), settings: entry.protocol === "anthropic" ? { effort } : { reasoningEffort: effort },
    })),
    limit: resolveLimits(options, entry.id, contexts, outputs.get(entry.id) ?? entry.output),
    cost: pricing.get(entry.id)?.prices ? [Schema.decodeUnknownSync(Model.Cost)(pricing.get(entry.id)!.prices)] : [],
  }))
  return {
    info: {
      ...Provider.Info.empty(providerID),
      integrationID: Integration.ID.make(PROVIDER_ID),
      name: "JetBrains AI",
      activation: "auto" as const,
      package: "@opencode/ai/providers/openai-compatible/responses",
      settings: { baseURL: `${GATEWAY}/v1`, transport: "http" as const, encoding: "none" as const },
      headers: { ...COMMON_HEADERS },
    },
    models,
  }
}
