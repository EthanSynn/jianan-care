# 架构与模块职责

---

## 一、整体数据流

```
用户输入
   │
   ▼
┌──────────────────────────────────────────────┐
│ ① 安全分诊  lib/safety-router.js（纯规则）     │
│    四级：crisis / safety_check /              │
│          ocd_intrusive / none                 │
└──────────────┬───────────────────────────────┘
               │ crisis 或 safety_check
               ├──────────────► 直接返回固定文案（不调模型，1–2ms）
               │
               ▼ none / ocd_intrusive
┌──────────────────────────────────────────────┐
│ ② OCD 路由  lib/ocd-router.js（纯规则）        │
│    亚型 10 类 / 共病 8 类 / 优先级 P0–P4       │
└──────────────┬───────────────────────────────┘
               ▼
┌──────────────────────────────────────────────┐
│ ③ 提示词组装  lib/ocd-prompt.js                │
│    专精定位 + 人格语气 + 专业红线 + 知识片段    │
└──────────────┬───────────────────────────────┘
               ▼
┌──────────────────────────────────────────────┐
│ ④ 模型调用（流式 SSE）                        │
│    DeepSeek / 任意 OpenAI 兼容服务            │
└──────────────┬───────────────────────────────┘
               ▼
┌──────────────────────────────────────────────┐
│ ⑤ 情绪融合  lib/emotion.js                     │
│    规则通道优先 → 危机强制覆盖                 │
└──────────────┬───────────────────────────────┘
               ▼
        正文 delta + 情绪 meta
```

**关键设计**：情绪与安全信号在第 ①⑤ 步就已确定，**早于模型输出**，所以数字人能在说第一个字之前摆好表情。

---

## 二、模块清单

| 文件 | 职责 | 是否纯函数 |
|---|---|---|
| `lib/safety-router.js` | 四级安全分诊、安慰循环检测、相似度 | 是 |
| `lib/safety-copy.js` | 危机文案、安全追问、他人风险文案 | — |
| `lib/emotion.js` | 情绪规则通道（第一人称锚定）、危机覆盖 | 是 |
| `lib/ocd-router.js` | 亚型分类、共病信号、优先级决策 | 是 |
| `lib/ocd-prompt.js` | OCD 专业定位段、人格 system 组装 | 是 |
| `lib/ocd-knowledge.js` | 按亚型与优先级检索知识片段 | 是 |
| `lib/model-output.js` | 结构化输出解析（JSON / 代码围栏 / 纯文本） | 是 |
| `server.js` | HTTP 服务、路由、配额、口令门、SSE 转发 | 否 |

除 `server.js` 外全部是纯函数，可直接单元测试，不依赖网络与数据库。

---

## 三、HTTP 路由

| 路径 | 方法 | 作用 |
|---|---|---|
| `/` | GET | 静态页面（`public/index.html`） |
| `/chat/stream` | POST | 流式对话（主用） |
| `/chat` | POST | 非流式对话（降级用） |
| `/stt` | POST | 语音识别代理（百度） |
| `/api/unlock` | POST | 口令换凭证 Cookie |
| `/healthz` | GET | 健康检查 |

---

## 四、环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 模型服务 Key |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-flash` |
| `DEEPSEEK_REASONING_EFFORT` | 否 | `none` 关闭思考链（推荐） |
| `ACCESS_CODE` | 否 | 访问口令，逗号分隔多个；不填则关闭门禁 |
| `ACCESS_TTL_DAYS` | 否 | 凭证有效期，默认 30 天 |
| `CHAT_PER_MIN` / `CHAT_PER_DAY` / `CHAT_GLOBAL_DAY` | 否 | 配额，默认 10 / 150 / 600 |
| `EMOTION_STRUCTURED` | 否 | `1` 时启用模型结构化情绪（默认关闭，原因见下） |

**为什么默认关闭结构化情绪**：实测 `deepseek-flash` 在「带 assistant 历史 + 长提示词 + `response_format: json_object`」组合下会输出整段空白（`finish_reason=stop`，token 全花在空格上）。因此默认走纯文本，情绪用规则通道。

---

## 五、目录结构

```
见岸-队友交接包/
├── README.md                 ← 先读这个
├── docs/
│   ├── INTEGRATION.md        数字人对接契约（最重要）
│   ├── EMOTION-MAP.md        情绪 → 表情映射
│   ├── SAFETY-RULES.md       安全规则与边界
│   └── ARCHITECTURE.md       本文件
├── web-public/               ← 可直接运行的服务
│   ├── server.js
│   ├── env-loader.js
│   ├── lib/                  核心规则模块
│   ├── public/index.html     自带前端（可参考 UI 与流式渲染）
│   ├── .env.example
│   └── package.json
└── reference/                ← 参考实现，不必部署
    └── cloudfunctions/
        ├── chat/             小程序云函数版（逻辑同源）
        └── ocd/              数据服务（档案/日志/阶梯/自评）
```

---

## 六、与小程序版的关系

`reference/cloudfunctions/` 是同一套规则的云函数实现，用于微信小程序。它多做了一件事：把用户的自评、症状日志、暴露阶梯存进云数据库（按 `_openid` 隔离）。

数字人如果不需要持久化这些数据，可以完全忽略 `reference/`。

若后续要存数据，建议直接对接自己的后端，而不是搬云函数——云函数依赖微信云开发的运行时。
