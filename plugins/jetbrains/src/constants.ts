export const PROVIDER_ID = "jetbrains"
export const MODEL_ID = "gpt-6-luna"
export const GATEWAY = "https://ingrazzio-cloud-prod.labs.jb.gg"
export const TOKEN_URL = "https://oauth.account.jetbrains.com/oauth2/token"
export const LOGIN_URL = "https://junie.jetbrains.com/cli-auth"
export const MANUAL_REDIRECT = "https://account.jetbrains.com/oauth2/ide/callback"
export const CLIENT_ID = "junie-cli"
export const SCOPES = "offline_access openid jb-authn-service"
export const LOGIN_TIMEOUT = 5 * 60_000

export const COMMON_HEADERS = {
  Accept: "text/event-stream,application/json,text/event-stream",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Accept-Encoding": "identity",
  "User-Agent": "junie-cli:26.10.20",
  "X-Keep-Path": "true",
  "X-Accept-EAP-License": "false",
  "X-Accept-Release-License": "true",
  "Grazie-Agent": '{"name":"junie:cli","version":"3813.7:3813.7"}',
  "X-Client-Feature-Id": "junie",
} as const

export const HEADERS = {
  ...COMMON_HEADERS,
  "Openai-Version": "2020-11-07",
  "X-LLM-Model": "openai",
} as const

export const ANTHROPIC_HEADERS = {
  ...COMMON_HEADERS,
  "X-LLM-Model": "anthropic",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "prompt-caching-2024-07-31,computer-use-2025-01-24,thinking-binding-controls-2026-08-01",
} as const
