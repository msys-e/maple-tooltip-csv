# ローカル配信用の簡易サーバ。
# python -m http.server はキャッシュ抑止ヘッダを出さないため、JSを更新しても
# ブラウザが古いモジュールを使い続けることがある(ESモジュールは import 先も個別にキャッシュされる)。
# 開発中は常に取り直させたいので no-store を付けて配信する。
import functools
import http.server

PORT = 8471


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    handler = functools.partial(NoCacheHandler, directory='.')
    with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler) as httpd:
        print(f'Serving http://localhost:{PORT}/ (no-store). Ctrl+C to stop.')
        httpd.serve_forever()
