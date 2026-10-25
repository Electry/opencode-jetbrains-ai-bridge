// Only report standard protocol codes, never arbitrary server text or headers.
const authErrors = new Set(["invalid_token", "expired_token", "insufficient_scope", "invalid_request", "invalid_client", "unauthorized_client", "access_denied"])

export async function metadataError(response: Response): Promise<string> {
  if (response.status !== 401 && response.status !== 403) return ""
  const details: string[] = []
  const challenge = response.headers.get("WWW-Authenticate")
  if (challenge) {
    const scheme = /^(Bearer|Basic)\b/i.exec(challenge)?.[1]?.toLowerCase()
    details.push(scheme ? `${scheme} challenge` : "authentication challenge present")
    const code = /\berror\s*=\s*"([a-z_]+)"/i.exec(challenge)?.[1]
    if (code && authErrors.has(code)) details.push(code)
  } else details.push("no authentication challenge")
  // Bound diagnostic reads, including when the server omits Content-Length.
  const reader = response.body?.getReader()
  if (!reader) return ` (${[...details, "empty response body"].join("; ")})`
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) {
        details.push("response body exceeds diagnostic limit")
        return ` (${details.join("; ")})`
      }
      chunks.push(value)
    }
    if (size === 0) details.push("empty response body")
    else {
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      try {
        const body = JSON.parse(new TextDecoder().decode(bytes))
        const code = typeof body?.error === "string" ? body.error : body?.error?.code ?? body?.code
        if (typeof code === "string" && authErrors.has(code)) {
          if (!details.includes(code)) details.push(code)
        } else details.push("no standard authentication error code")
      } catch { details.push("non-JSON response body") }
    }
  } catch { details.push("response body unreadable") }
  finally { await reader.cancel().catch(() => {}) }
  return ` (${details.join("; ")})`
}
