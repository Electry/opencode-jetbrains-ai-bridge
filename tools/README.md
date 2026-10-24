# Junie model pricing extractor

```bash
python3 tools/extract_junie_models.py --output /tmp/opencode/junie-models.json
```

Requires Python **3.11+** and Linux or macOS on amd64/aarch64. No account or token
is needed. The release bundle can be a few hundred MB.
The full download/extraction path has been tested on Linux aarch64.

The tool:

1. Reads the same official release manifest used by Junie's installer.
2. Selects the latest numeric release for your platform.
3. Downloads the release ZIP and verifies its published SHA-256 and size.
4. Uses Java from PATH, or extracts the release's bundled Java runtime.
5. Downloads checksum-pinned CFR 0.152 and decompiles only the model/pricing classes.
6. Extracts all bundled model definitions into JSON, including prices and limits.

Extraction runs Java and CFR without running Junie or accessing credentials.
The catalog includes older and experimental models. Model access depends on your account.

To update the plugin's bundled model snapshot:

```bash
python3 tools/extract_junie_models.py --output plugins/jetbrains/junie-models.json
```

The plugin reads the snapshot at startup. Python and Java are only needed to update it.
Use `/reload` if the plugin is already loaded. See the
[plugin pricing documentation](../README.md#native-cost-calculation)
for estimation caveats and per-model overrides.

## Options

```bash
# Only OpenAI definitions. The full catalog is validated before filtering.
python3 tools/extract_junie_models.py --provider OpenAI --output /tmp/opencode/junie-openai-models.json

# Reproduce a published release instead of selecting latest.
python3 tools/extract_junie_models.py --version 3813.7 --output /tmp/opencode/junie-3813.7-models.json

# Select a platform explicitly and use an installed Java executable.
python3 tools/extract_junie_models.py --platform linux-aarch64 --java /path/to/java
```

Downloads are cached under `/tmp/opencode/junie-model-pricing` and reverified on
reuse. Override with `--cache-dir`. For a different-platform archive, supply a
host-compatible `--java` executable. If the bundle contains runtime symlinks, use
an installed Java rather than extracting the bundled runtime.

Without `--output`, JSON goes to stdout. Progress goes to stderr. Output files are
replaced atomically after successful extraction. A checksum mismatch, changed
constructor layout, or missing model definition aborts extraction.

## Output

The snapshot records release version, platform, download URL, release/JAR hashes,
and the decompiler version/hash. Each model has this shape:

```json
{
  "id": "gpt-6-luna",
  "provider": "OpenAI",
  "sourceSymbol": "GPT_6_LUNA",
  "pricing": { "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125 },
  "limits": { "output": null, "context": 1000000 }
}
```

Prices are Junie's per-million-token cost estimates, exported unchanged.
Actual billing can differ.
`null` limits mean the bundled model definition leaves the limit unspecified.

The extractor applies Kotlin constructor defaults when reading prices and limits.

## Offline tests

```bash
python3 -B -m unittest discover -s tools/tests -p 'test_*.py'
```
