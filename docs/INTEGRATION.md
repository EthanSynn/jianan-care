# 数字智能体对接契约

> 面向：负责数字人 / AI 交互体的队友
> 服务：`web-public/server.js`（Node，单端口 HTTP）
> 版本：2026-10-18

---

## 一、你要接的两个东西

数字人需要从对话服务拿到两类信号，分别驱动不同的表现层：

| 信号 | 用途 | 何时到达 |
|---|---|---|
| **文本流** `delta` | TTS 播报、字幕逐字显示 | 首字约 0.5–3 秒，之后持续流入 |
| **情绪标签** `emotion` | 表情、语气、动作选择 | **正文之前**（`meta` 事件） |
| **安全级别** `safety` | 是否中断正常流程、切危机表现 | **正文之前**（`meta` 事件） |

关键点：**情绪和安全信号比正文先到**。这意味着数字人可以在说出第一个字之前，就已经摆好对应的表情和姿态。

---

## 二、接口一：流式对话（推荐）

```
POST /chat/stream
Content-Type: application/json
Cookie: ja_pass=<解锁后拿到的凭证>     ← 若服务端配了 ACCESS_CODE
```

### 请求体

```json
{
  "personaId": "jianan",
  "messages": [
    { "role": "user", "content": "我老忍不住确定明明已经确定很多次的事情" }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `personaId` | 是 | `jianan`（见岸，温柔陪伴）/ `anxin`（安心，讲机制）/ `xiaoxian`（小暖，倾听） |
| `messages` | 是 | 对话历史，最多取最近 12 条，`role` 只用 `user` / `assistant` |
| `apiKey` | 否 | 调用方自带的模型 Key，覆盖服务端配置 |
| `apiBase` | 否 | 自定义网关地址，需同时给 `model` |
| `model` | 否 | 配合 `apiBase` 使用的模型名 |

### 响应：SSE 事件流

`Content-Type: text/event-stream`，每个事件形如 `data: {...}\n\n`。

**事件顺序**

```
meta      ← 人格、安全级别、情绪标签、OCD 路由（正文之前，~10ms）
meta2     ← 首字到达时刻（仅普通对话有，危机路径没有）
delta     ← 正文片段，可能几十次
delta
...
done      ← 结束，带总耗时与字数
```

### 事件字段详解

**① `meta`（先到，用它决定表情和是否中断）**

```json
{
  "type": "meta",
  "persona": "见岸",
  "isCrisis": false,
  "safety": {
    "level": "none",
    "route": "GENERAL",
    "target": "self",
    "confidence": "high",
    "shouldShowCrisisCard": false,
    "shouldAskSafetyCheck": false,
    "ruleVersion": "2026-10-15.v1",
    "mode": "on"
  },
  "emotion": { "label": "anxious", "source": "rule", "mode": "on" },
  "ocd": {
    "subtype": "mixed",
    "priority": "P1",
    "dual": false,
    "comorbidity": { "flags": [], "suggestProfessional": false }
  }
}
```

| 字段 | 含义 | 数字人怎么用 |
|---|---|---|
| `isCrisis` | 是否真实危机 | `true` 时**中断当前所有表现**，切危机态，见第五节 |
| `safety.level` | `crisis` / `safety_check` / `ocd_intrusive` / `none` | `ocd_intrusive` 表示是强迫观念、**不是**真实风险，不要演成危机 |
| `safety.shouldShowCrisisCard` | 是否弹危机卡 | 与 `isCrisis` 同步，供前端直接判断 |
| `safety.shouldAskSafetyCheck` | 是否需要澄清 | 此时返回的是固定追问文案，语气要收，不要继续轻松寒暄 |
| `emotion.label` | 用户此刻情绪 | 驱动表情，映射见 `EMOTION-MAP.md` |
| `ocd.subtype` | 强迫亚型 | 可用于切换角色的专业姿态（如污染型可提示「先不洗手」） |
| `ocd.priority` | `P0`–`P4` | `P0` 安全优先、`P1` 强迫急性发作、`P3` 共病情绪 |
| `ocd.dual` | 是否双主轴 | `true` 表示强迫与共病同时存在，回复需两边都照顾 |

> ⚠️ `ocd` 在危机路径下为 `null`。

**② `meta2`（首字时刻，用于埋点）**

```json
{ "type": "meta2", "firstByteMs": 1582 }
```

**③ `delta`（正文片段）**

```json
{ "type": "delta", "text": "嗯，那种" }
```

逐块拼接即完整回复。**不要假设一个 delta 是完整句子**，可能是半个词。

**④ `done`（结束）**

```json
{ "type": "done", "totalMs": 2751, "chars": 192 }
```

**⑤ `error`（异常）**

```json
{ "type": "error", "message": "请求太频繁", "errorCode": "RATE_LIMIT" }
```

常见 `errorCode`：`RATE_LIMIT`（限流）、`TIMEOUT`（模型超时）、`NO_KEY`（未配置模型 Key）。

### 调用示例（浏览器 / 数字人前端）

```js
const resp = await fetch('/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ personaId: 'jianan', messages: [{ role: 'user', content: '……' }] })
});

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = '', full = '';

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });

  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 2);
    if (!chunk.startsWith('data:')) continue;
    const evt = JSON.parse(chunk.slice(5).trim());

    if (evt.type === 'meta') {
      setExpression(evt.emotion.label);      // 先摆表情
      if (evt.isCrisis) enterCrisisMode();   // 危机态优先于一切
    } else if (evt.type === 'delta') {
      full += evt.text;
      speakChunk(evt.text);                  // 边收边播，不要攒完整段
    } else if (evt.type === 'done') {
      endSpeaking();
    } else if (evt.type === 'error') {
      showHint(evt.message);
    }
  }
}
```

---

## 三、接口二：非流式对话（备用）

```
POST /chat
```

请求体同上，返回一次性 JSON：

```json
{
  "ok": true,
  "reply": "……",
  "isCrisis": false,
  "persona": "见岸",
  "safety": { "level": "none", "route": "GENERAL", ... },
  "emotion": { "label": "anxious", "source": "rule", "mode": "on" },
  "parseStatus": "plain_text",
  "ocd": { "subtype": "mixed", "priority": "P1", "dual": false, "comorbidity": {...} }
}
```

用途：流式通道异常时降级、或数字人侧只需要整段文本时。

---

## 四、鉴权

若服务端配置了 `ACCESS_CODE`，所有 `/chat`、`/chat/stream` 请求都必须带 Cookie。

```js
// 1. 换票
const r = await fetch('/api/unlock', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: '团队口令' })
});
const data = await r.json();        // { ok: true }
// 2. 服务端会 Set-Cookie: ja_pass=...；浏览器自动携带
```

凭证有效期由 `ACCESS_TTL_DAYS` 控制（默认 30 天）。

---

## 五、危机路径：数字人必须这样处理

服务端命中危机时，**不调用模型**，直接推送固定文案 + 热线。数字人侧的义务：

1. **立即中断**当前的轻松语气、动画、背景音乐
2. 表情切到严肃态（不要微笑、不要可爱化）
3. 播报时**放慢语速**，不要用活泼音色
4. 必须**完整播报**服务端返回的文案，不得改写、不得省略热线号码
5. 提供可点击的 `tel:12356` 入口

服务端返回的危机文案示例（实际以接口返回为准）：

> 我很担心你现在的安全。请先告诉我：你此刻是否已经准备了伤害自己的物品，或正在实施？如果是，请立即拨打 120、110 或全国心理援助热线 12356，并尽快让身边可信任的人来到你身边。先不要独自承受。

**红线**：不得对危机文案做摘要、TTS 改写、语气润色。这是合规与安全要求，不是体验优化项。

---

## 六、人格与音色建议

| personaId | 名字 | 定位 | 建议音色 | 语速 |
|---|---|---|---|---|
| `jianan` | 见岸 | 温柔陪伴，理清困扰 | 中性偏暖 | 中缓 |
| `anxin` | 安心 | 讲机制，循证科普 | 沉稳清晰 | 中 |
| `xiaoxian` | 小暖 | 不评判地倾听 | 温暖有气息感 | 缓 |

---

## 七、延迟基线（实测数据）

| 指标 | 实测 | 说明 |
|---|---|---|
| `meta` 到达 | 10–100ms | 安全分诊 + OCD 路由是纯规则计算 |
| 危机整段返回 | 1–2ms | 不经过模型 |
| `meta2`（首字） | 0.5–3.7s | 模型侧波动，无法控制 |
| 完整回复 | 2.6–5.4s | 约 200 字 |

**前端兜底建议**：1.8 秒内没有 `delta` 就先给一句过渡语（参考实现见 `web-public/public/index.html` 的 `placeholderTimer`），避免用户面对空白。

---

## 八、接口三：语音识别（可选）

```
POST /stt
```

服务端用百度短语音识别。请求体带 `baiduAK` / `baiduSK`，音频为 16k 单声道 WAV 的 base64。

若数字人用自己的 ASR，可忽略此接口。

---

## 九、你不需要关心的事

以下都在服务端完成，数字人侧不用实现，也不要绕过：

- 四级安全分诊（`lib/safety-router.js`）
- 危机文案与热线数据（`lib/safety-copy.js`）
- OCD 亚型 / 共病 / 优先级判定（`lib/ocd-router.js`）
- 专业边界提示词与知识注入（`lib/ocd-prompt.js`、`lib/ocd-knowledge.js`）
- 情绪规则通道（`lib/emotion.js`）
- 模型 Key 与网关（`.env`，不随代码分发）

你要做的是：**把 `meta` 里的情绪与安全信号翻译成表情、语气、动作；把 `delta` 交给 TTS 并保持边收边播。**
