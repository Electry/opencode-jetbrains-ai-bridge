import { describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { Integration, type Credential } from "@opencode/plugin"
import { browserLogin, createProof, equalState, loginURL, manualLogin, TokenClient, type Fetch } from "../src/auth.ts"
import { CLIENT_ID, MANUAL_REDIRECT, SCOPES, TOKEN_URL } from "../src/constants.ts"
import { JetBrainsError, safeError } from "../src/errors.ts"

function oldToken(): Credential.OAuth {
  return { type: "oauth", methodID: Integration.MethodID.make("manual"), access: "old-access", refresh: randomUUID(), expires: 1 }
}

describe("OAuth", () => {
  test("generates fresh S256 PKCE and state", () => {
    const proof = createProof()
    expect(proof.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(proof.challenge).toBe(createHash("sha256").update(proof.verifier).digest("base64url"))
    expect(createProof()).not.toEqual(proof)
    expect(equalState(proof.state, proof.state)).toBe(true)
    expect(equalState(null, proof.state)).toBe(false)
    expect(equalState("wrong", proof.state)).toBe(false)
    const url = new URL(loginURL(proof.challenge, proof.state, MANUAL_REDIRECT))
    expect(url.searchParams.get("scope")).toBe(SCOPES)
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(url.searchParams.get("redirect_uri")).toBe(MANUAL_REDIRECT)
    expect(url.searchParams.has("code_verifier")).toBe(false)
  })

  test("exchanges a code with form encoding and millisecond expiry", async () => {
    const fetcher: Fetch = async (input, init) => {
      expect(String(input)).toBe(TOKEN_URL)
      expect(init?.redirect).toBe("error")
      const fields = new URLSearchParams(String(init?.body))
      expect(fields.get("code")).toBe("example-code")
      expect(fields.get("code_verifier")).toBe("example-verifier")
      expect(fields.get("redirect_uri")).toBe(MANUAL_REDIRECT)
      expect(fields.get("client_id")).toBe("junie-cli")
      expect(fields.has("client_secret")).toBe(false)
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer", id_token: "unused-identity" })
    }
    const result = await new TokenClient(fetcher, () => 1000).code("example-code", "example-verifier", MANUAL_REDIRECT, "manual")
    expect(result).toEqual({ type: "oauth", methodID: Integration.MethodID.make("manual"), access: "new-access", refresh: "new-refresh", expires: 3_601_000 })
    expect(JSON.stringify(result)).not.toContain("unused-identity")
  })

  test("preserves an omitted refresh token", async () => {
    const old = oldToken()
    const next = await new TokenClient(async () => Response.json({ access_token: "new", expires_in: 3600 })).refresh(old)
    expect(next.refresh).toBe(old.refresh)
  })

  test("deduplicates refresh across token clients and keeps the rotated result", async () => {
    let calls = 0
    const old = oldToken()
    const fetcher: Fetch = async () => {
      calls++
      await Promise.resolve()
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    }
    const clients = [new TokenClient(fetcher), new TokenClient(fetcher)]
    const results = await Promise.all([clients[0].refresh(old), clients[1].refresh(old)])
    expect(calls).toBe(1)
    expect(results[0]).toEqual(results[1])
    expect((await clients[1].refresh(old)).refresh).toBe("rotated-refresh")
    expect(calls).toBe(1)
  })

  test("failed refresh can be retried and errors contain no response secrets", async () => {
    let calls = 0
    const client = new TokenClient(async () => {
      calls++
      return calls === 1 ? Response.json({ error_description: "secret-must-not-escape" }, { status: 400 })
        : Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 })
    })
    const old = oldToken()
    try { await client.refresh(old); throw new Error("expected failure") } catch (error) {
      expect(safeError(error)).not.toContain("secret-must-not-escape")
      expect(safeError(error)).toContain("sign in again")
    }
    expect((await client.refresh(old)).access).toBe("new")
  })

  test("rejects malformed responses and network error details", async () => {
    await expect(new TokenClient(async () => Response.json({ access_token: "secret", expires_in: 0 })).code("code", "verifier", MANUAL_REDIRECT, "manual")).rejects.toThrow("missing required fields")
    await expect(new TokenClient(async () => { throw new Error("secret-in-transport-error") }).code("code", "verifier", MANUAL_REDIRECT, "manual")).rejects.toThrow("request failed or was cancelled")
  })

  test("token errors include HTTP status and known OAuth codes without response secrets", async () => {
    for (const oauthError of ["invalid_grant", "private-error-value"]) {
      const client = new TokenClient(async () => Response.json({ error: oauthError, error_description: "private-token-details", access_token: "private-access" }, { status: 400 }))
      try { await client.code("example", "verifier", MANUAL_REDIRECT, "manual"); throw new Error("expected failure") } catch (error) {
        const message = safeError(error)
        expect(message).toContain("HTTP 400")
        expect(message).not.toContain("private-")
        if (oauthError === "invalid_grant") expect(message).toContain("invalid_grant")
      }
    }
  })

  test("manual login binds the original verifier and is single use", async () => {
    let verifier = ""
    const client = new TokenClient(async (_input, init) => {
      const form = new URLSearchParams(String(init?.body))
      verifier = form.get("code_verifier")!
      expect(form.get("redirect_uri")).toBe(MANUAL_REDIRECT)
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
    })
    const login = manualLogin(client)
    await login.complete("example-code")
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(new URL(login.url).searchParams.get("code_challenge")!)
    expect(() => login.complete("another-code")).toThrow("expired")
    login.cancel()
  })

  test("manual callback URL requires matching state; cancellation rejects code", () => {
    const login = manualLogin(new TokenClient(async () => { throw new Error("no fetch expected") }))
    expect(() => login.complete(`${MANUAL_REDIRECT}?state=wrong&code=example`)).toThrow("does not match")
    login.cancel()
    expect(() => login.complete("example")).toThrow("expired")
  })

  test("manual login extracts the code from JetBrains base64 JSON", async () => {
    const login = manualLogin(new TokenClient(async (_input, init) => {
      const fields = new URLSearchParams(String(init?.body))
      expect(fields.get("code")).toBe("inner-authorization-code")
      expect(fields.get("redirect_uri")).toBe(MANUAL_REDIRECT)
      expect(fields.has("state")).toBe(false)
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
    }))
    const wrapped = Buffer.from(JSON.stringify({ code: "inner-authorization-code", other: "unused" })).toString("base64")
    try { expect((await login.complete(`  ${wrapped}  `)).access).toBe("access") } finally { login.cancel() }
  })

  test("base64-looking plain codes pass through unchanged", async () => {
    for (const code of ["YWJjZA==", Buffer.from('{"other":"value"}').toString("base64")]) {
      const login = manualLogin(new TokenClient(async (_input, init) => {
        expect(new URLSearchParams(String(init?.body)).get("code")).toBe(code)
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
      }))
      try { await login.complete(code) } finally { login.cancel() }
    }
  })

  test("localhost callback validates state and exchanges the correct redirect", async () => {
    const login = await browserLogin(new TokenClient(async (_input, init) => {
      const fields = new URLSearchParams(String(init?.body))
      expect(fields.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+$/)
      expect(fields.get("code")).toBe("example-code")
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
    }))
    try {
      const auth = new URL(login.url)
      const callback = new URL(auth.searchParams.get("redirect_uri")!)
      callback.hostname = "127.0.0.1"
      callback.search = new URLSearchParams({ state: "wrong", code: "example-code" }).toString()
      expect((await fetch(callback)).status).toBe(400)
      callback.searchParams.set("state", auth.searchParams.get("state")!)
      expect((await fetch(callback)).status).toBe(200)
      expect((await login.result).methodID).toBe(Integration.MethodID.make("browser"))
    } finally { login.cancel() }
  })

  test("localhost login preserves sanitized token errors while keeping the browser response generic", async () => {
    const login = await browserLogin(new TokenClient(async () => Response.json({
      error: "invalid_grant", error_description: "private-token-details", access_token: "private-access",
    }, { status: 400 })))
    try {
      const auth = new URL(login.url)
      const callback = new URL(auth.searchParams.get("redirect_uri")!)
      callback.hostname = "127.0.0.1"
      callback.search = new URLSearchParams({ state: auth.searchParams.get("state")!, code: "example-code" }).toString()
      const response = await fetch(callback)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("Login failed. Start a new login in OpenCode.")
      const error = await login.result.catch(error => error)
      expect(error).toBeInstanceOf(JetBrainsError)
      expect(error.needsLogin).toBe(true)
      expect(safeError(error)).toContain("HTTP 400, invalid_grant")
      expect(safeError(error)).not.toContain("private-")
    } finally { login.cancel() }
  })

  test("localhost cancellation and timeout reject pending login", async () => {
    const client = new TokenClient(async () => { throw new Error("no fetch expected") })
    const cancelled = await browserLogin(client)
    cancelled.cancel()
    await expect(cancelled.result).rejects.toThrow("cancelled")
    const expired = await browserLogin(client, 10)
    await expect(expired.result).rejects.toThrow("timed out")
  })
})
