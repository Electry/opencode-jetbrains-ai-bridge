import { expect, test } from "bun:test"
import { metadataError } from "../src/metadata-error.ts"

test("auth diagnostics report only standard codes and never raw messages or challenges", async () => {
  const result = await metadataError(Response.json({ error: "invalid_token", error_description: "private-token" }, {
    status: 401, headers: { "WWW-Authenticate": 'Bearer realm="private-account", error="invalid_token", error_description="private-secret"' },
  }))
  expect(result).toBe(" (bearer challenge; invalid_token)")
  expect(result).not.toContain("private")
  expect(await metadataError(Response.json({ error: { code: "insufficient_scope" } }, { status: 403 })))
    .toBe(" (no authentication challenge; insufficient_scope)")
})

test("auth diagnostics identify empty or non-JSON responses without exposing contents", async () => {
  expect(await metadataError(new Response(null, { status: 401 })))
    .toBe(" (no authentication challenge; empty response body)")
  expect(await metadataError(new Response("private html", { status: 401 })))
    .toBe(" (no authentication challenge; non-JSON response body)")
  expect(await metadataError(Response.json({ error: "private-token" }, { status: 401 })))
    .toBe(" (no authentication challenge; no standard authentication error code)")
  expect(await metadataError(new Response("private".repeat(1000), { status: 401 })))
    .toBe(" (no authentication challenge; response body exceeds diagnostic limit)")
  expect(await metadataError(new Response(null, { status: 404 }))).toBe("")
})
