"""Check slash commands in a real TUI with inference disabled. Requires a Unix PTY."""

import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time


ROOT = Path(__file__).resolve().parents[1]


def plain(data):
    text = data.decode(errors='replace')
    text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', text)
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)


def click_refresh(master, data):
    text = data.decode(errors='replace')
    button = text.rfind('refresh')
    positions = list(re.finditer(r'\x1b\[(\d+);(\d+)H', text[:button]))
    assert button >= 0 and positions, 'Refresh button position was not rendered'
    cursor = positions[-1]
    row, column = map(int, cursor.groups())
    assert row <= 20, 'Short account dialog stretched beyond its content'
    column += len(plain(text[cursor.end():button].encode())) + 1
    assert 1 <= row <= 45 and 1 <= column <= 160
    os.write(master, f'\x1b[<0;{column};{row}M\x1b[<0;{column};{row}m'.encode())


def main():
    fixture = '--fixture' in sys.argv
    with tempfile.TemporaryDirectory(prefix='jetbrains-tui-smoke.', dir='/tmp/opencode') as temp:
        workspace = Path(temp)
        config = workspace / '.config/opencode'
        config.mkdir(parents=True)
        (config / 'opencode.json').write_text('{"update":"disable"}')
        (workspace / 'opencode.json').write_text(json.dumps({
            'plugins': [str(ROOT / 'tests/tui-fixture') if fixture else str(ROOT)],
            'policies': [{'action': 'provider.use', 'resource': '*', 'effect': 'deny'}],
        }))
        env = {key: value for key, value in os.environ.items()
               if not key.startswith('OPENCODE_') and key != 'JUNIE_ACCESS_TOKEN'}
        env.update(XDG_CONFIG_HOME=str(workspace / '.config'),
                   XDG_DATA_HOME=str(workspace / '.data'),
                   XDG_STATE_HOME=str(workspace / '.state'),
                   OPENCODE_DB=str(workspace / 'test.db'), TERM='xterm-256color')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 160, 0, 0))
        process = subprocess.Popen([shutil.which('opencode'), '--standalone'],
                                   cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        data = b''
        started = time.monotonic()
        typed = submitted = refreshed = closed = reopened = resubmitted = False
        quota_updated = failed = recovered = False
        refreshing_seen = False
        refreshed_at = closed_at = 0
        try:
            while process.poll() is None and time.monotonic() - started < 25:
                text = plain(data)
                if not typed and 'Connect a provider' in text and time.monotonic() - started >= 3:
                    os.write(master, b'/jetbrains')
                    typed = True
                if typed and not submitted and 'JetBrains: account and credits' in text:
                    assert 'JetBrains: refresh credits' not in text
                    os.write(master, b'\r')
                    submitted = True
                if submitted and not refreshed and 'select JetBrains AI.' in text and 'refresh' in text and 'ctrl+r' in text:
                    if fixture:
                        click_refresh(master, data)
                    else:
                        os.write(master, b'\x12')
                    refreshed = True
                    refreshed_at = time.monotonic()
                if fixture and refreshed and not refreshing_seen and 'refreshing' in text:
                    refreshing_seen = True
                    os.write(master, b'\x12')
                if fixture and refreshed and not quota_updated and '31 days' in text:
                    quota_updated = True
                    os.write(master, b'\x12')
                    data = b''
                if fixture and quota_updated and not failed and 'unavailable' in text:
                    failed = True
                    os.write(master, b'\x12')
                    data = b''
                if fixture and failed and not recovered and '31 days' in text:
                    recovered = True
                if refreshed and not closed and (recovered if fixture else time.monotonic() - refreshed_at >= 0.5):
                    os.write(master, b'\x1b')
                    closed = True
                    closed_at = time.monotonic()
                    data = b''
                if closed and not reopened and time.monotonic() - closed_at >= 0.5:
                    os.write(master, b'/jetbrains')
                    reopened = True
                if reopened and not resubmitted and 'JetBrains: account and credits' in text:
                    os.write(master, b'\r')
                    resubmitted = True
                marker = '31 days' if fixture else 'select JetBrains AI.'
                if resubmitted and marker in text and 'refresh' in text:
                    if fixture:
                        assert refreshing_seen, 'Refresh loading indicator was not rendered'
                    print('PASS: /jetbrains opens, refreshes, closes with Escape, and reopens.' +
                          (' Live quota updates and RPC failure recovery verified.' if fixture else ''))
                    return
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    try:
                        data += os.read(master, 262144)
                    except OSError:
                        break
            raise AssertionError(f'TUI status command failed: typed={typed}, submitted={submitted}, refreshed={refreshed}, closed={closed}, reopened={reopened}\n{text[-12000:]}')
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            os.close(master)


if __name__ == '__main__':
    main()
