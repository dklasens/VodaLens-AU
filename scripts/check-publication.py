"""Check Git-selected publication files without printing credential values."""
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
failures = []
secrets = []
env = root / '.env'
if env.exists():
    for line in env.read_text().splitlines():
        match = re.match(r'^(VODALENS_API_TOKEN|VODALENS_VAULT_KEY|VODAFONE_CLIENT_SECRET)=(.+)$', line)
        if match:
            value = match[2].strip().strip('\"\x27')
            if len(value) >= 16:
                secrets.append(value.encode())
patterns = [
    rb'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}',
    rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
    rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,}|AKIA[A-Z0-9]{16})\b',
]
for name in filter(None, paths):
    path = Path(name)
    if any(part in {'.data', 'local-data', 'output', '.gradle', '.kotlin', 'build', 'node_modules'} for part in path.parts) or (path.name.startswith('.env') and path.name != '.env.example') or path.suffix in {'.jks', '.keystore', '.p12', '.pfx', '.key', '.pem', '.har', '.sqlite'} or path.name == 'local.properties':
        failures.append((name, 'private/generated path'))
    data = (root / path).read_bytes()
    if any(value in data for value in secrets) or any(re.search(pattern, data) for pattern in patterns):
        failures.append((name, 'possible credential'))
if failures:
    for name, reason in failures:
        print(f'{name}: {reason}', file=sys.stderr)
    sys.exit(1)
print(f'Publication check passed for {sum(bool(p) for p in paths)} Git-selected files.')
