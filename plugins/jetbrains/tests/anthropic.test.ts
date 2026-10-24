import { expect, test } from "bun:test"
import { make } from "@opencode/ai/promise"
import { LLM } from "@opencode/ai"
import { Effect } from "effect"
import * as Anthropic from "@opencode/ai/providers/anthropic"
import { AnthropicMessages } from "@opencode/ai/protocols/anthropic-messages"
import { ANTHROPIC_HEADERS, GATEWAY } from "../src/constants.ts"
import { prepareRequest } from "../src/gateway.ts"
import { CLAUDE_MODELS, MODEL_CATALOG } from "../src/catalog.ts"
import { parseOptions, providerDefinition } from "../src/models.ts"
import { bundledContextLimits, bundledOutputLimits } from "../src/limits.ts"
import { loadBundledSnapshot, resolvePricing } from "../src/pricing.ts"

const id = "claude-sonnet-5-5"
const account = { key: "offline", label: "Test", access: "fake-jetbrains-access" }
const sonnet = () => providerDefinition(parseOptions({})).models.find(model => model.id === id)!

test("Sonnet uses Anthropic settings with the shared JetBrains login", async () => {
  const options = parseOptions({})
  const snapshot = await loadBundledSnapshot()
  const pricing = resolvePricing(options, id, "Anthropic", snapshot)
  const definition = providerDefinition(options, new Map([[id, pricing]]), bundledContextLimits(snapshot, "Anthropic"))
  const model = definition.models.find(model => model.id === id)!
  expect(String(definition.info.integrationID)).toBe("jetbrains")
  expect(definition.info.headers).not.toHaveProperty("Openai-Version")
  expect(model.package).toBe("@opencode/ai/providers/anthropic")
  expect(model.limit).toEqual({ context: 1000000, output: 128000 })
  expect(model.settings).toMatchObject({ effort: "high", thinking: { type: "adaptive", display: "summarized" } })
  expect(model.settings).not.toHaveProperty("reasoningEffort")
  expect(model.body).toEqual({})
  expect(model.variants.map(variant => String(variant.id))).toEqual(["low", "medium", "high", "xhigh", "max"])
  for (const variant of model.variants) expect(variant.settings).toEqual({ effort: variant.id })
  expect(pricing.source).toBe("junie")
  expect(Number(model.cost[0].cache.read)).toBe(pricing.prices!.cache.read)
  expect(MODEL_CATALOG).toHaveLength(13)
})

test("Sonnet obeys unified model overrides for limits and prices", async () => {
  const prices = { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }
  const options = parseOptions({ models: { [id]: { limits: { context: 900000, output: 96000 }, usdPerMillionTokens: prices } } })
  const pricing = resolvePricing(options, id, "Anthropic", undefined)
  const model = providerDefinition(options, new Map([[id, pricing]])).models.find(model => model.id === id)!
  expect(model.limit).toEqual({ context: 900000, output: 96000 })
  expect(Number(model.cost[0].input)).toBe(1)
  expect(pricing.source).toBe("model-override")
})

