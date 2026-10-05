# -*- coding: utf-8 -*-
"""
OpenAI Compatible API Tester  --  本地后端 (纯标准库, 无第三方依赖)

职责:
  * 提供本地 HTTP 服务 (仅监听 127.0.0.1), 前端页面由它托管
  * 代理所有对上游 API 的请求 (绕开浏览器 CORS, 且能精确测量 TTFT)
  * 配置 / 日志 只落本机 %APPDATA%\\OpenAIAPITester
  * 任何日志/错误中都不出现真实 API Key (统一脱敏)

除用户主动配置的 API 地址外, 不连接任何第三方服务器; 无遥测.
"""
import json
import os
import re
import sys
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "OpenAIAPITester"
HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
VERSION = "1.1.0"


def data_dir():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, APP_NAME)
    os.makedirs(d, exist_ok=True)
    return d


DATA = data_dir()
CFG_FILE = os.path.join(DATA, "configs.json")
LOG_FILE = os.path.join(DATA, "logs.json")
_LOCK = threading.Lock()
MAX_LOGS = 200

DEFAULT_STATE = {
    "configs": [],
    "active_id": None,
    "theme": "light",
    "test_prompt": "只回复 OK",
    "test_count": 1,
    "stream": True,
}


# --------------------------------------------------------------------------- #
# 存储
# --------------------------------------------------------------------------- #
def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_state():
    st = dict(DEFAULT_STATE)
    st.update(_read_json(CFG_FILE, {}))
    st.setdefault("configs", [])
    return st


def save_state(payload):
    st = load_state()
    for k in ("configs", "active_id", "theme", "test_prompt", "test_count", "stream"):
        if k in payload:
            st[k] = payload[k]
    _write_json(CFG_FILE, st)
    return st


def load_logs():
    return _read_json(LOG_FILE, [])


def push_log(entry):
    with _LOCK:
        logs = _read_json(LOG_FILE, [])
        logs.insert(0, entry)
        del logs[MAX_LOGS:]
        try:
            _write_json(LOG_FILE, logs)
        except Exception:
            pass


def clear_logs():
    with _LOCK:
        try:
            _write_json(LOG_FILE, [])
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# 脱敏  --  日志里绝不出现真实 Key
# --------------------------------------------------------------------------- #
def mask_key(k):
    if not k:
        return "****"
    k = str(k)
    if len(k) <= 8:
        return "****"
    return k[:3] + "****" + k[-4:]


_SECRET_PATTERNS = [
    (re.compile(r"(?i)(bearer\s+)([A-Za-z0-9_\-\.]{6,})"), lambda m: m.group(1) + mask_key(m.group(2))),
    (re.compile(r"(?i)(\"?(?:api[_-]?key|apikey|authorization|access[_-]?token|secret[_-]?key)\"?\s*[:=]\s*\"?)(?!Bearer\b|Basic\b)([A-Za-z0-9_\-\.]{6,})"),
     lambda m: m.group(1) + mask_key(m.group(2))),
    (re.compile(r"(?i)([?&](?:key|api_key|token)=)([A-Za-z0-9_\-\.]{6,})"), lambda m: m.group(1) + mask_key(m.group(2))),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{6,}"), lambda m: mask_key(m.group(0))),
]


def scrub(text, key=None):
    """把任何密钥痕迹清掉。key 为本次使用的真实 key, 优先整体替换。"""
    out = "" if text is None else str(text)
    if key:
        try:
            out = out.replace(key, mask_key(key))
        except Exception:
            pass
    for pat, rep in _SECRET_PATTERNS:
        try:
            out = pat.sub(rep, out)
        except Exception:
            pass
    return out


def scrub_headers(headers, key=None):
    safe = {}
    for k, v in (headers or {}).items():
        if k.lower() in ("authorization", "x-api-key", "api-key", "proxy-authorization"):
            safe[k] = "Bearer " + mask_key(key) if key else "$API_KEY"
        else:
            safe[k] = scrub(v, key)
    return safe


# --------------------------------------------------------------------------- #
# Base URL 兼容处理
# --------------------------------------------------------------------------- #
_ENDPOINT_SUFFIXES = (
    "/chat/completions", "/completions", "/models", "/embeddings",
    "/responses", "/images/generations",
)


