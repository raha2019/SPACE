"""Dev server for SPACE v3 — serves the v3/ folder on :8123 with caching
disabled so edits show up on reload. Recreated after launch.json was removed."""
import http.server as H, socketserver as SC, os, sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "v3")
os.chdir(ROOT)


class NoCache(H.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        sys.stderr.write("%s - %s\n" % (self.address_string(), a[0] % a[1:]))


SC.ThreadingTCPServer.allow_reuse_address = True
with SC.ThreadingTCPServer(("127.0.0.1", 8123), NoCache) as httpd:
    sys.stderr.write("SPACE v3 serving %s on http://127.0.0.1:8123\n" % ROOT)
    httpd.serve_forever()
