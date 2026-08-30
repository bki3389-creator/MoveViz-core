#!/usr/bin/env python3
"""movemate MVP 로컬 서버 — 캐시 비활성(no-store).
브라우저가 예전 파일을 캐싱해 '갑자기 안 됨'이 생기는 걸 막는다.
실행: python3 serve.py   → http://localhost:8777
"""
import http.server, socketserver, os

PORT = 8777
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()
    def log_message(self, *a):  # 조용히
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), NoCache) as httpd:
    print(f"✅ movemate MVP → http://localhost:{PORT}  (캐시 비활성)")
    httpd.serve_forever()