test("Claude models use bundled limits and prices with the Junie effort choices", async () => {
  const options = parseOptions({})
  const snapshot = await loadBundledSnapshot()
  const pricing = new Map(CLAUDE_MODELS.map(model => [model.id, resolvePricing(options, model.id, "Anthropic", snapshot)]))
  const definitions = providerDefinition(options, pricing, bundledContextLimits(snapshot, "Anthropic"), bundledOutputLimits(snapshot, "Anthropic"))
  const models = definitions.models.filter(model => model.id.startsWith("claude-"))
  expect(models.map(model => String(model.id))).toEqual(["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5"])
  for (const definition of models) {
    const haiku = definition.id === "claude-haiku-5-5"
    expect(definition.limit).toEqual({ context: 1000000, output: haiku ? 64000 : 128000 })
    expect(pricing.get(definition.id as typeof CLAUDE_MODELS[number]["id"])?.source).toBe("junie")
    const efforts = ["low", "medium", "high", "xhigh", ...(haiku ? [] : ["max"])]
    expect(definition.variants.map(variant => String(variant.id))).toEqual(efforts)
    for (const variant of definition.variants) {
      const request = LLM.request({
        model: Anthropic.model(definition.id, {}), prompt: "Offline test",
        generation: { maxTokens: definition.limit.output },
        providerOptions: { ...definition.settings, ...variant.settings },
      })
      const body = await Effect.runPromise(AnthropicMessages.protocol.body.from(request))
      expect(body.model).toBe(definition.id)
      expect(body.max_tokens).toBe(haiku ? 64000 : 128000)
      expect(body.output_config?.effort).toBe(variant.id)
      expect(body.thinking?.type).toBe("adaptive")
      if (haiku) expect(body.thinking).not.toHaveProperty("display")
      else expect(body.thinking).toHaveProperty("display", "summarized")
      const prepared = await prepareRequest(new Request(`${GATEWAY}/v1/messages`, { method: "POST", body: JSON.stringify(body) }), account, "s", definition.id, "primary", 0)
      expect(prepared.headers.get("X-LLM-Model")).toBe("anthropic")
      expect((await prepared.json()).output_config.effort).toBe(variant.id)
    }
  }
})

test("output overrides take precedence over bundled limits and fallbacks", () => {
  const outputs = bundledOutputLimits({ schemaVersion: 1, models: [{ id, provider: "Anthropic", limits: { output: 96000 } }] }, "Anthropic")
  expect(providerDefinition(parseOptions({}), new Map(), new Map(), outputs).models.find(model => model.id === id)!.limit.output).toBe(96000)
  const options = parseOptions({ models: { [id]: { limits: { output: 64000 } } } })
  expect(providerDefinition(options, new Map(), new Map(), outputs).models.find(model => model.id === id)!.limit.output).toBe(64000)
})

test("Haiku disables parallel tools only when tools are present, preserving forced/none choices", async () => {
  const model = "claude-haiku-5-5"
  const tools = [{ name: "read_file", input_schema: { type: "object" } }]
  for (const tool_choice of [undefined, { type: "auto" }, { type: "tool", name: "read_file" }, { type: "none" }]) {
    const prepared = await prepareRequest(new Request(`${GATEWAY}/v1/messages`, { method: "POST", body: JSON.stringify({ model, tools, tool_choice }) }), account, "s", model, "primary", 0)
    const body = await prepared.json()
    if (tool_choice?.type === "none") expect(body.tool_choice).toEqual(tool_choice)
    else expect(body.tool_choice).toEqual({ ...(tool_choice ?? { type: "auto" }), disable_parallel_tool_use: true })
  }
  const prepared = await prepareRequest(new Request(`${GATEWAY}/v1/messages`, { method: "POST", body: JSON.stringify({ model, messages: [] }) }), account, "s", model, "primary", 0)
  expect(await prepared.json()).not.toHaveProperty("tool_choice")
})

