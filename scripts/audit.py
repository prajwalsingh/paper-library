#!/usr/bin/env python3
"""Shows exactly what Paper Library can access and contact, so you can check
the "no data sharing" claim yourself instead of trusting it.

    python3 scripts/audit.py             # permissions + every website the code can reach
    python3 scripts/audit.py --libs      # also prove the bundled PDF.js / pdf-lib are
                                         # byte-for-byte the official npm releases (needs npm)
"""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OWN_CODE = sorted([*ROOT.glob('*.js'), *ROOT.glob('js/*.js'), *ROOT.glob('*.html')])


def section(title):
    print(f'\n== {title} ' + '=' * max(0, 66 - len(title)))


manifest = json.loads((ROOT / 'manifest.json').read_text())
csp = manifest['content_security_policy']['extension_pages']
directives = dict((d.split()[0], d.split()[1:]) for d in csp.split(';') if d.strip())
connect = [s for s in directives.get('connect-src', []) if s.startswith('https://')]

section('Chrome permissions (manifest.json)')
print('permissions:     ', ', '.join(manifest.get('permissions', [])))
print('host_permissions:', ', '.join(manifest.get('host_permissions', [])))
for cs in manifest.get('content_scripts', []):
    print('content script:  ', ', '.join(cs['js']), 'on', ', '.join(cs['matches']))

section('Network lock (Content Security Policy, enforced by Chrome)')
print('The extension\'s pages can only connect to its own files and:')
for s in connect:
    print('   ', s)
for d in ('default-src', 'img-src', 'font-src', 'frame-src', 'form-action'):
    print(f'{d}: {" ".join(directives.get(d, ["(not set)"]))}')
print('Any other request (fetch, XHR, image, beacon, frame, form) is refused by Chrome,')
print('including from the bundled third-party libraries.')

section('Websites mentioned in our own code')
url_re = re.compile(r'https?://([a-zA-Z0-9.-]+\.[a-z]{2,})')
found = {}
for f in OWN_CODE:
    for n, line in enumerate(f.read_text(errors='ignore').splitlines(), 1):
        for host in url_re.findall(line):
            if host in ('www.w3.org',):  # XML namespace strings, not requests
                continue
            found.setdefault(host, []).append(f'{f.relative_to(ROOT)}:{n}')
def allowed_by_lock(host):
    for src in connect:
        h = src.split('//')[1].split('/')[0]
        # "*.sharepoint.com" allows any sub-domain of sharepoint.com (Microsoft's storage servers)
        if host == h or (h.startswith('*.') and host.endswith(h[1:])):
            return True
    return False


for host, where in sorted(found.items()):
    allowed = allowed_by_lock(host)
    kind = 'data connection (allowed by the lock)' if allowed else 'link / sign-in page only (no data sent by code)'
    print(f'{host:28} {kind}')
    for w in where[:4]:
        print(f'{"":30}{w}')
unexpected = [h for h in found if not allowed_by_lock(h)
              and h not in ('drive.google.com', 'accounts.google.com', 'console.cloud.google.com',
                            'github.com', 'myaccount.google.com',
                            'entra.microsoft.com', 'account.live.com', 'myapps.microsoft.com', 'onedrive.live.com',
                            # links written into exported Markdown notes (js/export.js), never fetched
                            'doi.org', 'arxiv.org')]
print('\nUnexpected hosts:', ', '.join(unexpected) if unexpected else 'none')

section('Network calls in our own code')
api_re = re.compile(r'\b(fetch\(|fetchImpl\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|launchWebAuthFlow|window\.open\()')
for f in OWN_CODE:
    for n, line in enumerate(f.read_text(errors='ignore').splitlines(), 1):
        if api_re.search(line) and not line.strip().startswith('//'):
            print(f'{str(f.relative_to(ROOT)) + ":" + str(n):32} {line.strip()[:90]}')

if '--libs' in sys.argv:
    section('Bundled libraries vs. official npm releases')
    checks = {
        'pdfjs-dist@4.10.38': {
            'lib/pdfjs/pdf.min.mjs': 'build/pdf.min.mjs',
            'lib/pdfjs/pdf.worker.min.mjs': 'build/pdf.worker.min.mjs',
            'lib/pdfjs/pdf_viewer.mjs': 'web/pdf_viewer.mjs',
            'lib/pdfjs/pdf_viewer.css': 'web/pdf_viewer.css',
            'lib/pdfjs/LICENSE': 'LICENSE',
            'lib/pdfjs/cmaps/': 'cmaps/',
            'lib/pdfjs/standard_fonts/': 'standard_fonts/',
            'lib/pdfjs/images/': 'web/images/',
        },
        'pdf-lib@1.17.1': {
            'lib/pdf-lib/pdf-lib.esm.min.js': 'dist/pdf-lib.esm.min.js',
            'lib/pdf-lib/LICENSE.md': 'LICENSE.md',
        },
    }
    sha = lambda b: hashlib.sha256(b).hexdigest()
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        for pkg, mapping in checks.items():
            out = subprocess.run(['npm', 'pack', pkg, '--silent'], cwd=tmp, capture_output=True, text=True)
            if out.returncode:
                print(f'could not download {pkg}: {out.stderr.strip()}')
                ok = False
                continue
            with tarfile.open(pathlib.Path(tmp) / out.stdout.strip().splitlines()[-1]) as tar:
                files = {m.name[len('package/'):]: tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}
            count = 0
            for local, remote in mapping.items():
                if local.endswith('/'):
                    for p in sorted((ROOT / local).rglob('*')):
                        if p.is_file():
                            rel = remote + str(p.relative_to(ROOT / local))
                            same = rel in files and sha(files[rel]) == sha(p.read_bytes())
                            ok &= same
                            count += 1
                            if not same:
                                print(f'  DIFFERENT: {p.relative_to(ROOT)}')
                else:
                    same = sha(files.get(remote, b'?')) == sha((ROOT / local).read_bytes())
                    ok &= same
                    count += 1
                    if not same:
                        print(f'  DIFFERENT: {local}')
            print(f'{pkg:22} {count} files checked')
    print('Result:', 'all bundled library files are identical to the official npm releases'
          if ok else 'MISMATCH (see above)')