def normalize_base(url):
    """把用户填的 Base URL 规整成 {scheme}://{host}[/path][/v1] 形式。

    容忍: https://x.com | https://x.com/ | https://x.com/v1 | https://x.com/v1/chat/completions
    """
    url = (url or "").strip().strip('"').strip("'")
    if not url:
        raise ValueError("Base URL 为空")
    if "://" not in url:
        url = "https://" + url
    p = urllib.parse.urlsplit(url)
    if not p.netloc:
        raise ValueError("Base URL 不合法: %s" % url)
    path = (p.path or "").rstrip("/")
    for suf in _ENDPOINT_SUFFIXES:
        if path.lower().endswith(suf):
            path = path[: -len(suf)]
            break
    path = path.rstrip("/")
    if re.search(r"/v\d+[a-z]*$", path):
        base_path = path
    elif path:
        base_path = path + "/v1"
    else:
        base_path = "/v1"
    return urllib.parse.urlunsplit((p.scheme, p.netloc, base_path, "", ""))


def base_candidates(base):
    """模型列表探测用的候选 Base (有些服务不在 /v1 下挂 /models)。"""
    out = [base]
    p = urllib.parse.urlsplit(base)
    alt = p.path
    if alt.endswith("/v1"):
        alt2 = alt[:-3]
    else:
        alt2 = alt + "/v1"
    cand = urllib.parse.urlunsplit((p.scheme, p.netloc, alt2, "", ""))
    if cand not in out:
        out.append(cand)
    return out


# --------------------------------------------------------------------------- #
# 上游请求
# --------------------------------------------------------------------------- #
def make_opener(proxy=None):
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    else:
        handlers.append(urllib.request.ProxyHandler({}))  # 明确不继承环境代理
    ctx = None
    try:
        import ssl
        ctx = ssl.create_default_context()
    except Exception:
        ctx = None
    if ctx is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


class UpstreamError(Exception):
    def __init__(self, kind, message, status=None, body=None):
        super().__init__(message)
        self.kind = kind          # http / network / timeout / dns / parse / config
        self.message = message
        self.status = status
        self.body = body


def classify_network_error(exc):
    reason = getattr(exc, "reason", None)
    txt = str(reason or exc)
    low = txt.lower()
    if "timed out" in low or "timeout" in low or "10060" in low or "超时" in txt:
        return "timeout", "连接服务器超时: " + txt
    if "getaddrinfo" in low or "name or service not known" in low or "nodename" in low \
            or "11001" in low or "找不到" in txt or "解析" in txt:
        return "dns", "域名解析失败 (检查 Base URL 主机名 / 网络): " + txt
    if "refused" in low or "10061" in low or "拒绝" in txt:
        return "network", "连接被拒绝 (端口未开放 / 服务未启动): " + txt
    if "certificate" in low or "ssl" in low or "证书" in txt:
        return "network", "TLS/证书错误: " + txt
    if "reset" in low or "10054" in low or "10053" in low:
        return "network", "连接被重置 (上游或中间设备掐断): " + txt
    if "unreachable" in low or "10051" in low or "10065" in low:
        return "network", "网络不可达: " + txt
    return "network", "网络错误: " + txt


HTTP_HINTS = {
    400: "请求参数被服务器拒绝 (400 Bad Request)",
    401: "API Key 无效或未提供 (401 Unauthorized)",
    402: "余额/配额不足 (402 Payment Required)",
    403: "无权限访问 (403 Forbidden)",
    404: "路径不存在, 检查 Base URL 是否需要 /v1 (404 Not Found)",
    405: "方法不被允许 (405)",
    408: "服务器处理超时 (408)",
    413: "请求体过大 (413)",
    422: "请求体格式不被接受 (422)",
    429: "触发限流 / 超出速率限制 (429)",
    500: "上游服务器内部错误 (500)",
    502: "网关错误, 上游返回异常 (502 Bad Gateway)",
    503: "服务不可用 / 无可用渠道 (503 Service Unavailable)",
    504: "网关超时 (504 Gateway Timeout)",
}