test("Anthropic gateway preserves native payload, merges betas, strips unrelated API keys and keeps cancellation", async () => {
  const abort = new AbortController()
  const body = { model: id, messages: [], thinking: { type: "adaptive" }, output_config: { effort: "max" }, max_tokens: 50000 }
  const request = new Request(`${GATEWAY}/v1/messages?beta=true`, {
    method: "POST", signal: abort.signal, body: JSON.stringify(body),
    headers: { "x-api-key": "unrelated-secret", "Openai-Version": "wrong", "anthropic-beta": "interleaved-thinking-2025-05-14" },
  })
  const prepared = await prepareRequest(request, account, "session", id, "primary", 0)
  expect(prepared.url).toBe(`${GATEWAY}/v1/messages`)
  expect(prepared.redirect).toBe("error")
  expect(prepared.headers.get("Authorization")).toBe(`Bearer ${account.access}`)
  expect(prepared.headers.has("x-api-key")).toBe(false)
  expect(prepared.headers.has("Openai-Version")).toBe(false)
  expect(prepared.headers.get("X-LLM-Model")).toBe("anthropic")
  expect(prepared.headers.get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14")
  expect(prepared.headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01")
  expect(await prepared.json()).toEqual(body)
  abort.abort()
  expect(prepared.signal.aborted).toBe(true)
})

test("gateway rejects cross-protocol endpoints, extra queries, unknown and mismatched models", async () => {
  for (const [model, url] of [
    [id, `${GATEWAY}/v1/responses`], ["gpt-6-luna", `${GATEWAY}/v1/messages`],
    [id, `${GATEWAY}/v1/messages?beta=true&extra=1`], [id, "https://example.com/v1/messages"],
    ["unknown", `${GATEWAY}/v1/responses`],
  ]) await expect(prepareRequest(new Request(url, { method: "POST", body: JSON.stringify({ model }) }), account, "s", model, "primary", 0)).rejects.toThrow()
  await expect(prepareRequest(new Request(`${GATEWAY}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "gpt-6-luna" }) }), account, "s", id, "primary", 0)).rejects.toThrow("does not match")
})

function fixture(tool: boolean) {
  const events = [
    { type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant", model: id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 } } },
    ...(tool ? [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Read the file." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "offline-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_offline", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"test.txt"}' } },
      { type: "content_block_stop", index: 1 },
    ] : [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 0 },
    ]),
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
    { type: "message_stop" },
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

test("native Anthropic runtime serializes all efforts and round-trips signed thinking, tools and cache usage", async () => {
  const observed: Record<string, any>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const gatewayRequest = new Request(`${GATEWAY}${url.pathname}${url.search}`, request)
      const prepared = await prepareRequest(gatewayRequest, account, "s", id, "primary", 0)
      const body = await prepared.json()
      observed.push(body)
      return new Response(fixture(observed.length === 1), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const ai = make()
  try {
    const definition = sonnet()
    const model = Anthropic.model(id, {
      ...definition.settings, authToken: "offline-only", baseURL: `http://127.0.0.1:${server.port}/v1`, headers: ANTHROPIC_HEADERS,
    })
    const tools = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, cache: { type: "ephemeral" as const } }]
    const response = await ai.llm.generate({
      model, prompt: "Read test.txt", tools, generation: { maxTokens: 50000 },
      system: [{ type: "text", text: "Offline test.", cache: { type: "ephemeral" } }],
    })
    expect(response.reasoning).toBe("Read the file.")
    expect(response.toolCalls[0].input).toEqual({ path: "test.txt" })
    expect(response.usage?.inputTokens).toBe(110)
    expect(response.usage?.cacheReadInputTokens).toBe(80)
    expect(response.usage?.cacheWriteInputTokens).toBe(20)
    expect(response.usage?.outputTokens).toBe(12)
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const followup = await ai.llm.generate({
        model, generation: { maxTokens: 50000 }, providerOptions: { effort }, tools,
        messages: [
          { role: "user", content: "Read test.txt" }, response.message,
          { role: "tool", content: [{ type: "tool-result", id: "tool_offline", name: "read_file", result: { type: "text", value: "file contents" } }] },
        ],
      })
      expect(followup.text).toBe("Done.")
      const body = observed.at(-1)!
      expect(body.output_config.effort).toBe(effort)
      expect(body.messages[1].content[0]).toMatchObject({ type: "thinking", thinking: "Read the file.", signature: "offline-signature" })
      expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tool_offline" })
    }
    expect(observed[0].thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } })
    expect(observed[0].output_config.effort).toBe("high")
    expect(observed[0].system[0].cache_control).toEqual({ type: "ephemeral" })
    expect(observed[0].tools[0].cache_control).toEqual({ type: "ephemeral" })
    for (const body of observed) {
      for (const field of ["store", "prompt_cache_key", "prompt_cache_retention", "parallel_tool_calls", "reasoning", "include"]) expect(body).not.toHaveProperty(field)
    }
  } finally {
    await ai.dispose()
    await server.stop(true)
  }
})
