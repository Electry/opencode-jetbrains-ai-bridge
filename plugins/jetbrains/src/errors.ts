export class JetBrainsError extends Error {
  constructor(message: string, readonly needsLogin = false, readonly retryAfter?: number) {
    super(message)
    this.name = "JetBrainsError"
  }
}

export function safeError(error: unknown): string {
  return error instanceof JetBrainsError ? error.message : "JetBrains request failed. Try again later."
}

export function retryAfter(response: Response, now = Date.now()): number {
  const value = response.headers.get("retry-after")
  if (!value) return 60_000
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(15_000, Math.min(delay, 15 * 60_000)) : 60_000
}
