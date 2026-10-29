"""Check plugin setup in a local OpenCode server with JetBrains requests disabled."""

import base64
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse


ROOT = Path(__file__).resolve().parents[1]
MODEL_IDS = {'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-terra', 'gpt-6.1-sol', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5'}


def main():
    environment = '--environment' in sys.argv
    oauth_complete = '--oauth-complete' in sys.argv
    with tempfile.TemporaryDirectory(prefix='jetbrains-plugin-smoke.', dir='/tmp/opencode') as temp:
        workspace = Path(temp)
        config = workspace / '.config'
        (config / 'opencode').mkdir(parents=True)
        (config / 'opencode/opencode.json').write_text(json.dumps({'update': 'disable'}))
        (workspace / 'opencode.json').write_text(json.dumps({
            'plugins': [str(ROOT / 'tests/oauth-fixture') if oauth_complete else str(ROOT)],
            'policies': [
                {'action': 'provider.use', 'resource': '*', 'effect': 'deny'},
                {'action': 'provider.use', 'resource': 'jetbrains', 'effect': 'allow'},
            ],
        }))
        env = dict(os.environ)
        for key in ['JUNIE_ACCESS_TOKEN', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_SESSION_ID']:
            env.pop(key, None)
        env.update(XDG_CONFIG_HOME=str(config), XDG_DATA_HOME=str(workspace / '.data'),
                   XDG_STATE_HOME=str(workspace / '.state'), OPENCODE_DB=str(workspace / 'test.db'))
        env['OPENCODE_PASSWORD'] = os.urandom(24).hex()
        if environment:
            env['JUNIE_ACCESS_TOKEN'] = 'offline-registration-test-only'
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        query = '?' + urllib.parse.urlencode({'location[directory]': str(workspace)})
        base = f'http://127.0.0.1:{port}'

        def request(path, data=None, method=None):
            # Use the password printed by this test's server.
            log_text = (workspace / 'server.log').read_text()
            password = re.search(r'^server password (\S+)$', log_text, re.M)
            if password:
                env['OPENCODE_PASSWORD'] = password.group(1)
            args = [shutil.which('opencode'), 'api', '--server', base, method or ('POST' if data is not None else 'GET'), path + query]
            if data is not None:
                args += ['--data', json.dumps(data)]
            result = subprocess.run(args, cwd=workspace, env=env, capture_output=True, text=True, timeout=30)
            if result.returncode:
                raise RuntimeError('Isolated OpenCode API request failed: ' + path)
            return json.loads(result.stdout) if result.stdout.strip() else None

        def unwrap(value):
            return value['data'] if isinstance(value, dict) and 'data' in value else value

        with (workspace / 'server.log').open('w') as log:
            process = subprocess.Popen([shutil.which('opencode'), 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                                       cwd=workspace, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 30
                while True:
                    try:
                        request('/api/info')
                        break
                    except (RuntimeError, TimeoutError):
                        if process.poll() is not None or time.monotonic() > deadline:
                            raise RuntimeError('Isolated OpenCode server failed to start.') from None
                        time.sleep(0.1)

                integrations = unwrap(request('/api/integration'))
                integration = next((item for item in integrations if item['id'] == 'jetbrains'), None)
                if integration is None:
                    plugins = unwrap(request('/api/plugin'))
                    print(json.dumps([{'id': item.get('id'), 'status': item.get('state', {}).get('status')} for item in plugins if 'jetbrains' in str(item)]))
                    raise RuntimeError('JetBrains integration was not registered.')
                assert integration['name'] == 'JetBrains AI'
                methods = {item.get('id') for item in integration['methods']}
                assert {'manual', 'browser'} <= methods
                if environment:
                    assert any(item['type'] == 'env' for item in integration['connections'])
                    models = unwrap(request('/api/model'))
                    jetbrains_models = [item for item in models if item['providerID'] == 'jetbrains']
                    assert {item['id'] for item in jetbrains_models} == MODEL_IDS
                    snapshot = json.loads((ROOT / 'junie-models.json').read_text())
                    for model in jetbrains_models:
                        assert model['limit']['context'] == 1000000
                        claude = model['id'].startswith('claude-')
                        assert model['limit']['output'] == (64000 if model['id'] == 'claude-haiku-5-5' else 128000)
                        assert model['package'] == ('@opencode/ai/providers/anthropic' if claude else '@opencode/ai/providers/openai-compatible/responses')
                        if claude:
                            assert model['settings']['effort'] == 'high'
                            assert model['settings']['thinking']['type'] == 'adaptive'
                            assert 'reasoningEffort' not in model['settings']
                            assert 'Openai-Version' not in model.get('headers', {})
                            for field in ['store', 'parallel_tool_calls', 'include']:
                                assert field not in model.get('body', {})
                        prices = next(item['pricing'] for item in snapshot['models'] if item['provider'] == ('Anthropic' if claude else 'OpenAI') and item['id'] == model['id'])
                        assert model['cost'][0]['input'] == prices['input']
                        assert model['cost'][0]['output'] == prices['output']
                        assert model['cost'][0]['cache'] == {'read': prices['cacheRead'], 'write': prices['cacheWrite']}
                        efforts = {'low', 'medium', 'high', 'xhigh', 'max'}
                        if not claude and model['id'] not in {'gpt-6-astra', 'gpt-6.1-sol'}:
                            efforts.add('none')
                        if model['id'] == 'claude-haiku-5-5':
                            efforts.remove('max')
                            assert 'display' not in model['settings']['thinking']
                        assert {variant['id'] for variant in model['variants']} == efforts
                    # The token is fake, so skip credits and inference.
                else:
                    assert not integration['connections']
                    status = request('/api/rpc/jetbrains/status', {'input': {}}, 'POST')['output']
                    assert status['connected'] is False
                    assert status['balance'] is None
                    assert status['dollarCost'] == 'estimated'
                    assert status['pricingSource'] == 'junie'
                    assert status['pricingVersion']
                    assert status['pricingError'] is None
                    assert status['modelID'] == 'gpt-6-luna'
                    for model_id in sorted(MODEL_IDS):
                        selected = request('/api/rpc/jetbrains/status', {'input': {'modelID': model_id}}, 'POST')['output']
                        assert selected['modelID'] == model_id
                        assert selected['pricingSource'] == 'junie'
                        assert selected['dollarCost'] == 'estimated'

                for method_id in ['manual', 'browser']:
                    attempt = unwrap(request('/api/integration/jetbrains/connect/oauth', {'methodID': method_id}, 'POST'))
                    attempt_id = attempt['attemptID']
                    # Cancel before the test reaches the browser or token exchange.
                    request(f'/api/integration/jetbrains/connect/oauth/{attempt_id}', method='DELETE')
                    if method_id == 'browser':
                        redirect = urllib.parse.parse_qs(urllib.parse.urlparse(attempt['url']).query)['redirect_uri'][0]
                        listener = urllib.parse.urlparse(redirect)
                        with socket.socket() as check:
                            check.settimeout(1)
                            assert check.connect_ex(('127.0.0.1', listener.port)) != 0, 'Cancelled login left its listener open.'

                if oauth_complete:
                    attempt = unwrap(request('/api/integration/jetbrains/connect/oauth', {'methodID': 'manual'}, 'POST'))
                    attempt_id = attempt['attemptID']
                    try:
                        request(f'/api/integration/jetbrains/connect/oauth/{attempt_id}/complete', {'code': 'offline-bad-code'}, 'POST')
                        raise AssertionError('Bad code was accepted.')
                    except RuntimeError:
                        pass
                    state = unwrap(request(f'/api/integration/jetbrains/connect/oauth/{attempt_id}'))
                    assert state['status'] == 'failed', state
                    diagnostic = request('/api/rpc/jetbrains/status', {'input': {}}, 'POST')['output']
                    assert diagnostic['authStage'] == 'code exchange failed'
                    assert 'HTTP 400, invalid_grant' in diagnostic['authError']
                    assert 'offline-bad-code' not in json.dumps(diagnostic)
                    assert 'offline-refresh' not in json.dumps(diagnostic)
                    # OpenCode 2.1.4 accepts a repeated completion as a no-op.
                    request(f'/api/integration/jetbrains/connect/oauth/{attempt_id}/complete', {'code': 'offline-bad-code'}, 'POST')
                    state = unwrap(request(f'/api/integration/jetbrains/connect/oauth/{attempt_id}'))
                    assert state['status'] == 'failed'
                    integration = next(item for item in unwrap(request('/api/integration')) if item['id'] == 'jetbrains')
                    assert not integration['connections']

                    attempt = unwrap(request('/api/integration/jetbrains/connect/oauth', {'methodID': 'manual'}, 'POST'))
                    attempt_id = attempt['attemptID']
                    wrapped_code = base64.b64encode(json.dumps({'code': 'offline-good-code'}).encode()).decode()
                    request(f'/api/integration/jetbrains/connect/oauth/{attempt_id}/complete', {'code': wrapped_code}, 'POST')
                    state = unwrap(request(f'/api/integration/jetbrains/connect/oauth/{attempt_id}'))
                    assert state['status'] == 'complete'
                    diagnostic = request('/api/rpc/jetbrains/status', {'input': {}}, 'POST')['output']
                    assert diagnostic['authStage'] == 'code exchange completed'
                    assert diagnostic['authError'] is None
                    integration = next(item for item in unwrap(request('/api/integration')) if item['id'] == 'jetbrains')
                    assert any(item['type'] == 'credential' for item in integration['connections'])
                    models = unwrap(request('/api/model'))
                    assert {item['id'] for item in models if item['providerID'] == 'jetbrains'} == MODEL_IDS
                    print('PASS: failed completion stays failed on retry; fresh completion saves credentials and activates models (fake tokens).')

                print('PASS: native registration, ' + ('environment model activation' if environment else 'disconnected credit RPC') + ', and both OAuth start/cancel flows.')
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    main()