def http_error_message(status, reason, body_text):
    hint = HTTP_HINTS.get(status, "")
    detail = ""
    if body_text:
        detail = extract_api_error(body_text)
    msg = "%s %s" % (status, reason or "")
    msg = msg.strip()
    if hint:
        msg += "  ·  " + hint
    if detail:
        msg += "\n" + detail
    return msg


def extract_api_error(text):
    """尽量把服务器原始错误信息挖出来, 而不是笼统的'请求失败'。"""
    if not text:
        return ""
    try:
        j = json.loads(text)
        if isinstance(j, dict):
            err = j.get("error")
            if isinstance(err, dict):
                m = err.get("message") or err.get("msg")
                if m:
                    t = err.get("type") or err.get("code")
                    return "[%s] %s" % (t, m) if t else str(m)
            if isinstance(err, str) and err:
                return err
            for k in ("message", "msg", "detail", "error_description"):
                if isinstance(j.get(k), str) and j.get(k):
                    return j[k]
    except Exception:
        pass
    return text.strip()[:600]


def build_headers(api_key, extra=None):
    h = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "OpenAI-APITester/%s" % VERSION,
    }
    if api_key:
        h["Authorization"] = "Bearer " + api_key
    if extra:
        h.update(extra)
    return h


# --------------------------------------------------------------------------- #
# 核心: 单次测试 (精确测 TTFT)
# --------------------------------------------------------------------------- #
CJK_RE = re.compile(r"[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]")


def estimate_tokens(text):
    """仅在服务端未返回 usage 时用于粗略展示, 一律标注为估算。"""
    if not text:
        return 0
    cjk = len(CJK_RE.findall(text))
    other = len(text) - cjk
    return max(1, int(round(cjk / 1.5 + other / 4.0)))


