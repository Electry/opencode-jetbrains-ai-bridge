// Cache-expiry hints only: decoding JWT claims does not authenticate a token.
export function jwtExpiration(token: string): number | null {
  if (token.length > 65_536 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null
  try {
    const value = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"))
    const exp = value?.exp
    return typeof exp === "number" && Number.isSafeInteger(exp) && exp > 0 && Number.isSafeInteger(exp * 1000) ? exp * 1000 : null
  } catch { return null }
}
