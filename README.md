# JetBrains AI provider for OpenCode V2

OpenCode plugin for using models through your JetBrains AI plan/subscription.

Supported model IDs (under the `jetbrains` provider):

- `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`
- `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`
- `gpt-6.1-sol`
- `claude-sonnet-5`, `claude-opus-5`
- `claude-fable-5-1`
- `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`

Access depends on your JetBrains account.
All models share one login and credit balance.

## Quick start

Add the plugin's directory to your OpenCode configuration, typically
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-jetbrains-bridge/plugins/jetbrains"]
}
```

Use an absolute path for the plugin.
Configuration reloads on save, or you can run the `/reload` command manually if needed.

1. Run `/connect` and choose **JetBrains AI**.
2. Choose **paste code** or **localhost callback**.
3. Open the login URL and finish JetBrains authentication.
4. For manual login, paste the code into OpenCode's login dialog. Treat it as a secret.
5. Select a model under **JetBrains AI** in `/models`.

Use manual login when the OpenCode server is remote. The localhost callback runs
on the server's machine and listens on `127.0.0.1` with an ephemeral port.
The manual flow accepts JetBrains' base64-encoded code, a plain authorization code,
or the full callback URL.

### Credentials

- OpenCode stores and updates OAuth credentials in its credential database.
- OpenCode resolves credentials and refreshes them five minutes before expiry.
  The plugin exchanges refresh tokens and deduplicates overlapping refreshes
  across locations in the same server process.
- Refresh responses can rotate the refresh token. OpenCode saves the new token
  or keeps the existing token if the response omits it.
- `/connect` provides account switching, renaming, and deletion.
- Browser callbacks and pasted callback URLs validate OAuth state. Manual code
  entry uses PKCE to bind the code to the login attempt.
- Login cancellation, expiry, and plugin unload close the localhost listener.
- An optional `JUNIE_ACCESS_TOKEN` environment connection is available for testing.
  Saved accounts take precedence. Environment tokens are not refreshed.
- Refresh deduplication works within one server process. Separate servers using
  the same grant can still race during token rotation.

## Credits and spend

When a JetBrains model is selected, the sidebar shows the remaining balance,
its unit, update time, and any refresh errors.

| Command | Action |
| --- | --- |
| `/jetbrains` | Show account, license, credits, update time, and pricing status |
| `/jetbrains-refresh` | Request a fresh balance |

`CREDITS` balances are divided by 100,000 for display, matching Junie. RPC includes
both normalized `balance` and unmodified `rawBalance`.

Balance requests are shared across locations and cached for one minute. Manual
refresh has a five-second cooldown and respects error/rate-limit backoff. The
plugin also checks for a due balance update when a response finishes streaming.
Inference continues if the credit service fails.

The credit balance includes all usage on the account, including other apps.
OpenCode estimates session costs from token usage and model pricing, independently
of that balance.

### Native cost calculation

OpenCode calculates prompt and session costs from token/cache usage and the rates
in `plugins/jetbrains/junie-models.json`. These are Junie's per-million-token estimates. Actual
billing can differ, and the `$` display has no direct conversion to JetBrains credits.
`/jetbrains` reports the selected model, pricing source, and Junie release.
When another provider is selected, it reports GPT-6 Luna as the fallback.

If the snapshot has a missing, invalid, or duplicate model entry and no pricing
override is configured, inference continues with pricing unavailable. OpenCode may
display `$0` when it has no pricing data.

## Configuration

Use the object form to set plugin options.
Example overrides for Luna's pricing and limits, and Astra's output limit:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-jetbrains-bridge/plugins/jetbrains",
      "options": {
        "models": {
          "gpt-6-luna": {
            "limits": { "context": 1000000, "output": 128000 },
            "usdPerMillionTokens": {
              "input": 0.1,
              "output": 0.5,
              "cache": { "read": 0.01, "write": 0.125 }
            }
          },
          "gpt-6-astra": { "limits": { "output": 64000 } }
        }
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `models` | `{}` | Model-ID-keyed overrides: optional `limits: {context?, output?}` and `usdPerMillionTokens: {input, output, cache: {read, write}}` |
| `contextLimit` | Bundled context limit | Global override |
| `outputLimit` | Bundled output limit, or model fallback | Global output token limit |
| `usdPerMillionTokens` | Unset | Global pricing override: `{input, output, cache: {read, write}}` per million tokens |

All overrides are optional. Limits resolve independently for each field:
`models[id].limits` → global override → bundled limits → model-specific fallback. Pricing resolves
as a complete four-rate object: `models[id].usdPerMillionTokens` →
`usdPerMillionTokens` → bundled pricing.
Each pricing override needs all four rates, including cache prices.

Context falls back to `200000` if its bundled entry is missing, invalid, or duplicated.
Bundled output limits are `64000` for Haiku 5.5 and `128000` for the other Claude
models. Those values also serve as fallbacks if an output entry can't be loaded.
GPT entries leave output unspecified, so they use `128000`.

Override a budget with `models[modelID].limits`. Values must be safe integers:
context at least `8192`, output at least `256`, and output below context. If you
lower context below the output budget, lower output too. Overrides apply to models
in `plugins/jetbrains/src/catalog.ts`. Adding another ID to the config won't register it.

The JetBrains gateway may enforce lower limits than the bundled catalog advertises.

### Reasoning

GPT reasoning variants: `none`, `low`, `medium`, `high`, `xhigh`, `max`, except
**GPT-6 Astra and GPT-6.1 Sol**, which omit `none`. GPT defaults to `low`.
Select a variant in OpenCode or pass it on the command line:

```bash
opencode run --model jetbrains/gpt-6-luna#high "Review this change"
```

Claude offers `low`, `medium`, `high`, `xhigh`, and `max`. **Haiku 5.5** stops at
`xhigh`. The Claude models have no `none` variant. Claude defaults to `high`.
Haiku uses tools serially.

```bash
opencode run --model jetbrains/claude-sonnet-5-5#high "Review this change"
```

The plugin supports text and tools. Vision is disabled. It uses OpenCode’s tools,
prompts, and permissions.
To use JetBrains for title, summary, and compaction calls too, add:

```json
{
  "agents": {
    "title": { "model": "jetbrains/gpt-6-luna" },
    "summary": { "model": "jetbrains/gpt-6-luna" },
    "compaction": { "model": "jetbrains/gpt-6-luna" }
  }
}
```

## Request behavior

- Uses `@opencode/ai/providers/openai-compatible/responses` for GPT and
  `@opencode/ai/providers/anthropic` for Claude, with separate model settings.
- Sends Junie's routing, client/version, license, and protocol headers.
  The HTTP runtime handles host, content length, and connections.
- Injects the current account's bearer credential immediately before dispatch.
  Credentials are only sent to the fixed gateway's protocol-matched `/v1/responses`
  or `/v1/messages` endpoint. Redirects are disabled. Unrelated `x-api-key` headers
  are removed.
- Generates execution IDs from the OpenCode session's creation time and identity.
  GPT cache keys are scoped to account, session, model, and request kind.
- GPT reasoning variants map to `reasoning.effort`. GPT requests `24h`
  prompt-cache retention and `store: false`.
- Claude reasoning variants map to `output_config.effort`. Claude models use
  adaptive thinking and `block_binding.prefix_mismatch_behavior: "drop_block"`.
  Haiku omits `thinking.display`. Other Claude models use summarized display.
- Claude uses Anthropic cache breakpoints, thinking signatures, tool messages,
  and cache read/write usage. Required beta headers are merged with Junie's headers.
  The Anthropic runtime adds `?beta=true`. The plugin removes it for Junie's
  `/v1/messages` route and rejects other query strings.
- Handles primary, title, compaction, and transient requests for this provider.
- Uses HTTP without request compression. Cancellation propagates to inference.
- Passes response streams and usage events through to OpenCode.
- Stops retries for 401/403 and caps attempts. OpenCode handles 429 retries using
  the server's retry delay.

## Troubleshooting

### Login errors

After a failed code exchange, close the login dialog and start a fresh `/connect`
attempt.

Run `/jetbrains` to see the last authentication stage and error, including while
disconnected. The plugin saves this diagnostic in its own storage. Errors include
the HTTP status, known OAuth error codes, and invalid response field names.
A completed exchange means tokens were received. The account connection shows
whether OpenCode saved them.

## Development

### Updating the model snapshot

To update the snapshot, run from the repository root:

```bash
python3 tools/extract_junie_models.py --output plugins/jetbrains/junie-models.json
```

The snapshot records the Junie release and artifact hashes. The plugin reads this
file at startup, so Python and Java are only needed to update it. Run `/reload`
after updating. The same file supplies pricing, context limits, and output limits.

### Tests

For development, install Bun, then run from the repository root:

```bash
cd plugins/jetbrains
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
python3 -B tests/smoke_opencode.py
python3 -B tests/smoke_opencode.py --environment
python3 -B tests/smoke_opencode.py --oauth-complete
python3 -B tests/smoke_tui.py
```

The Python smoke tests start an isolated OpenCode server with temporary config and
credentials under `/tmp/opencode`. They check registration, RPC, model activation,
and OAuth start/cancel, then stop the server. All JetBrains network calls are
skipped, including code exchange, credits, and inference.

`--oauth-complete` uses fake token responses to check credential persistence,
model activation, and failed login attempts.

The TUI smoke test uses a Unix pseudo-terminal to check slash completion and the
status dialog while the prompt has focus. All inference providers are disabled.