def run_test(base, api_key, model, prompt, stream=True, proxy=None,
             timeout=90, system=None, max_tokens=None):
    """返回 dict: ok/status/ttft_ms/total_ms/usage/tps/text/error..."""
    url = base.rstrip("/") + "/chat/completions"
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    body = {"model": model, "messages": messages}
    if stream:
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
    if max_tokens:
        body["max_tokens"] = int(max_tokens)

    req_headers = build_headers(api_key, {"Accept": "text/event-stream" if stream else "application/json"})

    result = {
        "ok": False, "status": None, "stream": bool(stream),
        "ttft_ms": None, "total_ms": None,
        "usage": {"prompt_tokens": None, "completion_tokens": None, "total_tokens": None},
        "usage_estimated": False, "tps": None, "tps_estimated": False,
        "text": "", "reasoning": "", "finish_reason": None,
        "error_kind": None, "error": None, "raw": "",
        "request": {"method": "POST", "url": url,
                    "headers": scrub_headers(req_headers, api_key),
                    "body": scrub(json.dumps(body, ensure_ascii=False), api_key)},
    }

    def attempt(bd):
        opener = make_opener(proxy)
        data = json.dumps(bd, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
        t0 = time.perf_counter()
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            raw = ""
            try:
                raw = e.read().decode("utf-8", "replace")
            except Exception:
                pass
            raise UpstreamError("http", http_error_message(e.code, e.reason, raw),
                                status=e.code, body=scrub(raw, api_key))
        except urllib.error.URLError as e:
            k, m = classify_network_error(e)
            raise UpstreamError(k, m)
        except TimeoutError:
            raise UpstreamError("timeout", "连接服务器超时 (%.0fs)" % timeout)
        except Exception as e:  # noqa
            raise UpstreamError("network", "请求异常: %s" % e)

        status = getattr(resp, "status", None) or resp.getcode()
        t_first = None
        text_parts, reason_parts = [], []
        buf = ""
        usage = None
        finish = None

        if stream:
            while True:
                chunk = resp.read(2048)
                if not chunk:
                    break
                buf += chunk.decode("utf-8", "replace")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip("\r").strip()
                    if not line:
                        continue
                    if line.startswith("data:"):
                        payload = line[5:].strip()
                    elif line.startswith("{"):
                        payload = line            # 少数服务端直接吐裸 JSON
                    else:
                        continue
                    if payload in ("[DONE]", "[done]"):
                        continue
                    try:
                        obj = json.loads(payload)
                    except Exception:
                        continue
                    if isinstance(obj, dict) and obj.get("usage"):
                        usage = obj["usage"]
                    for ch in (obj.get("choices") or []) if isinstance(obj, dict) else []:
                        d = ch.get("delta") or {}
                        c = d.get("content")
                        r = d.get("reasoning_content") or d.get("reasoning")
                        if isinstance(c, str) and c:
                            if t_first is None:
                                t_first = time.perf_counter()
                            text_parts.append(c)
                        elif isinstance(r, str) and r:
                            if t_first is None:
                                t_first = time.perf_counter()
                            reason_parts.append(r)
                        if ch.get("finish_reason"):
                            finish = ch["finish_reason"]
                    if isinstance(obj, dict) and obj.get("error"):
                        raise UpstreamError("parse", "流中返回错误: " + extract_api_error(payload))
            t_total = time.perf_counter()
        else:
            raw = resp.read().decode("utf-8", "replace")
            t_total = time.perf_counter()
            try:
                obj = json.loads(raw)
            except Exception:
                raise UpstreamError("parse", "响应不是合法 JSON: " + raw[:400], status=status)
            if obj.get("error"):
                raise UpstreamError("http", "API 返回错误: " + extract_api_error(raw), status=status)
            usage = obj.get("usage")
            for ch in (obj.get("choices") or []):
                msg = ch.get("message") or {}
                text_parts.append(msg.get("content") or "")
                reason_parts.append(msg.get("reasoning_content") or "")
                finish = ch.get("finish_reason")
            text = "".join(text_parts)
            if text:
                t_first = t_total

        return {
            "status": status, "t_first": t_first, "t_total": t_total,
            "text": "".join(text_parts), "reasoning": "".join(reason_parts),
            "usage": usage, "finish": finish, "t0": t0,
        }

    try:
        try:
            r = attempt(body)
        except UpstreamError as e:
            # stream_options 不被支持时自动降级重试一次
            if e.kind == "http" and "stream_options" in (e.body or "") and stream:
                body.pop("stream_options", None)
                result["request"]["body"] = scrub(json.dumps(body, ensure_ascii=False), api_key)
                r = attempt(body)
            else:
                raise

        result["status"] = r["status"]
        result["total_ms"] = round((r["t_total"] - r["t0"]) * 1000, 1)
        result["ttft_ms"] = round((r["t_first"] - r["t0"]) * 1000, 1) if r["t_first"] else None
        result["text"] = r["text"]
        result["reasoning"] = r["reasoning"]
        result["finish_reason"] = r["finish"]

        u = r["usage"] or {}
        pt = u.get("prompt_tokens") or u.get("input_tokens")
        ct = u.get("completion_tokens") or u.get("output_tokens")
        tt = u.get("total_tokens")
        if pt is None and ct is None:
            result["usage_estimated"] = True
            pt = estimate_tokens(prompt)
            ct = estimate_tokens(r["text"])
            tt = (pt or 0) + (ct or 0)
        else:
            if tt is None:
                tt = (pt or 0) + (ct or 0)
        result["usage"] = {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": tt}

        gen_ms = None
        if r["t_first"] is not None:
            gen_ms = (r["t_total"] - r["t_first"]) * 1000.0
        if ct:
            if gen_ms and gen_ms > 1:
                result["tps"] = round(ct / (gen_ms / 1000.0), 2)
            elif not stream:
                # 非流式: 只能拿总耗时作分母, 标注为近似
                result["tps"] = round(ct / (result["total_ms"] / 1000.0), 2)
                result["tps_estimated"] = True
            else:
                result["tps"] = round(ct / (result["total_ms"] / 1000.0), 2)
                result["tps_estimated"] = True
        result["tps_estimated"] = result["tps_estimated"] or result["usage_estimated"]
        result["ok"] = True
        return result
    except UpstreamError as e:
        result["error_kind"] = e.kind
        result["error"] = scrub(e.message, api_key)
        result["status"] = e.status
        result["raw"] = scrub(e.body or "", api_key)
        return result
    except Exception as e:  # noqa
        result["error_kind"] = "internal"
        result["error"] = scrub("本地异常: %s: %s" % (type(e).__name__, e), api_key)
        return result


def list_models(base, api_key, proxy=None, timeout=30):
    """GET {base}/models, 带候选降级。"""
    last = None
    tried = []
    for cand in base_candidates(base):
        url = cand.rstrip("/") + "/models"
        tried.append(url)
        req = urllib.request.Request(url, headers=build_headers(api_key, {"Accept": "application/json"}), method="GET")
        try:
            resp = make_opener(proxy).open(req, timeout=timeout)
            raw = resp.read().decode("utf-8", "replace")
            obj = json.loads(raw)
            items = obj.get("data") if isinstance(obj, dict) else obj
            if isinstance(obj, dict) and items is None:
                items = obj.get("models")
            ids = []
            for it in (items or []):
                if isinstance(it, str):
                    ids.append(it)
                elif isinstance(it, dict):
                    mid = it.get("id") or it.get("name") or it.get("model")
                    if mid:
                        ids.append(str(mid))
            ids = sorted(set(ids), key=lambda s: s.lower())
            if ids:
                return {"ok": True, "models": ids, "url": url, "count": len(ids)}
            last = {"ok": False, "status": 200, "error": "接口返回 200 但模型列表为空", "url": url}
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")
            except Exception:
                pass
            last = {"ok": False, "status": e.code,
                    "error": http_error_message(e.code, e.reason, body),
                    "raw": scrub(body, api_key), "url": url}
            if e.code in (401, 403):
                break
        except urllib.error.URLError as e:
            k, m = classify_network_error(e)
            last = {"ok": False, "error": m, "kind": k, "url": url}
            break
        except Exception as e:  # noqa
            last = {"ok": False, "error": "解析模型列表失败: %s" % e, "url": url}
    out = last or {"ok": False, "error": "无法获取模型列表"}
    out["tried"] = tried
    return out


# --------------------------------------------------------------------------- #
# HTTP 服务
# --------------------------------------------------------------------------- #
CTYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml",
          ".json": "application/json; charset=utf-8", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "APITester/" + VERSION

    def log_message(self, fmt, *args):  # 静音, 不要往控制台喷
        pass

    # -- 工具 -- #
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _sse_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def _sse_send(self, obj):
        data = ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")
        self.wfile.write(data)
        self.wfile.flush()

    # -- 路由 -- #
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/state":
            return self._json(load_state())
        if path == "/api/logs":
            return self._json({"logs": load_logs()})
        if path == "/api/ping":
            return self._json({"ok": True, "version": VERSION, "data_dir": DATA})
        return self._static(path)

    def do_DELETE(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/logs":
            clear_logs()
            return self._json({"ok": True})
        return self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        payload = self._body()
        try:
            if path == "/api/state":
                return self._json({"ok": True, "state": save_state(payload)})
            if path == "/api/models":
                return self._models(payload)
            if path == "/api/test":
                return self._test(payload)
            if path == "/api/chat":
                return self._chat(payload)
        except Exception as e:  # noqa
            return self._json({"ok": False, "error": "本地服务异常: %s" % e}, 500)
        return self._json({"ok": False, "error": "not found"}, 404)

    # -- 静态 -- #
    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self._json({"ok": False, "error": "not found: " + path}, 404)
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", CTYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    # -- /api/models -- #
    def _models(self, p):
        key = (p.get("api_key") or "").strip()
        try:
            base = normalize_base(p.get("base_url"))
        except ValueError as e:
            return self._json({"ok": False, "error": str(e), "kind": "config"})
        res = list_models(base, key, p.get("proxy"), timeout=int(p.get("timeout") or 30))
        res["base"] = base
        return self._json(res)

    # -- /api/test -- #
    def _test(self, p):
        key = (p.get("api_key") or "").strip()
        model = (p.get("model") or "").strip()
        if not model:
            return self._json({"ok": False, "error": "未指定模型 ID", "kind": "config"})
        try:
            base = normalize_base(p.get("base_url"))
        except ValueError as e:
            return self._json({"ok": False, "error": str(e), "kind": "config"})
        r = run_test(base, key, model, p.get("prompt") or "只回复 OK",
                     stream=bool(p.get("stream", True)), proxy=p.get("proxy"),
                     timeout=int(p.get("timeout") or 90),
                     system=p.get("system"), max_tokens=p.get("max_tokens"))
        r["base"] = base
        r["model"] = model
        r["ts"] = time.strftime("%Y-%m-%d %H:%M:%S")
        r["config_name"] = p.get("config_name") or ""
        push_log(build_log_entry(r, key))
        return self._json(r)

    # -- /api/chat (SSE 中继) -- #
    def _chat(self, p):
        key = (p.get("api_key") or "").strip()
        model = (p.get("model") or "").strip()
        if not model:
            return self._json({"ok": False, "error": "未指定模型 ID", "kind": "config"}, 400)
        try:
            base = normalize_base(p.get("base_url"))
        except ValueError as e:
            return self._json({"ok": False, "error": str(e), "kind": "config"}, 400)

        messages = p.get("messages") or []
        stream = bool(p.get("stream", True))
        proxy = p.get("proxy")
        timeout = int(p.get("timeout") or 180)
        url = base.rstrip("/") + "/chat/completions"
        body = {"model": model, "messages": messages}
        if stream:
            body["stream"] = True
        req_headers = build_headers(key, {"Accept": "text/event-stream" if stream else "application/json"})

        log_req = {"method": "POST", "url": url,
                   "headers": scrub_headers(req_headers, key),
                   "body": scrub(json.dumps(body, ensure_ascii=False), key)}
        t0 = time.perf_counter()
        t_first = None
        parts, reason_parts = [], []
        usage = None
        finish = None
        status = None
        err = None
        err_kind = None
        raw_err = ""

        self._sse_start()
        self.close_connection = True
        try:
            opener = make_opener(proxy)
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
            try:
                resp = opener.open(req, timeout=timeout)
                status = getattr(resp, "status", None) or resp.getcode()
            except urllib.error.HTTPError as e:
                raw_err = ""
                try:
                    raw_err = e.read().decode("utf-8", "replace")
                except Exception:
                    pass
                status = e.code
                raise UpstreamError("http", http_error_message(e.code, e.reason, raw_err),
                                    status=e.code, body=raw_err)
            except urllib.error.URLError as e:
                k, m = classify_network_error(e)
                raise UpstreamError(k, m)
            except TimeoutError:
                raise UpstreamError("timeout", "连接服务器超时 (%.0fs)" % timeout)

            self._sse_send({"type": "start", "status": status, "base": base, "model": model})

            if stream:
                buf = ""
                while True:
                    chunk = resp.read(2048)
                    if not chunk:
                        break
                    buf += chunk.decode("utf-8", "replace")
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        line = line.strip("\r").strip()
                        if not line:
                            continue
                        if line.startswith("data:"):
                            payload = line[5:].strip()
                        elif line.startswith("{"):
                            payload = line
                        else:
                            continue
                        if payload in ("[DONE]", "[done]"):
                            continue
                        try:
                            obj = json.loads(payload)
                        except Exception:
                            continue
                        if isinstance(obj, dict) and obj.get("usage"):
                            usage = obj["usage"]
                        for ch in (obj.get("choices") or []):
                            d = ch.get("delta") or {}
                            c = d.get("content")
                            r = d.get("reasoning_content") or d.get("reasoning")
                            if isinstance(c, str) and c:
                                if t_first is None:
                                    t_first = time.perf_counter()
                                parts.append(c)
                                self._sse_send({"type": "delta", "text": c})
                            elif isinstance(r, str) and r:
                                if t_first is None:
                                    t_first = time.perf_counter()
                                reason_parts.append(r)
                                self._sse_send({"type": "reasoning", "text": r})
                            if ch.get("finish_reason"):
                                finish = ch["finish_reason"]
            else:
                raw = resp.read().decode("utf-8", "replace")
                obj = json.loads(raw)
                usage = obj.get("usage")
                for ch in (obj.get("choices") or []):
                    m = ch.get("message") or {}
                    parts.append(m.get("content") or "")
                    finish = ch.get("finish_reason")
                t_first = time.perf_counter()
                self._sse_send({"type": "delta", "text": "".join(parts)})

            t_total = time.perf_counter()
            metrics = finalize_metrics(t0, t_first, t_total, usage, "".join(parts), stream)
            metrics["finish_reason"] = finish
            self._sse_send({"type": "done", **metrics})
        except UpstreamError as e:
            err, err_kind, raw_err = e.message, e.kind, e.body or ""
            try:
                self._sse_send({"type": "error", "kind": err_kind,
                                "status": e.status, "message": scrub(err, key),
                                "raw": scrub(raw_err, key)})
            except Exception:
                pass
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            err, err_kind = "客户端已中断 (停止生成)", "cancel"
        except Exception as e:  # noqa
            err, err_kind = "本地异常: %s: %s" % (type(e).__name__, e), "internal"
            try:
                self._sse_send({"type": "error", "kind": err_kind, "message": scrub(err, key)})
            except Exception:
                pass
        finally:
            try:
                self.wfile.flush()
            except Exception:
                pass
            entry = {
                "id": uuid.uuid4().hex[:12],
                "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                "config_name": p.get("config_name") or "",
                "base_url": base, "model": model, "stream": stream,
                "status": status, "ttft_ms": None, "total_ms": None, "tps": None,
                "ok": err is None, "kind": "chat",
                "usage": None, "usage_estimated": False,
                "request": log_req,
                "response": {"status": status, "body": scrub("".join(parts)[:4000], key)},
                "error": ({"kind": err_kind, "message": scrub(err, key), "body": scrub(raw_err, key)}
                          if err else None),
            }
            push_log(entry)


def finalize_metrics(t0, t_first, t_total, usage, text, stream):
    total_ms = round((t_total - t0) * 1000, 1)
    ttft_ms = round((t_first - t0) * 1000, 1) if t_first else None
    u = usage or {}
    pt = u.get("prompt_tokens") or u.get("input_tokens")
    ct = u.get("completion_tokens") or u.get("output_tokens")
    tt = u.get("total_tokens")
    estimated = False
    if pt is None and ct is None:
        estimated = True
        ct = estimate_tokens(text)
        pt = None
        tt = None
    elif tt is None:
        tt = (pt or 0) + (ct or 0)
    tps = None
    tps_est = estimated
    if ct:
        if t_first is not None and (t_total - t_first) > 0.05:
            tps = round(ct / (t_total - t_first), 2)
        else:
            tps = round(ct / (total_ms / 1000.0), 2) if total_ms else None
            tps_est = True
    return {"ttft_ms": ttft_ms, "total_ms": total_ms,
            "usage": {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": tt},
            "usage_estimated": estimated, "tps": tps, "tps_estimated": tps_est,
            "chars": len(text or "")}


def build_log_entry(r, key):
    req = r.get("request") or {}
    base = r.get("base")
    model = r.get("model")
    if not model:
        try:
            model = json.loads(req.get("body") or "{}").get("model")
        except Exception:
            model = None
    if not base and req.get("url"):
        base = req["url"].rsplit("/chat/completions", 1)[0]
    return {
        "id": uuid.uuid4().hex[:12],
        "ts": r.get("ts") or time.strftime("%Y-%m-%d %H:%M:%S"),
        "config_name": r.get("config_name") or "",
        "base_url": base,
        "model": model,
        "stream": r.get("stream"),
        "status": r.get("status"),
        "ttft_ms": r.get("ttft_ms"),
        "total_ms": r.get("total_ms"),
        "tps": r.get("tps"),
        "ok": bool(r.get("ok")),
        "kind": "test",
        "usage": r.get("usage"),
        "usage_estimated": r.get("usage_estimated"),
        "request": r.get("request"),
        "response": {"status": r.get("status"), "body": scrub((r.get("text") or "")[:4000], key)},
        "error": ({"kind": r.get("error_kind"), "message": r.get("error"), "body": r.get("raw")}
                  if r.get("error") else None),
    }


def serve(port=0):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    return httpd


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    srv = serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8791)
    print("listening http://127.0.0.1:%d  data=%s" % (srv.server_address[1], DATA))
    srv.serve_forever()
