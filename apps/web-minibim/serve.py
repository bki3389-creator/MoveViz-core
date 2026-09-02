# PlanShot 미니BIM 개발 서버 — 캐시 금지 헤더 포함 (파일 수정이 즉시 반영되게)
# 사용: py -3 serve.py  →  http://localhost:8899
import http.server, functools, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
ROOT = os.path.dirname(os.path.abspath(__file__))

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 조용히

if __name__ == '__main__':
    os.chdir(ROOT)
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(('0.0.0.0', PORT), handler) as httpd:
        print(f'미니BIM 서버: http://localhost:{PORT} (Ctrl+C 종료)')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
