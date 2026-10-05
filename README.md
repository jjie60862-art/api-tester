# API 试电笔 · OpenAI Compatible API Tester

纯本地运行的 OpenAI 兼容 API 测试工具（"试电笔"）。不是 AI 客户端，只做四件事：
判断地址/Key 是否有效、测响应速度、测稳定性、用一个极简聊天窗验证模型能不能用。

不依赖远程后端，无遥测；除你自己填的 API 地址外，不连接任何第三方服务器。

## 启动

双击 **`启动 API 试电笔.bat`**（或 `pythonw app.py`）。

首次运行会打开一个原生窗口（pywebview / Edge WebView2）。
若 pywebview 不可用，自动回退到系统默认浏览器。

## 数据存放

```
%APPDATA%\OpenAIAPITester\configs.json    # 配置（含 API Key）
%APPDATA%\OpenAIAPITester\logs.json       # 最近 200 条请求日志（Key 已脱敏）
```

日志中 `Authorization` 一律写成 `Bearer sk-****abcd`，**绝不保存真实 Key**。
删掉这两个文件即恢复出厂状态。

## 目录

```
app.py              入口：起本地后端 + 开原生窗口
server.py           后端：本地 HTTP 服务 + 上游请求 + TTFT 测量 + 脱敏
web/index.html      界面结构
web/style.css       样式（浅色/深色主题，主色 #12B7F5）
web/app.js          前端逻辑
```

## 关键实现说明

- **只监听 127.0.0.1**，随机端口；除你填的 API 地址外不连接任何第三方，无遥测。
- 上游请求由本地后端转发（绕开浏览器 CORS），**TTFT 在服务端用流式首字节计时**，
  非流式请求无法分离首 Token，其 Tokens/s 会标注为近似值（`~`）。
- Base URL 自动规整：`https://x.com`、`https://x.com/v1`、
  `https://x.com/v1/chat/completions` 都会被识别成 `https://x.com/v1`，不会拼出 `/v1/v1`。
- `/models` 失败不影响使用，直接手动输入模型 ID 即可。
- **模型列表可逐条删除 / 逐条添加**：点「获取模型」拉取列表，或直接在输入框里手打模型 ID
  后按 `▾` 打开列表点「＋ 添加」，一个个把要测的模型攒进列表（列表按配置保存，重启还在）。
  每条后面的 `✕` 把不想要的模型从列表里去掉，删掉的用「显示已删除」→ `↺` 一键找回。
- 模型输入框内的 `✕` 可一键清除当前已选模型；侧栏每个配置卡片也有独立的 `✕` 删除按钮。
- 服务器未返回 `usage` 时，Token 字段显示 `N/A`，不伪造。
- 错误按类型区分：HTTP / 网络 / DNS / 超时 / 流解析，并尽量回显服务器原始错误信息。
- 「复制 Curl」只输出 `$BASE_URL` / `$API_KEY` 占位符，不含真实密钥。

## 备份

仓库：[`jjie60862-art/openai-api-tester`](https://github.com/jjie60862-art/openai-api-tester)（私有）

改完代码后同步：`git add -A && git commit -m "说明" && git push`

## 依赖

- Python 3（标准库即可）
- `pywebview`（可选，仅用于原生窗口；缺失则用浏览器打开）
