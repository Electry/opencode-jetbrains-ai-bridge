import type { Options } from "./models.ts"

export type Limits = { context: number; output: number }
export type LimitOverrides = Partial<Limits>

export function parseLimit(value: unknown, kind: keyof Limits): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (kind === "context" ? 8192 : 256)) {
    throw new Error(`JetBrains ${kind} limit must be a safe integer of at least ${kind === "context" ? 8192 : 256} tokens.`)
  }
  return value
}

export function parseLimitOverrides(value: unknown): LimitOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JetBrains per-model limits.")
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => key !== "context" && key !== "output")) throw new Error("JetBrains model limits only accept context and output.")
  const context = raw.context === undefined ? undefined : parseLimit(raw.context, "context")
  const output = raw.output === undefined ? undefined : parseLimit(raw.output, "output")
  if (context !== undefined && output !== undefined && output >= context) throw new Error("JetBrains output limit must be below context.")
  return { context, output }
}

export function bundledContextLimits(snapshot: unknown, provider = "OpenAI"): Map<string, number> {
  return bundledLimits(snapshot, provider, "context")
}

export function bundledOutputLimits(snapshot: unknown, provider = "OpenAI"): Map<string, number> {
  return bundledLimits(snapshot, provider, "output")
}

function bundledLimits(snapshot: unknown, provider: string, kind: keyof Limits): Map<string, number> {
  const result = new Map<string, number>()
  const data = snapshot as { schemaVersion?: number; models?: { id: string; provider: string; limits?: Partial<Limits> }[] }
  if (data?.schemaVersion !== 1 || !Array.isArray(data.models)) return result
  const seen = new Set<string>()
  for (const model of data.models) {
    if (model?.provider !== provider || typeof model.id !== "string") continue
    if (seen.has(model.id)) { result.delete(model.id); continue }
    seen.add(model.id)
    try { result.set(model.id, parseLimit(model.limits?.[kind], kind)) } catch { /* Use the fallback. */ }
  }
  return result
}

export function resolveLimits(options: Options, modelID: string, contexts: ReadonlyMap<string, number>, defaultOutput = 128_000): Limits {
  const model = Object.hasOwn(options.models, modelID) ? options.models[modelID]?.limits : undefined
  const context = model?.context ?? options.contextLimit ?? contexts.get(modelID) ?? 200_000
  const output = model?.output ?? options.outputLimit ?? defaultOutput
  if (output >= context) throw new Error(`JetBrains output limit must be below the context limit for ${modelID}. Set models["${modelID}"].limits.output or outputLimit.`)
  return { context, output }
}
