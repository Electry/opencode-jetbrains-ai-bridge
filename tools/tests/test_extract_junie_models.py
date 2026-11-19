from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / 'extract_junie_models.py'
spec = importlib.util.spec_from_file_location('extract_junie_models', SCRIPT)
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)

CAPS_SOURCE = '''public ModelCapabilities(double inputPrice, double outputPrice,
double cacheInputPrice, double cacheCreateInputPrice, @Nullable Integer maxOutputTokens,
@Nullable Integer maxContextTokens, Object vision, boolean resume, boolean reasoning,
Object efforts, Object effort, boolean search, boolean computer, double searchPrice,
boolean toolChoice, double audioPrice, int cacheTimeoutSeconds) {}'''
ANSWER_SOURCE = '''double oneMillion = 1000000.0;
return tokens / oneMillion * caps.getInputPrice() + caps.getOutputPrice()
+ caps.getCacheInputPrice() + caps.getCacheCreateInputPrice();'''
CAPS = 'new ModelCapabilities(0.1, 0.5, 0.01, 0.125, null, (Integer)1000000, null, false, false, null, null, true, false, 0.01, false, 0.0, 1810, 55184, null)'
EXPECTED_CAPS = {
    'pricing': {'input': 0.1, 'output': 0.5, 'cacheRead': 0.01, 'cacheWrite': 0.125},
    'limits': {'output': None, 'context': 1000000},
}


def release(version, target='linux-aarch64', channel='release'):
    return {'version': version, 'platform': target,
            'downloadUrl': f'https://github.com/JetBrains/junie/releases/download/{version}/junie-{channel}-{version}-{target}.zip',
            'sha256': 'a' * 64}


