"""Scan staged/working tracked files and nonignored untracked publication candidates.

No credential values are printed. Pattern checks supplement Gitleaks history scans;
opaque credentials cannot all be recognised from their shape alone.
"""
from pathlib import Path
import math
import os
import re
import subprocess
import sys
from collections import Counter

# Exact fictional values, restricted to files that deliberately define fixtures.
# Split strings keep the scanner's own policy from resembling account captures.
FIXTURES = {
    'apps/android/app/src/main/java/au/com/vodalens/LensViewModel.kt': {'0400' + '000101', '0400' + '000102', '0400' + '000103'},
    'apps/android/app/src/test/java/au/com/vodalens/DomainTest.kt': {'0400' + '000101', '0400' + '000102'},
    'services/api/tests/http.test.cjs': {'0400' + '000001'},
    'services/api/tests/renewal-research.test.cjs': {'0400' + '000001'},
    'services/api/tests/store.test.cjs': {'0400' + '000001'},
    'tests/api.test.cjs': {'0400' + '000001'},
    'tests/core.test.cjs': {'0400' + '000001', '0400' + '000002', '0499' + '999999'},
}
PHONE = re.compile(rb'(?<![A-Za-z0-9])(?:\+?61[ ()-]*4|0[ ()-]*4)(?:[ ()-]*\d){8}(?![A-Za-z0-9])')
PATTERNS = [
    rb'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}',
    rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
    rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b',
    rb'\bv1\.[A-Za-z0-9_-]{24,}\b',  # Auth0 opaque refresh-token form
]
ASSIGNMENT = re.compile(rb'''(?i)(?:refresh_?token|refreshToken|refresh|access_?token|accessToken|access|backendToken|apiToken|api_key|client_secret|VODALENS_API_TOKEN|VODALENS_VAULT_KEY)["']?\s*[:=]\s*["']([A-Za-z0-9_+/=.\-]{20,})["']''')

def forbidden(path):
    return (
        any(part in {'.data', 'local-data', 'output', '.gradle', '.kotlin', 'build', 'node_modules'} for part in path.parts)
        or (path.name.startswith('.env') and path.name != '.env.example')
        or path.suffix.lower() in {'.jks', '.keystore', '.p12', '.pfx', '.key', '.pem', '.har', '.apk', '.aab', '.sqlite', '.db'}
        or bool(re.search(r'\.(?:sqlite|db)-(?:wal|shm)$', path.name, re.I))
        or path.name in {'local.properties', 'local-config.json'}
    )

def entropy(value):
    return -sum((n / len(value)) * math.log2(n / len(value)) for n in Counter(value).values())

def reasons(name, data, known):
    result = set()
    if any(value in data for value in known) or any(re.search(pattern, data) for pattern in PATTERNS):
        result.add('possible credential')
    if any(entropy(m[1]) >= 4.0 for m in ASSIGNMENT.finditer(data)):
        result.add('possible opaque credential assignment')
    for match in PHONE.finditer(data):
        number = re.sub(rb'\D', b'', match[0]).decode()
        if number.startswith('61'):
            number = '0' + number[2:]
        if number not in FIXTURES.get(name, set()):
            result.add('possible personal service number')
    return result

def main():
    root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    paths = set(filter(None, subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')))
    tracked = set(filter(None, subprocess.check_output(['git', 'ls-files', '--cached', '-z'], cwd=root).decode().split('\0')))
    known = []
    env = root / '.env'
    if env.is_file():
        for line in env.read_text().splitlines():
            match = re.match(r'^(VODALENS_API_TOKEN|VODALENS_VAULT_KEY|VODAFONE_CLIENT_SECRET)=(.+)$', line)
            if match:
                value = match[2].strip().strip('\"\x27')
                if len(value) >= 16:
                    known.append(value.encode())
    failures = set()
    for name in paths:
        path = Path(name)
        if forbidden(path):
            failures.add((name, 'private/generated path'))
        file = root / path
        if file.is_symlink():
            failures.add((name, 'symlink requires manual publication review'))
            continue
        snapshots = []
        if file.is_file():
            snapshots.append(file.read_bytes())
        if name in tracked:
            staged = subprocess.run(['git', 'show', ':' + name], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            if staged.returncode == 0:
                snapshots.append(staged.stdout)
        for data in snapshots:
            failures.update((name, reason) for reason in reasons(name, data, known))
    if failures:
        for name, reason in sorted(failures):
            print(f'{name}: {reason}', file=sys.stderr)
        return 1
    print(f'Publication check passed for {len(paths)} tracked and nonignored untracked candidates (working tree and index).')
    return 0

if __name__ == '__main__':
    sys.exit(main())
