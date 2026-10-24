// Loaded only by the isolated OAuth completion smoke test.
import { Effect } from "effect"
import plugin from "../../src/index.ts"
import { GATEWAY, TOKEN_URL } from "../../src/constants.ts"

export default {
  ...plugin,
  effect: (ctx: Parameters<typeof plugin.effect>[0]) => Effect.gen(function* () {
    const original = globalThis.fetch
    const fixture: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === TOKEN_URL) {
        const fields = new URLSearchParams(String(init?.body))
        if (fields.get("code") !== "offline-good-code") return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({ access_token: "offline-access", refresh_token: "offline-refresh", expires_in: 3600, token_type: "Bearer" })
      }
      if (url.startsWith(GATEWAY)) return Response.json({ active: true, balanceLeft: 100000, balanceUnit: "CREDITS" })
      return original(input, init)
    }, original)
    // TokenClient and BalanceService capture this fetch function at construction.
    globalThis.fetch = fixture
    try { yield* plugin.effect(ctx) } finally { globalThis.fetch = original }
  }),
}
