# -*- coding: utf-8 -*-
"""
API 试电笔  ·  启动器

1. 起本地后端 (仅 127.0.0.1, 随机端口)
2. 用 pywebview (Edge WebView2) 开一个原生窗口
3. 若 pywebview 不可用, 退化为系统默认浏览器打开

纯本地运行, 无遥测。
"""
import os
import socket
import sys
import threading
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import server  # noqa: E402

APP_TITLE = "API 试电笔 · OpenAI Compatible Tester"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    port = free_port()
    httpd = server.serve(port)
    url = "http://127.0.0.1:%d/" % port
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    # 等端口真的可用
    for _ in range(50):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                break
        except OSError:
            time.sleep(0.05)

    try:
        import webview  # pywebview
        webview.create_window(APP_TITLE, url, width=1280, height=840,
                              min_size=(1000, 660), text_select=True)
        webview.start()
    except Exception as e:
        sys.stderr.write("pywebview 不可用 (%s), 回退到系统浏览器\n" % e)
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main()
