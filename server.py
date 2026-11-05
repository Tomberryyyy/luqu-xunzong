# -*- coding: utf-8 -*-
"""
鲁趣寻踪 —— 山东文旅受众匹配与传播文案助手（本地轻量服务）
仅使用 Python 标准库，无需任何第三方依赖（Python 3.8+ 即可运行）。

功能：
  1. 提供前端静态页面（index.html / style.css / app.js / data/attractions.json）
  2. POST /api/profile：从自然语言描述中提取旅行偏好画像（6 个维度）
  3. POST /api/copywriting：调用 OpenAI 兼容的大模型接口生成传播标题与 80~120 字文案

画像提取原则：
  - 用户没有表达的维度一律标记为“未说明”，不根据性格词擅自推断偏好。
  - 模型调用失败会明确报错，不会用模板伪装成功。

配置：读取同目录下的 .env 文件（复制 .env.example 后自行填写）。
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data", "attractions.json")

PROFILE_DIMENSIONS = ["companion", "environment", "pace", "stamina", "interests", "excludes"]


# ---------------------------------------------------------------- .env 读取
def load_env(path=os.path.join(BASE_DIR, ".env")):
    """极简 .env 解析，不依赖 python-dotenv；只读取 KEY=VALUE 行。"""
    env = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key:
                    env[key] = value
    return env


ENV = load_env()
# 环境变量优先（便于测试与容器化运行覆盖）
for _k in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_MOCK", "PORT"):
    if _k in os.environ:
        ENV[_k] = os.environ[_k]

LLM_BASE_URL = ENV.get("LLM_BASE_URL", "").rstrip("/")
LLM_API_KEY = ENV.get("LLM_API_KEY", "")
LLM_MODEL = ENV.get("LLM_MODEL", "")
LLM_MOCK = ENV.get("LLM_MOCK", "0") == "1"
PORT = int(ENV.get("PORT", "8006"))


# ---------------------------------------------------------------- 公共 LLM 调用
def _chat_completions(messages, retry=2, max_tokens=600, temperature=0.7):
    """调用 OpenAI 兼容接口 /chat/completions，返回 assistant 的文本内容。

    返回: (content_text, error_message)
    content_text 为 None 时表示失败，error_message 说明原因。
    """
    last_err = None
    for attempt in range(retry):
        body = json.dumps({
            "model": LLM_MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{LLM_BASE_URL}/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {LLM_API_KEY}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"].strip(), None
        except urllib.error.HTTPError as e:
            last_err = f"接口返回 HTTP {e.code}，请检查服务状态与本地配置。"
            time.sleep(1)
        except Exception as e:
            last_err = "请求失败，请检查网络连接与接口地址。"
            time.sleep(1)
    return None, last_err or "模型请求失败"


def _extract_json(text):
    """从模型输出中容错提取 JSON 对象。"""
    text = text.strip()
    # 优先整段 JSON
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    # 尝试提取 {...} 子串
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    return None


def _require_configured():
    if not LLM_API_KEY or not LLM_BASE_URL:
        raise RuntimeError("API_KEY_NOT_CONFIGURED")
    if not LLM_MODEL:
        raise RuntimeError("MODEL_NOT_CONFIGURED")


# ---------------------------------------------------------------- 画像提取
PROFILE_KEYS_CN = {
    "companion": "同行偏好",
    "environment": "环境偏好",
    "pace": "行程节奏",
    "stamina": "体力接受度",
    "interests": "内容兴趣",
    "excludes": "明确排除项",
}


def _mock_profile(description):
    """演示模式：不发送真实模型请求，返回示例画像（界面会标注为演示数据）。"""
    return {
        "companion": {"value": "未说明", "evidence": ""},
        "environment": {"value": "海边", "evidence": "描述中包含“看海”相关表述（演示示例）"},
        "pace": {"value": "轻松", "evidence": "描述中包含“节奏轻松”相关表述（演示示例）"},
        "stamina": {"value": "未说明", "evidence": ""},
        "interests": {"value": ["拍照", "美食"], "evidence": "描述中包含“拍照、美食”相关表述（演示示例）"},
        "excludes": {"value": ["爬山"], "evidence": "描述中包含“不想爬山”相关表述（演示示例）"},
    }


def _normalize_profile(parsed):
    """把模型输出的画像统一成标准结构；缺失/空项一律补为“未说明”。"""
    profile = {}
    for dim in PROFILE_DIMENSIONS:
        raw = parsed.get(dim)
        if not isinstance(raw, dict):
            raw = {}
        value = raw.get("value")
        evidence = raw.get("evidence")
        evidence = str(evidence).strip() if evidence else ""
        if dim in ("interests", "excludes"):
            # value 允许数组或逗号分隔字符串
            if isinstance(value, list):
                items = [str(v).strip() for v in value if str(v).strip()]
            elif isinstance(value, str) and value.strip():
                items = [v.strip() for v in re.split(r"[,，、;；]", value) if v.strip()]
            else:
                items = []
            items = [v for v in items if v not in ("未说明", "无", "None", "null", "-")]
            profile[dim] = {"value": items if items else "未说明", "evidence": evidence if items else ""}
        else:
            value = str(value).strip() if value else ""
            if not value or value in ("未说明", "无", "None", "null", "-"):
                value = "未说明"
            profile[dim] = {"value": value, "evidence": evidence if value != "未说明" else ""}
    return profile


def _call_profile(description):
    """从自然语言描述中提取旅行偏好画像（6 个维度）。"""
    if LLM_MOCK:
        return _mock_profile(description)
    _require_configured()

    sys_prompt = (
        "你是旅行偏好分析师。根据用户的自由描述，只提取用户明确表达的偏好；"
        "用户没有表达的内容必须标记为“未说明”，严禁根据性格词（如内向、外向、安静等）擅自推断"
        "“怕人多”“不爱运动”“喜欢热闹”等偏好。"
        "只输出一个 JSON 对象，不要输出任何其他文字。"
    )
    user_prompt = (
        "以下是用户关于旅行的描述：\n"
        f"“{description}”\n"
        "请按以下 6 个维度提取偏好，每个维度输出 {\"value\": ..., \"evidence\": ...}：\n"
        "1. companion（同行偏好）：如 独自/情侣/朋友/亲子/家庭/研学 等；未说明填“未说明”。\n"
        "2. environment（环境偏好）：如 海边/自然/古城/城市/山岳/湖泊 等；未说明填“未说明”。\n"
        "3. pace（行程节奏）：轻松/适中/紧凑；未说明填“未说明”。\n"
        "4. stamina（体力接受度）：高/中/低；未说明填“未说明”。\n"
        "5. interests（内容兴趣）：数组，只放用户明确提到的兴趣，如 [\"美食\",\"拍照\",\"历史文化\"]；未说明填“未说明”。\n"
        "6. excludes（明确排除项）：数组，只放用户明确说不想要的，如 [\"爬山\"]；未说明填“未说明”。\n"
        "evidence 字段用一句话引用用户的表述依据；若该项未说明，evidence 填空字符串。\n"
        "只输出 JSON，格式：{\"companion\":{\"value\":\"...\",\"evidence\":\"...\"},"
        "\"environment\":{\"value\":\"...\",\"evidence\":\"...\"},"
        "\"pace\":{\"value\":\"...\",\"evidence\":\"...\"},"
        "\"stamina\":{\"value\":\"...\",\"evidence\":\"...\"},"
        "\"interests\":{\"value\":[\"...\"],\"evidence\":\"...\"},"
        "\"excludes\":{\"value\":[\"...\"],\"evidence\":\"...\"}}"
    )

    messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user_prompt},
    ]

    last_err = None
    for attempt in range(2):
        content, err = _chat_completions(messages, max_tokens=600)
        if err:
            last_err = err
            continue
        parsed = _extract_json(content)
        if parsed is None or not any(dim in parsed for dim in PROFILE_DIMENSIONS):
            messages = messages + [
                {"role": "assistant", "content": content},
                {"role": "user", "content": "你刚才没有输出合法 JSON，请只输出一个 JSON 对象，不要任何解释。"},
            ]
            last_err = "模型未返回合法 JSON"
            continue
        profile = _normalize_profile(parsed)
        # 没有明确旅行偏好时，全为“未说明”是有效结果。
        return profile

    raise RuntimeError(last_err or "画像提取失败")


# ---------------------------------------------------------------- 文案生成
def _mock_copy(name, city, keywords):
    """演示模式：不发送真实模型请求，返回固定文案，用于预览界面效果。"""
    kw = "、".join(keywords) if keywords else "文旅"
    return {
        "title": f"去{name}，赴一场{kw}之旅",
        "copy": f"在{name}（{city}），把{kw}的期待变成现实。"
                f"这里既有让人心动的核心景观，也藏着值得慢慢体验的风情。"
                f"出发前记得参考推荐季节和现场提示，把行程安排得更从容。"
                f"带上相机，记录下属于你的山东记忆。",
    }


def _profile_to_text(profile):
    """把确认后的旅行偏好画像转成文案创作的约束文本（排除项为硬约束）。"""
    if not profile:
        return None
    lines = []
    for dim, cn in PROFILE_KEYS_CN.items():
        item = profile.get(dim)
        if not item:
            continue
        val = item.get("value")
        if isinstance(val, list):
            vals = [str(v).strip() for v in val if str(v).strip()]
            text = "、".join(vals) if vals else None
        else:
            text = str(val).strip() if val else None
        if not text or text == "未说明":
            continue
        lines.append(f"{cn}：{text}")
    if not lines:
        return None
    return "；".join(lines)


def _call_llm(spot, keywords, profile=None, retry=2):
    """调用 OpenAI 兼容接口生成传播标题与 80~120 字文案。

    spot: 单个景点信息字典（仅含必要的字段）
    profile: 用户确认后的旅行偏好画像（排除项作为硬约束，其余作为创作方向）
    返回: {"title": str, "copy": str, "chars": int}
    """
    if LLM_MOCK:
        return _mock_copy(spot["name"], spot["city"], keywords)
    _require_configured()

    intro = f"{spot['name']}（{spot['city']}）。简介：{spot['intro']}"
    extra = []
    if spot.get("match_reason"):
        extra.append(f"适配理由：{spot['match_reason']}")
    if spot.get("season"):
        extra.append(f"推荐季节：{spot['season']}")
    if spot.get("caution"):
        extra.append(f"限制提醒：{spot['caution']}")
    if extra:
        intro += "。" + "；".join(extra)

    profile_text = _profile_to_text(profile)
    constraint = ""
    if profile_text:
        constraint = (
            "用户旅行偏好画像：\n"
            f"  {profile_text}\n"
            "约束：用户明确排除的活动或场景，文案中不得建议、强调或暗示；"
            "其余偏好可作为创作方向自然融入，但不得因此编造景点资料之外的任何事实。\n"
        )

    sys_prompt = (
        "你是山东文旅传播策划专家，擅长为景点创作吸引人的短视频传播标题与文案。"
        "只输出一个 JSON 对象，不要输出任何其他文字。"
    )
    user_prompt = (
        f"用户旅游偏好关键词：{'、'.join(keywords) if keywords else '（无，请按通用文旅方向创作）'}\n"
        + constraint
        + f"请为以下景点创作传播内容：\n{intro}\n"
        "要求：\n"
        "1. 创作 1 个传播标题，15 字以内，突出景点核心亮点，可自然融入用户偏好。\n"
        "2. 创作 1 段传播文案，严格 80-120 个汉字，生动有感染力，包含景点亮点和实用的出行信息（如推荐季节、注意事项），"
        "不得编造表格之外的任何数据或事实。\n"
        '3. 只输出 JSON，格式为：{"title":"标题","copy":"文案"}\n'
    )

    messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user_prompt},
    ]

    last_err = None
    for attempt in range(retry):
        content, err = _chat_completions(messages, max_tokens=400, temperature=0.8)
        if err:
            last_err = err
            time.sleep(1)
            continue

        parsed = _extract_json(content)
        if not parsed:
            messages = messages + [
                {"role": "assistant", "content": content},
                {"role": "user", "content": "你刚才没有输出合法 JSON，请只输出一个 JSON 对象，不要任何解释。"},
            ]
            last_err = "模型未返回合法 JSON"
            continue

        copy_text = parsed.get("copy", "")
        char_count = len(copy_text)
        if 80 <= char_count <= 120:
            return {"title": parsed.get("title", ""), "copy": copy_text, "chars": char_count}
        messages = messages + [
            {"role": "assistant", "content": content},
            {"role": "user", "content": f"当前文案 {char_count} 字，不符合 80-120 字要求，请重写后只输出 JSON。"},
        ]
        last_err = f"文案字数 {char_count}，不在 80-120 范围内"
        time.sleep(1)

    raise RuntimeError(last_err or "文案生成失败")


# ---------------------------------------------------------------- HTTP 服务
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, code, payload, content_type="application/json; charset=utf-8"):
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        elif isinstance(payload, str):
            body = payload.encode("utf-8")
        else:
            body = payload
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path):
        allowed = {"/": "static/index.html", "/static/index.html": "static/index.html",
                   "/static/app.js": "static/app.js", "/static/matcher.js": "static/matcher.js",
                   "/static/records.js": "static/records.js",
                   "/static/workspace.js": "static/workspace.js",
                   "/static/style.css": "static/style.css", "/data/attractions.json": "data/attractions.json",
                   "/data/attributes.json": "data/attributes.json"}
        rel = allowed.get(path)
        if rel is None:
            self._send(404, {"error": "Not Found"})
            return
        full = os.path.join(BASE_DIR, rel)
        if not os.path.isfile(full):
            self._send(404, {"error": "Not Found"})
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
        }.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length).decode("utf-8")), None
        except Exception as e:
            return None, str(e)

    def _llm_error_response(self, msg):
        if msg == "API_KEY_NOT_CONFIGURED":
            return 400, {"ok": False, "error": "API_KEY_NOT_CONFIGURED",
                         "message": "未配置大模型密钥：请复制 .env.example 为 .env 并填写 LLM_API_KEY 后重启服务。"}
        if msg == "MODEL_NOT_CONFIGURED":
            return 400, {"ok": False, "error": "MODEL_NOT_CONFIGURED",
                         "message": "未配置模型名称：请在 .env 中填写 LLM_MODEL。"}
        return 502, {"ok": False, "error": "LLM_ERROR", "message": msg}

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._send(200, {"ok": True, "mock": LLM_MOCK,
                             "configured": bool(LLM_API_KEY and LLM_BASE_URL),
                             "model": LLM_MODEL if LLM_MODEL else ""})
            return
        self._serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/profile":
            self._handle_profile()
        elif parsed.path == "/api/copywriting":
            self._handle_copywriting()
        else:
            self._send(404, {"error": "Not Found"})

    def _handle_profile(self):
        req, err = self._read_json_body()
        if err or not isinstance(req, dict):
            self._send(400, {"ok": False, "error": "BAD_REQUEST", "message": "请求体不是合法 JSON"})
            return
        description = str(req.get("description", "")).strip()
        if not description:
            self._send(400, {"ok": False, "error": "EMPTY_DESCRIPTION", "message": "请先输入对旅行的描述或偏好关键词。"})
            return
        try:
            profile = _call_profile(description)
            self._send(200, {"ok": True, "profile": profile, "mock": LLM_MOCK})
        except RuntimeError as e:
            code, payload = self._llm_error_response(str(e))
            self._send(code, payload)
        except Exception as e:
            self._send(500, {"ok": False, "error": "SERVER_ERROR", "message": str(e)})

    def _handle_copywriting(self):
        req, err = self._read_json_body()
        if err or not isinstance(req, dict):
            self._send(400, {"ok": False, "error": "BAD_REQUEST", "message": "请求体不是合法 JSON"})
            return
        keywords = [k.strip() for k in req.get("keywords", []) if k and k.strip()]
        spot = req.get("spot")
        profile = req.get("profile")
        if not spot or not spot.get("name"):
            self._send(400, {"ok": False, "error": "BAD_REQUEST", "message": "缺少景点信息"})
            return
        try:
            result = _call_llm(spot, keywords, profile)
            self._send(200, {"ok": True, **result})
        except RuntimeError as e:
            code, payload = self._llm_error_response(str(e))
            self._send(code, payload)
        except Exception as e:
            self._send(500, {"ok": False, "error": "SERVER_ERROR", "message": str(e)})


def main():
    if not os.path.exists(DATA_FILE):
        print("未找到 data/attractions.json，请先运行 scripts/export_data.py 导出数据。")
        sys.exit(1)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    mode = "演示模式(MOCK)" if LLM_MOCK else ("已配置大模型" if (LLM_API_KEY and LLM_BASE_URL) else "未配置(等待填写 .env)")
    print("=" * 56)
    print("  鲁趣寻踪 —— 山东文旅受众匹配与传播文案助手")
    print(f"  运行地址: http://127.0.0.1:{PORT}")
    print(f"  当前模式: {mode}")
    print("  按 Ctrl+C 停止服务")
    print("=" * 56)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")


if __name__ == "__main__":
    main()
