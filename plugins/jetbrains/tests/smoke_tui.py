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
import tempfile
import termios
import time


ROOT = Path(__file__).resolve().parents[1]


def plain(data):
    text = data.decode(errors='replace')
    text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', text)
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)


def main():
    with tempfile.TemporaryDirectory(prefix='jetbrains-tui-smoke.', dir='/tmp/opencode') as temp:
        workspace = Path(temp)
        config = workspace / '.config/opencode'
        config.mkdir(parents=True)
        (config / 'opencode.json').write_text('{"update":"disable"}')
        (workspace / 'opencode.json').write_text(json.dumps({
            'plugins': [str(ROOT)],
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
        typed = submitted = False
        try:
            while process.poll() is None and time.monotonic() - started < 25:
                text = plain(data)
                if not typed and 'Connect a provider' in text and time.monotonic() - started >= 3:
                    os.write(master, b'/jetbrains')
                    typed = True
                if typed and not submitted and 'JetBrains: account and credits' in text and 'JetBrains: refresh credits' in text:
                    os.write(master, b'\r')
                    submitted = True
                if submitted and 'Not connected. Use /connect and select JetBrains AI.' in text:
                    print('PASS: both JetBrains slash commands are available while typing; status dialog opens.')
                    return
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    try:
                        data += os.read(master, 262144)
                    except OSError:
                        break
            raise AssertionError(f'TUI status command failed: typed={typed}, submitted={submitted}')
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
