import { Plugin, Integration } from "@opencode/plugin/effect"
import { Cause, DateTime, Effect, Exit, Stream } from "effect"
import type { ConnectionInfo } from "@opencode/client"
import { browserLogin, manualLogin, TokenClient } from "./auth.ts"
import { BalanceService, type Account } from "./balance.ts"
import { MODEL_ID, PROVIDER_ID } from "./constants.ts"
import { JetBrainsError, safeError } from "./errors.ts"
import { prepareRequest } from "./gateway.ts"
import { parseOptions, providerDefinition } from "./models.ts"
import { MODEL_CATALOG } from "./catalog.ts"
import { loadBundledSnapshot, resolvePricing } from "./pricing.ts"
import { bundledContextLimits, bundledOutputLimits } from "./limits.ts"
import { JetBrains, type StatusSnapshot } from "./rpc.ts"

function authOperation<A>(phase: string, run: () => Promise<A>, record: (stage: string, error: string | null) => Effect.Effect<void, unknown>) {
  return Effect.gen(function* () {
    yield* record(`${phase} started`, null)
    const result = yield* Effect.tryPromise({
      try: run,
      catch: (error) => new JetBrainsError(safeError(error), error instanceof JetBrainsError && error.needsLogin),
    }).pipe(Effect.tapError(error => record(`${phase} failed`, error.message)))
    yield* record(`${phase} completed`, null)
    return result
  })
}

