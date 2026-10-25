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
  "plugins": ["/path/to/opencode-jetbrains-ai-bridge/plugins/jetbrains"]
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

OpenCode saves credentials and refreshes them automatically. Use `/connect` to
switch, rename, or delete saved accounts.

## Credits and spend

When a JetBrains model is selected, the sidebar shows your balance, allowance,
next refill, and update time. Plan details depend on account availability.

| Command | Action |
| --- | --- |
| `/jetbrains` | Show account, credits, refill schedule, and cost estimation |
| `/jetbrains-refresh` | Refresh balance and plan details |

The balance includes usage from other apps on your account. OpenCode's dollar
costs use Junie rate estimates. Actual billing may differ. Dollar estimates have
no direct conversion to JetBrains credits.

## Configuration

Use the object form to set plugin options.
Example overrides for Luna's pricing and limits, and Astra's output limit:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-jetbrains-ai-bridge/plugins/jetbrains",
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

Overrides are optional. Model settings take precedence over global settings and
bundled defaults. Pricing overrides require all four rates, including cache prices.
Limits must be integers: context at least `8192`, output at least `256`, and output
below context. Overrides apply to the supported models listed above.
The JetBrains gateway may enforce lower limits.

### Reasoning

GPT reasoning variants: `none`, `low`, `medium`, `high`, `xhigh`, `max`, except
**GPT-6 Astra and GPT-6.1 Sol**, which omit `none`. GPT defaults to `low`.
Select a variant in OpenCode or pass it on the command line:

```bash
opencode run --model jetbrains/gpt-6-luna#high "Review this change"
```

Claude offers `low`, `medium`, `high`, `xhigh`, and `max`. **Haiku 5.5** stops at
`xhigh`. Claude defaults to `high`.

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

## Troubleshooting

### Login errors

After a failed code exchange, close the login dialog and start a fresh `/connect`
attempt.

Run `/jetbrains` for authentication errors and account status.

### Missing plan details

Run `/jetbrains` for setup errors. Existing logins may need an automatic
refresh before plan details appear. Reconnect through `/connect` to prepare them
immediately. Trial accounts and accounts with multiple eligible plans may have
limited details.
