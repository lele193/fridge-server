#!/usr/bin/env python3
"""
ghproxy_local.py —— 本地转发器，把 GitHub 下载改道到 gh-proxy.com。

为什么需要：ESP-IDF 的 install.sh 用 urllib 下载工具链，直连 GitHub 在国内
极慢甚至超时。gh-proxy.com 是**路径前缀式**代理（不是 HTTP CONNECT 代理），
所以 HTTPS_PROXY 环境变量对它无效。

做法：监听本地端口并支持 CONNECT。urllib 发 CONNECT 时会认为对端是隧道终点，
但我们用自签证书把 TLS 终结在本地，拿到明文请求后**剥掉本地那段 host**、
拼上代理前缀重新发出去。urllib 这边看到的是一次成功的 TLS 握手，
拿到的是代理转发的真实响应 —— 它不会察觉中间做了改写。

只用于下载工具链，不涉及任何凭据。

用法：
    python3 ghproxy_local.py 8899 &
    export HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899
"""

import os
import socket
import ssl
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "https://gh-proxy.com/"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
CERT_DIR = os.path.expanduser("~/.local/ghproxy-cert")


def ensure_cert():
    """自签证书。CN 必须是主机名，客户端才会认为 TLS 正常。"""
    os.makedirs(CERT_DIR, exist_ok=True)
    key = os.path.join(CERT_DIR, "key.pem")
    crt = os.path.join(CERT_DIR, "cert.pem")
    if os.path.exists(key) and os.path.exists(crt):
        return key, crt
    # openssl 的 SAN 覆盖 github.com 与通用名，urllib 只校验主机名
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-keyout", key, "-out", crt, "-days", "3650",
         "-subj", "/CN=github.com",
         "-addext", "subjectAltName=DNS:github.com,DNS:*.github.com,DNS:localhost,IP:127.0.0.1"],
        check=True, capture_output=True,
    )
    return key, crt


CERT_KEY, CERT_CRT = ensure_cert()


def fetch(url, method="GET"):
    """通过代理前缀取回资源，返回 (status, headers, body)。"""
    req = urllib.request.Request(PREFIX + url, headers={"User-Agent": "curl/8"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def serve_https(conn):
    """CONNECT 之后：TLS 终结在本地，然后按普通 HTTP 请求转发。"""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT_CRT, CERT_KEY)
    try:
        tls = ctx.wrap_socket(conn, server_side=True)
    except Exception:
        conn.close()
        return

    try:
        f = tls.makefile("rb")
        line = f.readline().decode("latin1").strip()
        if not line:
            tls.close()
            return
        parts = line.split()
        if len(parts) < 2:
            tls.close()
            return
        method, path = parts[0], parts[1]

        headers = {}
        while True:
            h = f.readline()
            if h in (b"\r\n", b"\n", b""):
                break
            k, _, v = h.decode("latin1").partition(":")
            headers[k.strip().lower()] = v.strip()

        # 剥掉 scheme://host 那一段，只留路径与查询
        path_only = path
        if path.startswith("http"):
            rest = path.split("://", 1)[1]
            slash = rest.find("/")
            path_only = rest[slash:] if slash >= 0 else "/"

        body = b""
        if headers.get("transfer-encoding", "").lower() == "chunked":
            while True:
                size = int(f.readline().strip() or b"0", 16)
                if size == 0:
                    f.readline()
                    break
                body += f.read(size)
                f.readline()
        else:
            n = int(headers.get("content-length", 0) or 0)
            if n:
                body = f.read(n)

        status, rheaders, data = fetch(path_only, method)

        out = [f"HTTP/1.1 {status} X\r\n".encode()]
        ctype = rheaders.get("Content-Type", "application/octet-stream")
        out.append(f"Content-Type: {ctype}\r\n".encode())
        out.append(f"Content-Length: {len(data)}\r\n".encode())
        out.append(b"Connection: close\r\n\r\n")
        out.append(data)
        tls.sendall(b"".join(out))
    except Exception:
        pass
    finally:
        try:
            tls.close()
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _plain(self):
        """纯 HTTP（少用）：路径已是完整的 https URL，需要拆开。"""
        path = self.path
        if path.startswith("http"):
            rest = path.split("://", 1)[1]
            slash = rest.find("/")
            url = rest[slash:] if slash >= 0 else "/"
        else:
            url = path
        status, h, body = fetch(url, self.command)
        self.send_response(status)
        self.send_header("Content-Type", h.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _plain
    do_HEAD = _plain

    def do_CONNECT(self):
        self.send_response(200, "Connection Established")
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        # 交接底层 socket 给 TLS 处理
        threading.Thread(
            target=serve_https, args=(self.connection,), daemon=True
        ).start()
        # 避免基类在返回时关掉 socket
        self.connection = socket.socket()


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"本地代理: http://127.0.0.1:{PORT} → {PREFIX}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