class ExtractorTests(unittest.TestCase):
    def test_latest_release_is_numeric_and_platform_specific(self):
        manifest = '\n'.join(json.dumps(x) for x in [release('9.9'), release('10.2'), release('99.1', 'linux-amd64')])
        self.assertEqual(extractor.select_release(manifest, 'linux-aarch64')['version'], '10.2')
        self.assertEqual(extractor.select_release(manifest, 'linux-aarch64', '9.9')['version'], '9.9')

    def test_cli_selects_manifest_and_separates_bundle_caches(self):
        class BundleRequested(Exception):
            pass

        cases = [
            ([], extractor.MANIFEST, 'release', '10.2'),
            (['--nightly'], extractor.NIGHTLY_MANIFEST, 'nightly', '10.2'),
            (['--nightly', '--version', '9.9'], extractor.NIGHTLY_MANIFEST, 'nightly', '9.9'),
        ]
        cache = Path('/tmp/opencode/test-junie-cache')
        destinations = {}
        for options, url, channel, version in cases:
            with self.subTest(options=options):
                build = release(version, channel=channel) | {'size': 123}
                manifest = '\n'.join(json.dumps(item) for item in [
                    release('9.9', channel=channel) | {'size': 123},
                    release('10.2', channel=channel) | {'size': 123},
                    release('99.1', 'linux-amd64', channel),
                ])
                argv = [str(SCRIPT), '--platform', 'linux-aarch64', '--cache-dir', str(cache), *options]
                with (patch('sys.argv', argv),
                      patch('urllib.request.urlopen', return_value=io.BytesIO(manifest.encode())) as fetch,
                      patch.object(extractor, 'download', side_effect=BundleRequested) as download,
                      redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()),
                      self.assertRaises(BundleRequested)):
                    extractor.main()
                self.assertEqual(fetch.call_args.args[0].full_url, url)
                download.assert_called_once()
                download_url, destination, checksum, size = download.call_args.args
                self.assertEqual((download_url, checksum, size), (build['downloadUrl'], build['sha256'], build['size']))
                self.assertTrue(destination.is_relative_to(cache))
                destinations[channel, version] = destination
        self.assertEqual(len(set(destinations.values())), len(cases))

    def test_unverified_or_unexpected_downloads_are_rejected(self):
        for changes in [{'sha256': ''}, {'downloadUrl': 'https://example.com/bundle.zip'}]:
            item = release('1.0') | changes
            with self.assertRaises(extractor.ExtractionError):
                extractor.select_release(json.dumps(item), 'linux-aarch64')

    def test_verified_signature_distinguishes_direct_and_masked_constructors(self):
        base = CAPS.removesuffix(', 55184, null)')
        defaults = {'pricing': EXPECTED_CAPS['pricing'] | {'input': 0},
                    'limits': EXPECTED_CAPS['limits'] | {'context': None}}
        source = '''private static final LLM A;
        static {
            A = LLM.Companion.llm("example", LlmProvider.OpenAI, "alias", CAPS, null);
        }'''
        model = {'id': 'example', 'provider': 'OpenAI', 'sourceSymbol': 'A'}
        cases = [
            ('', ''),
            (', List<String> inputModalities', ', CollectionsKt.listOf("text", "image")'),
            (', List<String> inputModalities, Long maxRequestBytes', ', null, (Long)20971520L'),
            (', List<String> inputModalities, Long maxRequestBytes, long maxStepImageBytes, long maxHistoryImageBytes',
             ', null, null, 10485760L, 20971520L'),
        ]
        # A masked 17- or 19-field call has the same arity as a direct
        # 19- or 21-field call, respectively, but must yield different values.
        for fields, extra in cases:
            signature = CAPS_SOURCE.replace('int cacheTimeoutSeconds)', f'int cacheTimeoutSeconds{fields})')
            for mask, expected in [('', EXPECTED_CAPS), (', 0x21, null', defaults)]:
                with self.subTest(fields=fields, masked=bool(mask)):
                    models = extractor.parse_models(source.replace('CAPS', f'{base}{extra}{mask})'),
                                                    signature, ANSWER_SOURCE)
                    self.assertEqual(models, [model | expected])

    def test_unsupported_constructor_and_invalid_default_masks_are_rejected(self):
        for tail, error in [('false, 55184, null)', 'constructor changed'),
                            ('0.5, null)', 'constructor mask'),
                            ('55184, marker)', 'constructor mask')]:
            with self.subTest(tail=tail), self.assertRaisesRegex(extractor.ExtractionError, error):
                extractor.capabilities(CAPS.replace('55184, null)', tail), 17)

    def test_numeric_literals_and_unsupported_expressions(self):
        self.assertEqual(extractor.number('(Integer)0x100000'), 1048576)
        self.assertEqual(extractor.number('0.125d'), 0.125)
        for value in ['System.getenv("anything")', '1.0 / 2.0', '-1', 'NaN']:
            with self.assertRaises(extractor.ExtractionError):
                extractor.number(value)

    def test_extracts_variable_and_inline_factory_definitions(self):
        source = '''private static final LLM A; private static final LLM B;
        static {
            Object object = LlmProvider.OpenAI;
            ModelCapabilities caps = CAPS;
            A = LLM.Companion.llm("gpt-example", (LlmProvider)((Object)object), "alias", caps, null);
            B = some.LLM$Companion.llm$default(Companion, "other-example", LlmProvider.Google, "alias", CAPS, null, 16, null);
        }'''
        models = extractor.parse_models(source.replace('CAPS', CAPS), CAPS_SOURCE, ANSWER_SOURCE)
        self.assertEqual(models, [
            {'id': 'other-example', 'provider': 'Google', 'sourceSymbol': 'B', **EXPECTED_CAPS},
            {'id': 'gpt-example', 'provider': 'OpenAI', 'sourceSymbol': 'A', **EXPECTED_CAPS},
        ])

    def test_catalog_changes_fail_instead_of_silently_dropping_models(self):
        source = '''private static final LLM A; private static final LLM B;
        static {
            A = LLM.Companion.llm("example", LlmProvider.OpenAI, "alias", CAPS, null);
        }'''.replace('CAPS', CAPS)
        with self.assertRaisesRegex(extractor.ExtractionError, 'Incomplete catalog'):
            extractor.parse_models(source, CAPS_SOURCE, ANSWER_SOURCE)
        with self.assertRaisesRegex(extractor.ExtractionError, 'field order'):
            extractor.parse_models(source, CAPS_SOURCE.replace('inputPrice', 'renamed'), ANSWER_SOURCE)
        with self.assertRaisesRegex(extractor.ExtractionError, 'constructor changed'):
            extractor.parse_models(source, CAPS_SOURCE.replace('int cacheTimeoutSeconds)', 'int cacheTimeoutSeconds, int a, int b, int c)'),
                                   ANSWER_SOURCE)
        with self.assertRaisesRegex(extractor.ExtractionError, 'per-million'):
            extractor.parse_models(source, CAPS_SOURCE, ANSWER_SOURCE.replace('1000000.0', '1000.0'))

    def test_served_alias_copies_or_overrides_pricing_and_limits(self):
        copy_args = '0.2, 0, 0, 0, null, null' + ', null' * 11
        source = f'''private static final LLM A; private static final LLM B;
        private static final ModelCapabilities B$lambda$0(ModelCapabilities base) {{
            Intrinsics.checkNotNullParameter(base, "base");
            return ModelCapabilities.copy$default(base, {copy_args}, 46, null);
        }}
        static {{
            A = LLM.Companion.llm("example", LlmProvider.OpenAI, "alias", {CAPS}, null);
            B = LLM.Companion.servedAs(LLM.A, "served/example", LLM::B$lambda$0);
        }}'''
        base, served = extractor.parse_models(source, CAPS_SOURCE, ANSWER_SOURCE)
        self.assertEqual(served['id'], 'served/example')
        self.assertEqual(served['provider'], base['provider'])
        self.assertEqual(served['pricing'], base['pricing'] | {'input': 0.2})
        self.assertEqual(served['limits'], base['limits'])
        with self.assertRaisesRegex(extractor.ExtractionError, 'Unsupported servedAs capabilities copy'):
            extractor.parse_models(source.replace('copy$default(base,', 'copy$default(other,'),
                                   CAPS_SOURCE, ANSWER_SOURCE)

    def test_cfr_catalog_excerpts_from_stable_and_nightly(self):
        # CFR 0.152 excerpts from 4100.5 stable and 4159.1 nightly. Unrelated
        # models and local setup are omitted; only consumed snippets are kept.
        signature = CAPS_SOURCE.replace('int cacheTimeoutSeconds)',
                                        'int cacheTimeoutSeconds, List<String> inputModalities, Long maxRequestBytes)')
        constructor = ('new ModelCapabilities(0.1, 0.5, 0.01, 0.125, null, (Integer)1000000, lLMVision, '
                       'false, false, null, null, true, false, 0.01, false, 0.0, 1810, null, null, ')
        source = '''private static final LLM GPT_6_LUNA;
        DECLARATIONS
        static {
            object = LlmProvider.OpenAI;
            modelCapabilities = CAPS;
            GPT_6_LUNA = LLM.Companion.llm("gpt-6-luna", (LlmProvider)((Object)object), "openai-gpt-6-luna", modelCapabilities, "openai/gpt-6-luna");
            ALIAS
        }'''
        nightly_declarations = '''private static final LLM JUNIE_LITE;
        private static final ModelCapabilities JUNIE_LITE$lambda$0(ModelCapabilities $this$servedAs) {
            Intrinsics.checkNotNullParameter($this$servedAs, "$this$servedAs");
            return ModelCapabilities.copy$default($this$servedAs, 0.0, 0.0, 0.0, 0.0, null, null, null, false, false, null, null, false, false, 0.0, false, 0.0, 0, null, null, 0L, 0L, 2086896, null);
        }'''
        nightly_alias = 'JUNIE_LITE = LLM.Companion.servedAs(LLM.GPT_6_LUNA, "junie-lite/gpt-6-luna", LLM::JUNIE_LITE$lambda$0);'
        nightly_signature = signature.replace('Long maxRequestBytes)',
                                             'Long maxRequestBytes, long maxStepImageBytes, long maxHistoryImageBytes)')
        stable = source.replace('CAPS', constructor + '448400, null)').replace('DECLARATIONS', '').replace('ALIAS', '')
        nightly = (source.replace('CAPS', constructor + '0L, 0L, 2021264, null)')
                   .replace('DECLARATIONS', nightly_declarations).replace('ALIAS', nightly_alias))
        luna = {'id': 'gpt-6-luna', 'provider': 'OpenAI', 'sourceSymbol': 'GPT_6_LUNA',
                'pricing': {'input': 0.1, 'output': 0.5, 'cacheRead': 0.01, 'cacheWrite': 0.125},
                'limits': {'output': None, 'context': 1000000}}
        lite = luna | {'id': 'junie-lite/gpt-6-luna', 'sourceSymbol': 'JUNIE_LITE',
                       'pricing': dict.fromkeys(luna['pricing'], 0)}
        self.assertEqual(extractor.parse_models(stable, signature, ANSWER_SOURCE), [luna])
        self.assertEqual(extractor.parse_models(nightly, nightly_signature, ANSWER_SOURCE), [luna, lite])

    def test_argument_splitter_handles_strings_nested_calls_and_arrays(self):
        self.assertEqual(extractor.split_arguments('"name,with,commas", call(1, 2), new X[]{1,2}'),
                         ['"name,with,commas"', 'call(1, 2)', 'new X[]{1,2}'])
        with self.assertRaises(extractor.ExtractionError):
            extractor.split_arguments('unbalanced(')

    def test_archive_path_traversal_is_rejected(self):
        for path in ['../outside', '/absolute', 'runtime/../../outside', 'runtime\\outside']:
            with self.assertRaises(extractor.ExtractionError):
                extractor.safe_zip_path(path)

    def test_runtime_symlinks_are_not_followed(self):
        content = io.BytesIO()
        with zipfile.ZipFile(content, 'w') as archive:
            archive.writestr('app/lib/runtime/bin/java', b'not executed')
            link = zipfile.ZipInfo('app/lib/runtime/lib/link')
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, '../../../../outside')
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp, zipfile.ZipFile(content) as archive:
            with self.assertRaisesRegex(extractor.ExtractionError, 'symlinks'):
                extractor.extract_runtime(archive, archive.getinfo('app/lib/runtime/bin/java'), Path(temp))

    def test_bad_checksum_does_not_replace_previous_cache_file(self):
        class Response(io.BytesIO):
            def geturl(self):
                return 'https://example.com/file'

        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            target = Path(temp) / 'cache.jar'
            target.write_bytes(b'previous cache')
            with patch('urllib.request.urlopen', return_value=Response(b'bad download')):
                with self.assertRaisesRegex(extractor.ExtractionError, 'checksum mismatch'):
                    extractor.download('https://example.com/file', target, 'a' * 64)
            self.assertEqual(target.read_bytes(), b'previous cache')
            self.assertEqual(list(Path(temp).glob('.download-*')), [])


if __name__ == '__main__':
    unittest.main()