export default Plugin.define({
  id: "local.jetbrains",
  effect: (ctx) => Effect.gen(function* () {
    const options = parseOptions(ctx.options)
    const snapshot = yield* Effect.promise(loadBundledSnapshot)
    const pricing = new Map(MODEL_CATALOG.map(model => [model.id as string, resolvePricing(options, model.id, model.provider, snapshot)]))
    const contexts = new Map(MODEL_CATALOG.flatMap(model => {
      const context = bundledContextLimits(snapshot, model.provider).get(model.id)
      return context === undefined ? [] : [[model.id, context] as const]
    }))
    const outputs = new Map(MODEL_CATALOG.flatMap(model => {
      const output = bundledOutputLimits(snapshot, model.provider).get(model.id)
      return output === undefined ? [] : [[model.id, output] as const]
    }))
    const definition = providerDefinition(options, pricing, contexts, outputs)
    const tokens = new TokenClient()
    const savedAuth = yield* ctx.storage.get("oauth/diagnostic")
    let authStage: string | null = null
    let authError: string | null = null
    if (savedAuth && typeof savedAuth === "object" && !Array.isArray(savedAuth)) {
      authStage = "stage" in savedAuth && typeof savedAuth.stage === "string" ? savedAuth.stage : null
      authError = "error" in savedAuth && typeof savedAuth.error === "string" ? savedAuth.error : null
    }
    const recordAuth = (stage: string, error: string | null) => Effect.gen(function* () {
      authStage = stage
      authError = error
      // Save only fixed stage names and sanitized errors, never OAuth response data.
      yield* ctx.storage.set("oauth/diagnostic", { stage, error }).pipe(Effect.ignore)
    })
    let disposed = false
    yield* Effect.addFinalizer(() => Effect.sync(() => { disposed = true }))

    yield* ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: "manual", type: "oauth", label: "JetBrains login (paste code)" },
        authorize: () => Effect.gen(function* () {
          const attempt = manualLogin(tokens)
          yield* recordAuth("manual login started", null)
          yield* Effect.addFinalizer(() => Effect.sync(attempt.cancel))
          return {
            mode: "code" as const, url: attempt.url, expiresAt: attempt.expiresAt,
            instructions: "Open the URL, sign in to JetBrains, and paste the authorization code shown on the page. Keep the code private.",
            callback: (code: string) => authOperation("code exchange", () => attempt.complete(code), recordAuth),
          }
        }),
        refresh: (credential) => authOperation("refresh", () => tokens.refresh(credential), recordAuth),
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: "browser", type: "oauth", label: "JetBrains login (localhost callback)" },
        authorize: () => Effect.gen(function* () {
          const attempt = yield* Effect.acquireRelease(
            Effect.tryPromise(() => browserLogin(tokens)),
            (attempt) => Effect.sync(attempt.cancel),
          )
          yield* recordAuth("browser login started", null)
          return {
            mode: "auto" as const, url: attempt.url, expiresAt: attempt.expiresAt,
            instructions: "Open the URL on this machine and sign in to JetBrains. The browser will return to OpenCode's localhost listener.",
            callback: authOperation("browser login", () => attempt.result, recordAuth),
          }
        }),
        refresh: (credential) => authOperation("refresh", () => tokens.refresh(credential), recordAuth),
      })
      editor.method.update({ integrationID: PROVIDER_ID, method: { type: "env", names: ["JUNIE_ACCESS_TOKEN"] } })
      editor.update(PROVIDER_ID, (integration) => { integration.name = "JetBrains AI" })
    })

    yield* ctx.provider.transform((editor) => editor.add(definition))

    const identity = (connection: ConnectionInfo) => connection.type === "credential" ? `credential:${connection.id}` : `env:${connection.name}`
    const getAccount = async (): Promise<Account | undefined> => {
      const connection = await Effect.runPromise(ctx.integration.connection.active(PROVIDER_ID))
      if (!connection) return undefined
      const resolved = await Effect.runPromiseExit(ctx.integration.connection.resolve(connection))
      if (Exit.isFailure(resolved)) {
        const error = Cause.squash(resolved.cause)
        if (error instanceof JetBrainsError && error.needsLogin) {
          await Effect.runPromise(ctx.integration.connection.status({
            integrationID: PROVIDER_ID, connection,
            status: { status: "needs_auth", message: safeError(error) },
          }))
        }
        throw new JetBrainsError(safeError(error))
      }
      const credential = resolved.value
      if (!credential) return undefined
      const access = credential.type === "oauth" ? credential.access : credential.type === "key" ? credential.key : undefined
      if (!access) throw new JetBrainsError("No JetBrains access token is available. Connect JetBrains AI first.", true)
      const current = await Effect.runPromise(ctx.integration.connection.active(PROVIDER_ID))
      if (!current || identity(current) !== identity(connection)) throw new JetBrainsError("The active JetBrains account changed. Retry the request.")
      return {
        key: identity(connection), access,
        label: connection.type === "credential" ? connection.label.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100) : "Environment token",
      }
    }
    const balance = new BalanceService(getAccount)
    const status = async (modelID = MODEL_ID, force = false): Promise<StatusSnapshot> => {
      const selected = pricing.get(modelID)
      if (!selected) throw new JetBrainsError("Unknown JetBrains model ID.")
      return {
        ...await balance.get(force), modelID, dollarCost: selected.prices ? "estimated" : "unavailable",
        pricingSource: selected.source, pricingVersion: selected.version, pricingError: selected.error,
        authStage, authError,
      }
    }

    yield* ctx.rpc.register(JetBrains, {
      // RPC has already validated the input schema.
      status: (input) => Effect.promise(() => status((input as { modelID?: string }).modelID)),
      refresh: (input) => Effect.promise(() => status((input as { modelID?: string }).modelID, true)),
    }).pipe(Effect.orDie)

    yield* ctx.session.hook("http.request", (event) => Effect.promise(async () => {
      const account = await getAccount()
      if (!account) throw new JetBrainsError("Connect JetBrains AI with /connect before using this model.", true)
      const session = await Effect.runPromise(ctx.session.get({ sessionID: event.sessionID }))
      event.request = await prepareRequest(event.request, account, event.sessionID, event.model.id, event.kind, DateTime.toEpochMillis(session.time.created))
    }), { providerID: PROVIDER_ID })

    yield* ctx.session.hook("http.response", (event) => Effect.sync(() => {
      // Check credits after OpenCode finishes reading a successful response.
      if (!event.response.ok || !event.response.body) return
      const body = event.response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { controller.enqueue(chunk) },
        flush() { if (!disposed) void balance.get().catch(() => {}) },
      }))
      event.response = new Response(body, {
        status: event.response.status, statusText: event.response.statusText, headers: event.response.headers,
      })
    }), { providerID: PROVIDER_ID })

    yield* ctx.session.hook("retry", (event) => Effect.sync(() => {
      if (event.error.status === 401 || event.error.status === 403 || event.attempt >= 3) {
        event.decision = { retry: false }
      } else if (event.error.status === 429 && event.decision.retry) {
        event.decision = { retry: true, delay: Math.max(event.decision.delay, event.error.retryAfterMs ?? 0, 1000) }
      }
    }), { providerID: PROVIDER_ID })

    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "credential.switched" && event.data.integrationID === PROVIDER_ID),
      Stream.runForEach(() => Effect.promise(async () => { await balance.get() })),
      Effect.forkScoped,
    )
  }),
})
