#!/usr/bin/env python3
"""Install the bank voice route without changing other shared edge sites."""
import os
from pathlib import Path
import re
import subprocess
import tempfile

source = Path('/opt/premsir-chat/source/Caddyfile.production')
original = source.read_text()
pattern = re.compile(r'^bank\.jung\.edu\.pl\s*\{.*?^\}', re.M | re.S)
matches = list(pattern.finditer(original))
if len(matches) != 1:
    raise SystemExit('Expected exactly one bank edge site')
block = matches[0].group()
block = block.replace('microphone=()', 'microphone=(self)')
if '@bankVoice path /api/voice/live' not in block:
    proxy = 'reverse_proxy bankpilot-app:3000'
    if block.count(proxy) != 1:
        raise SystemExit('Expected exactly one application proxy')
    block = block.replace(proxy, '@bankVoice path /api/voice/live\n\treverse_proxy @bankVoice bankpilot-voice:3011\n\t' + proxy)
updated = original[:matches[0].start()] + block + original[matches[0].end():]
container = 'premsir-chat-caddy-1'
candidate = '/config/bankpilot-edge.Caddyfile'
with tempfile.NamedTemporaryFile(mode='w', prefix='bankpilot-edge-', delete=False) as handle:
    temporary = Path(handle.name)
    handle.write(updated)
try:
    subprocess.run(['docker', 'cp', str(temporary), container + ':' + candidate], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['docker', 'exec', container, 'caddy', 'validate', '--config', candidate, '--adapter', 'caddyfile'], check=True, stdout=subprocess.DEVNULL)
    if source.read_text() != original:
        raise SystemExit('Shared edge configuration changed during deployment')
    # Keep the source inode for existing file mounts; reload a validated complete copy.
    with source.open('w') as handle:
        handle.write(updated)
        handle.flush()
        os.fsync(handle.fileno())
    subprocess.run(['docker', 'exec', container, 'caddy', 'reload', '--config', candidate, '--adapter', 'caddyfile'], check=True, stdout=subprocess.DEVNULL)
    print('Bank voice edge route installed')
finally:
    temporary.unlink(missing_ok=True)
