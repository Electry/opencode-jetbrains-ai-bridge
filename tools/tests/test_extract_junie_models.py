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
@Nullable Integer maxContextTokens, Object other) {}'''
ANSWER_SOURCE = '''double oneMillion = 1000000.0;
return tokens / oneMillion * caps.getInputPrice() + caps.getOutputPrice()
+ caps.getCacheInputPrice() + caps.getCacheCreateInputPrice();'''
CAPS = 'new ModelCapabilities(0.1, 0.5, 0.01, 0.125, null, (Integer)1000000, null, false, false, null, null, true, false, 0.01, false, 0.0, 1810, 55184, null)'
CAPS_3893 = CAPS.replace('1810, 55184, null)', '1810, null, 186256, null)')


def release(version, target='linux-aarch64'):
    return {'version': version, 'platform': target,
            'downloadUrl': f'https://github.com/JetBrains/junie/releases/download/{version}/junie-release-{version}-{target}.zip',
            'sha256': 'a' * 64}


class ExtractorTests(unittest.TestCase):
    def test_latest_release_is_numeric_and_platform_specific(self):
        manifest = '\n'.join(json.dumps(x) for x in [release('9.9'), release('10.2'), release('99.1', 'linux-amd64')])
        self.assertEqual(extractor.select_release(manifest, 'linux-aarch64')['version'], '10.2')
        self.assertEqual(extractor.select_release(manifest, 'linux-aarch64', '9.9')['version'], '9.9')

    def test_unverified_or_unexpected_downloads_are_rejected(self):
        for changes in [{'sha256': ''}, {'downloadUrl': 'https://example.com/bundle.zip'}]:
            item = release('1.0') | changes
            with self.assertRaises(extractor.ExtractionError):
                extractor.select_release(json.dumps(item), 'linux-aarch64')

    def test_capabilities_keep_price_order_and_nullable_limits(self):
        result = extractor.capabilities(CAPS)
        self.assertEqual(result['pricing'], {'input': 0.1, 'output': 0.5, 'cacheRead': 0.01, 'cacheWrite': 0.125})
        self.assertEqual(result['limits'], {'output': None, 'context': 1000000})

    def test_kotlin_default_mask_is_applied_before_export(self):
        result = extractor.capabilities(CAPS.replace('55184, null)', '0x21, null)'))
        self.assertEqual(result['pricing']['input'], 0)
        self.assertIsNone(result['limits']['context'])

    def test_3893_capabilities_with_input_modalities(self):
        for expression in [CAPS_3893, CAPS_3893.replace('1810, null,', '1810, CollectionsKt.listOf("text", "image"),')]:
            with self.subTest(expression=expression):
                self.assertEqual(extractor.capabilities(expression), extractor.capabilities(CAPS))
        result = extractor.capabilities(CAPS_3893.replace('186256, null)', '0x21, null)'))
        self.assertEqual(result['pricing']['input'], 0)
        self.assertIsNone(result['limits']['context'])

    def test_capabilities_without_default_constructor_mask(self):
        for expression in [CAPS.replace(', 55184, null)', ')'),
                           CAPS_3893.replace(', 186256, null)', ')')]:
            with self.subTest(expression=expression):
                self.assertEqual(extractor.capabilities(expression), extractor.capabilities(CAPS))

    def test_unsupported_constructor_and_invalid_default_masks_are_rejected(self):
        for expression in [CAPS_3893.replace('1810, null,', '1810, null, false,'),
                           CAPS_3893.replace('186256, null)', '0.5, null)'),
                           CAPS_3893.replace('186256, null)', '186256, marker)')]:
            with self.subTest(expression=expression), self.assertRaises(extractor.ExtractionError):
                extractor.capabilities(expression)

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
        }'''.replace('CAPS', CAPS)
        models = extractor.parse_models(source, CAPS_SOURCE, ANSWER_SOURCE)
        self.assertEqual(len(models), 2)
        self.assertEqual({m['provider'] for m in models}, {'OpenAI', 'Google'})

    def test_catalog_changes_fail_instead_of_silently_dropping_models(self):
        source = '''private static final LLM A; private static final LLM B;
        static {
            A = LLM.Companion.llm("example", LlmProvider.OpenAI, "alias", CAPS, null);
        }'''.replace('CAPS', CAPS)
        with self.assertRaisesRegex(extractor.ExtractionError, 'Incomplete catalog'):
            extractor.parse_models(source, CAPS_SOURCE, ANSWER_SOURCE)
        with self.assertRaisesRegex(extractor.ExtractionError, 'field order'):
            extractor.parse_models(source, CAPS_SOURCE.replace('inputPrice', 'renamed'), ANSWER_SOURCE)
        with self.assertRaisesRegex(extractor.ExtractionError, 'per-million'):
            extractor.parse_models(source, CAPS_SOURCE, ANSWER_SOURCE.replace('1000000.0', '1000.0'))

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
