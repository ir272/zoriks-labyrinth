#!/usr/bin/env python3
"""Dev server for Dim Halls that disables caching, so every edit loads fresh.
Usage:  python3 serve.py [port]   (default 8080)  ->  open http://localhost:<port>
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"Dim Halls (no-cache) → http://localhost:{port}")
    HTTPServer(("", port), NoCacheHandler).serve_forever()
