#!/usr/bin/env python3
"""Download the latest official Junie bundle and extract its static model rates.

Python standard library only. Runs CFR with an available Java runtime or the
verified release's bundled runtime.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


MANIFEST = 'https://raw.githubusercontent.com/jetbrains-junie/junie/main/update-info.jsonl'
CFR_URL = 'https://repo.maven.apache.org/maven2/org/benf/cfr/0.152/cfr-0.152.jar'
CFR_SHA256 = 'f686e8f3ded377d7bc87d216a90e9e9512df4156e75b06c655a16648ae8765b2'
PACKAGE = 'com/intellij/ml/llm/matterhorn/llm/'
CLASSES = ('LLM', 'ModelCapabilities', 'AIAnswer')


class ExtractionError(Exception):
    pass


def host_platform():
    system = {'Linux': 'linux', 'Darwin': 'macos'}.get(platform.system())
    arch = {'aarch64': 'aarch64', 'arm64': 'aarch64', 'x86_64': 'amd64', 'amd64': 'amd64'}.get(platform.machine().lower())
    if not system or not arch:
        raise ExtractionError('Unsupported host. Supply --platform and an appropriate --java runtime.')
    return f'{system}-{arch}'


def select_release(text, target, version=None):
    try:
        entries = [json.loads(line) for line in text.splitlines() if line.strip()]
        candidates = [entry for entry in entries if entry.get('platform') == target
                      and re.fullmatch(r'\d+(?:\.\d+)*', entry.get('version', ''))
                      and (version is None or entry['version'] == version)]
    except (ValueError, TypeError, AttributeError) as error:
        raise ExtractionError('Invalid official release manifest.') from error
    if not candidates:
        raise ExtractionError(f'No published release/checksum for {target}, version {version or "latest"}.')
    result = max(candidates, key=lambda entry: tuple(int(part) for part in entry['version'].split('.')))
    url = result.get('downloadUrl', '')
    if not isinstance(url, str) or not re.fullmatch(r'https://github\.com/(?:JetBrains|jetbrains-junie)/junie/releases/download/[^?#]+\.zip', url, re.I):
        raise ExtractionError('Unexpected release download URL in the manifest.')
    if not isinstance(result.get('sha256'), str) or not re.fullmatch(r'[a-fA-F0-9]{64}', result['sha256']):
        raise ExtractionError('Release has no valid SHA-256 checksum.')
    return result


def sha256(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def download(url, destination, expected, expected_size=None):
    """Verify cache hits too, replace downloads atomically only after validation."""
    destination = Path(destination)
    if destination.is_file() and sha256(destination) == expected.lower():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={'User-Agent': 'junie-model-pricing-extractor/1'})
    partial = None
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            if not response.geturl().startswith('https://'):
                raise ExtractionError('Download redirected away from HTTPS.')
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.download-', delete=False) as handle:
                partial = Path(handle.name)
                shutil.copyfileobj(response, handle)
        if expected_size is not None and partial.stat().st_size != expected_size:
            raise ExtractionError('Release download size does not match the manifest.')
        if sha256(partial) != expected.lower():
            raise ExtractionError('Download checksum mismatch.')
        partial.replace(destination)
    finally:
        if partial is not None:
            partial.unlink(missing_ok=True)


def safe_zip_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        raise ExtractionError('Unsafe path in release archive.')
    return path


def extract_runtime(bundle, java_entry, destination):
    """Extract only the runtime, without following archive symlinks."""
    root = PurePosixPath(java_entry.filename).parent.parent
    for entry in bundle.infolist():
        path = safe_zip_path(entry.filename)
        if not path.is_relative_to(root):
            continue
        target = destination / Path(*path.relative_to(root).parts)
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise ExtractionError('Bundled runtime uses symlinks, supply --java to use an installed runtime.')
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with bundle.open(entry) as source, target.open('wb') as output:
            shutil.copyfileobj(source, output)
        target.chmod(0o700 if mode & 0o111 else 0o600)
    return destination / 'bin/java'


def unpack(bundle_path, work, java_override=None):
    java = java_override or shutil.which('java')
    with zipfile.ZipFile(bundle_path) as bundle:
        jars = [entry for entry in bundle.infolist() if re.search(r'/(?:lib/app|Contents/app)/junie-[^/]+\.jar$', entry.filename)]
        if len(jars) != 1:
            raise ExtractionError('Expected one Junie application JAR, release layout changed.')
        jar = work / 'junie.jar'
        with bundle.open(jars[0]) as source, jar.open('wb') as target:
            shutil.copyfileobj(source, target)
        if java is None:
            runtimes = [entry for entry in bundle.infolist()
                        if entry.filename.endswith('/bin/java') and '/runtime/' in entry.filename]
            if len(runtimes) != 1:
                raise ExtractionError('No Java found in PATH or release bundle, supply --java /path/to/java.')
            java = str(extract_runtime(bundle, runtimes[0], work / 'runtime'))
    return jar, java


def decompile(jar, java, cfr, work):
    selected = work / 'model-classes.jar'
    with zipfile.ZipFile(jar) as source, zipfile.ZipFile(selected, 'w') as target:
        for name in source.namelist():
            if any(name == f'{PACKAGE}{base}.class' or
                   (name.startswith(f'{PACKAGE}{base}$') and name.endswith('.class')) for base in CLASSES):
                target.writestr(name, source.read(name))
        if not all(f'{PACKAGE}{base}.class' in target.namelist() for base in CLASSES):
            raise ExtractionError('Expected model/pricing classes are missing, release layout changed.')
    sources = work / 'sources'
    environment = dict(os.environ)
    for key in ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH']:
        environment.pop(key, None)
    result = subprocess.run([
        java, '-Xmx768m', '-jar', str(cfr), str(selected), '--extraclasspath', str(jar),
        '--outputdir', str(sources), '--silent', 'true',
    ], capture_output=True, text=True, env=environment, timeout=180)
    if result.returncode:
        raise ExtractionError(f'CFR failed (exit {result.returncode}), check Java compatibility.')
    return sources


def split_arguments(text, separator=','):
    parts, start, stack, quote, escaped = [], 0, [], None, False
    for index, char in enumerate(text):
        if quote:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in '\"\'':
            quote = char
        elif char in '([{':
            stack.append(char)
        elif char in ')]}':
            if not stack or stack.pop() != {')': '(', ']': '[', '}': '{'}[char]:
                raise ExtractionError('Unbalanced Java source.')
        elif char == separator and not stack:
            parts.append(text[start:index].strip())
            start = index + 1
    if stack or quote:
        raise ExtractionError('Unbalanced Java source.')
    if text[start:].strip():
        parts.append(text[start:].strip())
    return parts


def parenthesized(text, start):
    """Return the contents and end position of a balanced () or {} group."""
    opener = text[start]
    closer = {'(': ')', '{': '}'}[opener]
    depth, quote, escaped = 0, None, False
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in '\"\'':
            quote = char
        elif char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return text[start + 1:index], index + 1
    raise ExtractionError('Unbalanced Java source group.')


def number(text):
    text = re.sub(r'\((?:java\.lang\.)?(?:Integer|Long|Double|Float)\)', '', text).strip().replace('_', '')
    if text == 'null':
        return None
    try:
        value = int(text.rstrip('lL'), 16) if re.fullmatch(r'-?0[xX][0-9a-fA-F]+[lL]?', text) else float(text.rstrip('dDfFlL'))
    except ValueError as error:
        raise ExtractionError(f'Unsupported numeric expression: {text[:80]}') from error
    if not math.isfinite(value) or value < 0:
        raise ExtractionError('Invalid price/limit constant.')
    return int(value) if value == int(value) else value


def capabilities(expression):
    match = re.search(r'new ModelCapabilities\s*\(', expression)
    if not match:
        raise ExtractionError('Unsupported model capabilities expression.')
    raw, _ = parenthesized(expression, match.end() - 1)
    args = split_arguments(raw)
    if len(args) not in [17, 19]:
        raise ExtractionError('ModelCapabilities constructor changed, update the extractor.')
    values = [number(arg) for arg in args[:6]]
    if len(args) == 19:
        mask = number(args[-2])
        if not isinstance(mask, int) or args[-1] != 'null':
            raise ExtractionError('Unsupported Kotlin default constructor mask.')
        for index in range(6):
            if mask & (1 << index):
                values[index] = 0 if index < 4 else None
    if any(value is None for value in values[:4]):
        raise ExtractionError('Model prices cannot be null.')
    if any(value is not None and not isinstance(value, int) for value in values[4:]):
        raise ExtractionError('Model limits must be integers or null.')
    return {
        'pricing': dict(zip(['input', 'output', 'cacheRead', 'cacheWrite'], values[:4])),
        'limits': dict(zip(['output', 'context'], values[4:])),
    }


def parse_models(llm_source, caps_source, answer_source):
    # Validate argument meaning and the per-million formula.
    constructor = re.search(r'public ModelCapabilities\(([^)]*)\)', caps_source)
    expected = ['inputPrice', 'outputPrice', 'cacheInputPrice', 'cacheCreateInputPrice', 'maxOutputTokens', 'maxContextTokens']
    if not constructor or [arg.split()[-1] for arg in constructor.group(1).split(',')[:6]] != expected:
        raise ExtractionError('ModelCapabilities field order changed. Update the extractor.')
    if not re.search(r'oneMillion\s*=\s*1000000(?:\.0)?\s*;', answer_source) or not all(
        f'caps.get{field[0].upper() + field[1:]}()' in answer_source for field in expected[:4]
    ):
        raise ExtractionError('Could not verify the per-million pricing calculation.')
    match = re.search(r'\bstatic\s*\{', llm_source)
    if not match:
        raise ExtractionError('Model catalog initializer is missing.')
    body, _ = parenthesized(llm_source, match.end() - 1)
    variables, models = {}, {}
    for statement in split_arguments(body, ';'):
        assignment = re.match(r'(?:[\w<>?]+\s+)?([\w$]+)\s*=\s*(.*)', statement, re.S)
        if not assignment:
            continue
        symbol, expression = assignment.groups()
        if expression.startswith('new ModelCapabilities('):
            variables[symbol] = capabilities(expression)
            continue
        provider = re.fullmatch(r'LlmProvider\.([A-Za-z0-9_]+)', expression)
        if provider:
            variables[symbol] = provider.group(1)
            continue
        call = re.search(r'\.llm(\$default)?\s*\(', expression)
        if not call:
            continue
        args, _ = parenthesized(expression, call.end() - 1)
        args = split_arguments(args)
        default = bool(call.group(1))
        if len(args) != (8 if default else 5):
            raise ExtractionError('LLM factory signature changed.')
        if default:
            factory_mask = number(args[-2])
            if not isinstance(factory_mask, int) or factory_mask & 8:
                raise ExtractionError('Unexpected default model pricing, update the extractor.')
            args = args[1:6]
        try:
            model_id = json.loads(args[0])
        except ValueError as error:
            raise ExtractionError('Model identifier is not a string constant.') from error
        provider_expr = re.sub(r'\((?:LlmProvider|Object)\)', '', args[1]).strip('() ')
        direct = re.fullmatch(r'LlmProvider\.([A-Za-z0-9_]+)', provider_expr)
        provider_name = direct.group(1) if direct else variables.get(provider_expr)
        caps = capabilities(args[3]) if args[3].startswith('new ModelCapabilities(') else variables.get(args[3])
        if not isinstance(model_id, str) or not isinstance(provider_name, str) or not isinstance(caps, dict):
            raise ExtractionError(f'Could not resolve model definition {symbol}.')
        if symbol in models:
            raise ExtractionError('Duplicate model symbol.')
        models[symbol] = {'id': model_id, 'provider': provider_name, 'sourceSymbol': symbol, **caps}
    declared = set(re.findall(r'(?:private|public)\s+static\s+final\s+LLM\s+(\w+)\s*;', llm_source))
    if not declared or set(models) != declared:
        raise ExtractionError(f'Incomplete catalog extraction: {len(models)} definitions, {len(declared)} declarations.')
    return sorted(models.values(), key=lambda model: (model['provider'], model['id'], model['sourceSymbol']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Write JSON atomically to this file, default: stdout')
    parser.add_argument('--cache-dir', type=Path, default=Path('/tmp/opencode/junie-model-pricing'))
    parser.add_argument('--platform', choices=['linux-amd64', 'linux-aarch64', 'macos-amd64', 'macos-aarch64'])
    parser.add_argument('--version', help='Pin a published release instead of selecting latest')
    parser.add_argument('--java', help='Use this installed Java executable instead of PATH/bundled Java')
    parser.add_argument('--provider', help='Filter extracted definitions, e.g. OpenAI')
    args = parser.parse_args()
    target = args.platform or host_platform()
    if args.version and not re.fullmatch(r'\d+(?:\.\d+)*', args.version):
        raise ExtractionError('Version must be a numeric Junie release version.')
    request = urllib.request.Request(MANIFEST, headers={'User-Agent': 'junie-model-pricing-extractor/1'})
    with urllib.request.urlopen(request, timeout=30) as response:
        release = select_release(response.read().decode('utf-8'), target, args.version)
    print(f'Junie {release["version"]} ({target}), downloading/verifying release...', file=sys.stderr)
    cache = args.cache_dir.resolve()
    bundle = cache / target / release['version'] / 'bundle.zip'
    download(release['downloadUrl'], bundle, release['sha256'], release.get('size'))
    cfr = cache / 'cfr-0.152.jar'
    download(CFR_URL, cfr, CFR_SHA256)
    with tempfile.TemporaryDirectory(prefix='extract-', dir=cache) as temp:
        work = Path(temp)
        jar, java = unpack(bundle, work, args.java)
        sources = decompile(jar, java, cfr, work) / PACKAGE
        models = parse_models(*[(sources / f'{name}.java').read_text() for name in CLASSES])
        total = len(models)
        if args.provider:
            models = [model for model in models if model['provider'].casefold() == args.provider.casefold()]
            if not models:
                raise ExtractionError('No models match the requested provider.')
        result = {
            'schemaVersion': 1,
            'junie': {key: release[key] for key in ['version', 'platform', 'downloadUrl', 'sha256']},
            'applicationJarSha256': sha256(jar),
            'extractor': {'decompiler': 'CFR 0.152', 'sha256': CFR_SHA256},
            'pricingUnit': 'per-million-tokens',
            'notes': "Token cost estimates from Junie's model definitions. Actual billing and model access depend on your account. Includes older and experimental models.",
            'totalBundledModels': total,
            'models': models,
        }
    text = json.dumps(result, indent=2, allow_nan=False) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=args.output.parent, prefix='.junie-models-', delete=False) as handle:
            pending = Path(handle.name)
            handle.write(text)
        try:
            pending.replace(args.output)
        finally:
            pending.unlink(missing_ok=True)
    else:
        sys.stdout.write(text)
    print(f'Extracted {len(models)} models ({total} bundled definitions).', file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except (ExtractionError, OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
