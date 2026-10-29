// Models available in Junie's UI. The pricing snapshot includes older models too.
export const GPT_MODELS = [
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", supportsNone: true },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", supportsNone: true },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", supportsNone: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", supportsNone: false },
  { id: "gpt-6-luna", name: "GPT-6 Luna", supportsNone: true },
  { id: "gpt-6-sol", name: "GPT-6 Sol", supportsNone: true },
  { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", supportsNone: true },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", supportsNone: false },
] as const

export const CLAUDE_MODELS = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", supportsMax: true, summarizedThinking: true, disableParallelTools: false },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", supportsMax: false, summarizedThinking: false, disableParallelTools: true },
  { id: "claude-opus-5", name: "Claude Opus 5", supportsMax: true, summarizedThinking: true, disableParallelTools: false },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", supportsMax: true, summarizedThinking: true, disableParallelTools: false },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", supportsMax: true, summarizedThinking: true, disableParallelTools: false },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", supportsMax: true, summarizedThinking: true, disableParallelTools: false },
] as const

export const MODEL_CATALOG = [
  ...GPT_MODELS.map(model => ({ ...model, provider: "OpenAI", protocol: "openai", output: 128_000 } as const)),
  // Use these output limits if the bundled catalog can't be loaded.
  ...CLAUDE_MODELS.map(model => ({ ...model, provider: "Anthropic", protocol: "anthropic", output: model.id === "claude-haiku-5-5" ? 64_000 : 128_000 } as const)),
] as const

export function catalogModel(id: string) {
  return MODEL_CATALOG.find(model => model.id === id)
}
