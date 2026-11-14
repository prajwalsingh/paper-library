"""Local dev server: serves the extension folder so viewer.html and library.html
can run in a normal browser tab with a fake Drive (dev/mock-backend.js).

    python3 dev/serve.py            # then open http://127.0.0.1:8765/library.html
                                    # or http://127.0.0.1:8765/viewer.html?src=/sample.pdf
/sample.pdf is docs/demo-paper.pdf (or pass another PDF path as an argument).
"""
import functools
import http.server
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs', 'demo-paper.pdf')
PORT = 8765
# Send the extension's own Content Security Policy, so demo mode is subject to the
# same network lock as the installed extension ('self' = this local server).
CSP = json.load(open(os.path.join(ROOT, 'manifest.json')))['content_security_policy']['extension_pages']


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.mjs': 'text/javascript', '.js': 'text/javascript'}

    def translate_path(self, path):
        if path.split('?')[0] == '/sample.pdf':
            return SAMPLE
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        if self.path.split('?')[0].endswith('.html'):
            self.send_header('Content-Security-Policy', CSP)
        super().end_headers()


print(f'Serving {ROOT} on http://127.0.0.1:{PORT}/library.html')
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT)).serve_forever()
