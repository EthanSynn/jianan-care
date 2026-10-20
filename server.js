// 见岸 · 公网站 Node 服务
// 1) 托管 public/ 下的静态页面（index.html 等）
// 2) 同源 /chat 代理：服务端持有模型 Key，前端不暴露任何 Key，无跨域问题；支持请求内 apiKey 覆盖（用户设置里粘贴自己的 Key）
// 3) 同源 /stt 代理：浏览器采集 16k PCM→WAV 后发给本服务，服务端用百度语音识别（AK/SK 由前端设置带来）转文字，仅用 Node 内置 https。
// 部署目标：CloudStudio / 任意 Node 运行环境（运行 node server.js，监听 process.env.PORT 或默认 3000）
//
// 凭证来源：只从环境变量读，代码里不留任何兜底值。
//   · 本地：项目根目录 .env（已被 .gitignore 排除，参考 .env.example）
//   · 线上：部署平台的环境变量配置
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadEnv, maskKey } = require('./env-loader');
// ---- OCD 专精化核心模块（与云函数共用同一套规则，改一处即可） ----
const { assessSafety } = require('./lib/safety-router');
const { CRISIS_REPLY, SAFETY_CHECK_REPLY, OTHER_PERSON_CHECK_REPLY } = require('./lib/safety-copy');
const { classifyRule, finalizeEmotion } = require('./lib/emotion');
const { classifySubtype, detectComorbidity, decidePriority } = require('./lib/ocd-router');
const { buildPersonaSystem } = require('./lib/ocd-prompt');
const { buildContext } = require('./lib/ocd-knowledge');
const { buildStructuredSystem, parseAssistantContent } = require('./lib/model-output');
const envFile = loadEnv(__dirname);
const { handleAvatar } = require('./lib/avatar-gateway');

// ---------------- AI Ping 配置（仅服务端持有；用户可在前端设置里覆盖） ----------------
const AIPING_URL = 'https://aiping.cn/api/v1/chat/completions';
const AIPING_KEY = process.env.AIPING_API_KEY || process.env.AI_PING_KEY || '';
// aiping 上确认存在的模型统一用 GLM-4.7 / MiniMax-M2.1，避免 DeepSeek-V3.2 / GLM-4.7-Flash 这类不在 aiping 的模型名导致 400。
const FALLBACK_MODEL = 'GLM-4.7';

// ---------------- DeepSeek 服务端默认配置（任何设备免填 Key 直接聊） ----------------
// Key 由服务端持有，前端不可见、不进仓库。
//
// 模型代号于 2026 换代：deepseek-chat 已下线 → 现为 deepseek-flash（通用）/ deepseek-v4-pro（强推理）
// 思考模式同理更新：旧的 enable_thinking 已废弃，现由 reasoning_effort 控制。
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
// none = 关闭思维链（心理陪伴要的是接住情绪，不是推理链：更快、更省、回复更简短自然）
const DEEPSEEK_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || 'none';

if (!DEEPSEEK_KEY) {
  console.warn('[启动警告] 未读到 DEEPSEEK_API_KEY',
    '\n  · 环境文件：' + (envFile || '(未找到 .env)'),
    '\n  · 已脱敏：' + maskKey(DEEPSEEK_KEY),
    '\n  · 后果：/chat 会走 AI Ping 兜底；两条都没配则返回明确错误而不是静默失败。',
    '\n  · 修法：复制 .env.example 为 .env 并填入真实 Key，或在部署平台配置环境变量。');
} else {
  console.log('[启动] DeepSeek 已就绪', {
    base: DEEPSEEK_BASE,
    model: DEEPSEEK_MODEL,
    effort: DEEPSEEK_EFFORT,
    key: maskKey(DEEPSEEK_KEY),
    环境文件: envFile || '(平台环境变量)'
  });
}

// ---------------- 人格设定（仅服务端；去 AI 味、什么都能聊） ----------------
const PERSONAS = {
  jianan: {
    name: '见岸',
    model: 'deepseek-flash', temperature: 0.9, maxTokens: 300,
    prompt:
`你叫见岸，是用户手机里一个说话温和的朋友。什么都能聊——今天吃了啥、工作烦不烦、心里堵不堵，都行。先听清楚对方在说什么再接话；对方低落时先让他感觉被听懂，别急着给建议。像真人微信聊天那样回，口语、简短、自然，可加一两个表情。别列条条框框、别写小作文、别说"作为一个AI"。只说给用户听的话。`
  },
  anxin: {
    name: '安心',
    model: 'deepseek-flash', temperature: 0.6, maxTokens: 300,
    prompt:
`你叫安心，是用户随叫随到的靠谱朋友，脑子清楚、说话有条理，拿任何问题来都能接：怎么选、怎么想通一件事、某个知识是什么，都行。先一句话给结论，再把关键几点说清，别绕、像跟朋友解释、不像写论文、控制篇幅。像真人聊天，别说"作为一个AI"。只说给用户听的话。`
  },
  xiaoxian: {
    name: '小暖',
    model: 'deepseek-flash', temperature: 0.9, maxTokens: 300,
    prompt:
`你叫小暖，是温暖、真诚的朋辈倾听者。你从不评判，总是先共情："这真的很难""我懂那种感觉"。被症状折磨的人常一边痛苦一边责怪自己"为什么就是控制不住"，还会因为念头的内容觉得羞耻、不敢跟人说。你看得见这份自责，也看得见他身边人的不理解。可以用一点画面感的表达帮他讲出难以言说的感受，也可以陪他聊点轻松的、和症状无关的事。但不要追问念头的具体画面，也不要拿症状开玩笑。共情之后，轻轻问一句他此刻最需要什么：想被听着、想聊点别的，还是想找个办法。`
  }
};

// OCD 专精定位：覆盖在人格语气段之上，三位共用同一套专业边界与优先级
const SPECIALIST_PERSONAS = {
  jianan: '你叫见岸，是专注强迫症自助的温和入口。理清强迫性怀疑、仪式循环与普通担心，承接情绪并引导到自评、阶梯或日志；不诊断、不给保证。像微信聊天一样口语、简短，整段不超过 200 字。',
  anxin: '你叫安心，是专注强迫症自助的专业教练。通俗解释反刍、求保证和 ERP，制定循序渐进的安全练习，独立回应共病并建议专业评估；不提供药物方案。先给结论再讲要点，整段不超过 200 字。',
  xiaoxian: '你叫小暖，是温暖的强迫症自助陪伴者。承接羞耻、自责与家庭不理解，允许共病情绪完整展开，不把一切归因于 OCD；不虚构亲身经历、不诊断、不提供保证。先共情再问需要，整段不超过 250 字。'
};

function findPersona(id) { return PERSONAS[id] || PERSONAS.jianan; }

// ---------------- 危机检测（覆盖更多自伤/自杀表达） ----------------
const CRISIS_WORDS = [
  '自杀', '自伤', '不想活', '不想活了', '活不下去', '活不下去了', '结束生命', '想死', '去死',
  '没有意义了', '活着没意思', '活着没意义', '活得没意思', '活著沒意義', '伤害自己', '了结', '解脱', '轻生',
  '不如死了', '不如死了算了', '结束一切', '一了百了', '自我了断', '寻死', '自尽', '放弃生命',
  '没人需要我', '没人在乎我', '想消失', '想消失在这个世界', '彻底解脱', '从楼上跳', '跳楼', '割腕', '吞药', '撞车',
  '撑不住了', 'kill myself', 'kms', 'suicide', 'end my life', 'want to die', 'i want to die', 'hurt myself'
];
function detectCrisis(text = '') {
  const t = String(text).toLowerCase();
  return CRISIS_WORDS.some(k => t.includes(k.toLowerCase()));
}

// 把消息里的非标准 role 映射成 OpenAI/DeepSeek 标准角色，避免历史数据里的 'ai' 等旧值导致 400
function normalizeMessages(messages) {
  const map = { ai: 'assistant', bot: 'assistant', model: 'assistant', human: 'user', me: 'user', client: 'user' };
  const valid = new Set(['system', 'user', 'assistant', 'tool', 'latest_reminder']);
  return (messages || []).map(m => {
    if (!m || typeof m !== 'object') return { role: 'user', content: '' };
    let role = String(m.role || 'user').toLowerCase();
    if (map[role]) role = map[role];
    else if (!valid.has(role)) role = 'user';
    return { role, content: String(m.content || '') };
  });
}

// ---------------- 统一错误类型与分类提示 ----------------
// 让每一类失败都有可定位的中文原因，而不是一句笼统的「请求失败」。
class ChatError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    this.httpStatus = httpStatus || 0;
  }
}

const HTTP_ERR_HINT = {
  400: '请求参数有问题（可能是模型代号已过期，请到 platform.deepseek.com 核对当前模型名）',
  401: 'API Key 无效或已被撤销，请检查 .env 里的 DEEPSEEK_API_KEY',
  402: '账户余额不足，请前往 DeepSeek 平台充值',
  422: '请求参数不合法，请检查 model / temperature / max_tokens',
  429: '请求过于频繁或已达配额上限，请稍后重试',
  500: 'AI 服务商内部故障，请稍后重试',
  503: 'AI 服务商繁忙，请稍后重试'
};

function friendlyHint(code) {
  const map = {
    NO_KEY: '服务端还没配置 AI 密钥，请联系管理员',
    TIMEOUT: 'AI 响应超时了，稍等一下再试',
    NETWORK: '服务端连不上 AI 服务，请稍后再试',
    BAD_RESPONSE: 'AI 返回了异常内容，换个说法再试试'
  };
  if (map[code]) return map[code];
  if (/^HTTP_/.test(code)) {
    const n = parseInt(code.slice(5), 10);
    return HTTP_ERR_HINT[n] || 'AI 服务返回异常，请稍后再试';
  }
  return '暂时没能连上 AI，稍后再试';
}

// 脱敏：任何日志/错误串里都不得出现完整 Key
function maskKeyLocal(key) {
  const s = String(key || '');
  if (!s) return '(未配置)';
  if (s.length <= 8) return s[0] + '****';
  return s.slice(0, 6) + '****' + s.slice(-4);
}

// ---------------- 调用 OpenAI 兼容网关（默认 DeepSeek，也支持用户自定义 apiBase） ----------------
// opts.system     ：覆盖人格自带 prompt（OCD 专精路由会传入组装好的 system）
// opts.structured ：请求 JSON 结构化输出（情绪标签用），解析失败由上层回落纯文本
function callAipingOnce(personaId, messages, apiKeyOverride, forceModel, apiBase, opts = {}) {
  const p = findPersona(personaId);
  const model = forceModel || p.model;
  const key = apiKeyOverride || AIPING_KEY;
  if (!key) {
    throw new ChatError('NO_KEY', '未配置 AI 密钥：请在项目根目录 .env 里设置 DEEPSEEK_API_KEY（参考 .env.example），或在页面设置中填入自己的 Key');
  }
  const cleanMessages = normalizeMessages(messages);
  // 判断是否走 DeepSeek 主链路（未指定自定义 apiBase = 走服务端默认 DeepSeek）
  const isDeepSeek = !apiBase || /deepseek\.com/i.test(apiBase);

  const body = {
    model,
    messages: [{ role: 'system', content: opts.system || p.prompt }, ...cleanMessages],
    temperature: p.temperature,
    max_tokens: p.maxTokens
  };
  if (opts.structured) body.response_format = { type: 'json_object' };

  if (isDeepSeek) {
    // DeepSeek 2026 规格：
    //   · 思考模式由 reasoning_effort 控制（none 关闭）。旧的 extra_body.enable_thinking 已废弃，
    //     传了不报错但也不生效 —— 会导致一直在跑思维链，又慢又费 token。
    //   · 关闭思考后 temperature 才生效（思考模式下官方会忽略它）。
    body.reasoning_effort = DEEPSEEK_EFFORT;
  } else {
    // 第三方网关（AI Ping 等）仍用它们自己的开关
    body.extra_body = { enable_thinking: false };
  }

  const payload = JSON.stringify(body);
  const targetUrl = apiBase ? (apiBase.replace(/\/+$/, '') + '/chat/completions') : (DEEPSEEK_BASE + '/chat/completions');
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) {
      return reject(new ChatError('BAD_URL', '接口地址非法：' + targetUrl));
    }
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
      agent: false,
      servername: u.hostname,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (resp) => {
      let out = '';
      resp.on('data', d => out += d);
      resp.on('end', () => {
        // 非 2xx：带上状态码与官方错误说明，方便一次定位
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          const hint = HTTP_ERR_HINT[resp.statusCode] || ('上游返回 HTTP ' + resp.statusCode);
          const detail = String(out).slice(0, 200).replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-****');
          return reject(new ChatError('HTTP_' + resp.statusCode,
            hint + '（原始响应：' + detail + '）', resp.statusCode));
        }
        try {
          const j = JSON.parse(out);
          // 网关返回错误对象（OpenAI 兼容格式），直接透传真实原因
          if (j && j.error) {
            const m = (j.error && (j.error.message || j.error)) || 'AI 网关返回错误';
            const msg = typeof m === 'string' ? m : JSON.stringify(m);
            return reject(new ChatError('UPSTREAM_ERROR', String(msg).replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-****')));
          }
          const msgObj = j && j.choices && j.choices[0] && j.choices[0].message;
          const reply = msgObj && msgObj.content;
          if (!reply) {
            // 思考模式下可能预算被思考耗尽：content 空但 reasoning_content 有值
            if (msgObj && msgObj.reasoning_content) {
              return reject(new ChatError('BAD_RESPONSE',
                '模型把 token 预算全用在思考上了，没产出正文（可调低 reasoning_effort 或加大 max_tokens）'));
            }
            return reject(new ChatError('BAD_RESPONSE', 'AI 返回内容为空：' + out.slice(0, 200)));
          }
          resolve(reply);
        } catch (e) { reject(new ChatError('BAD_RESPONSE', '解析 AI 返回失败：' + out.slice(0, 200))); }
      });
    });
    req.on('error', (e) => {
      reject(new ChatError(e && e.code === 'ENOTFOUND' ? 'NETWORK' : 'NETWORK',
        '网络连接失败：' + ((e && e.message) || e)));
    });
    req.setTimeout(25000, () => {
      const err = new ChatError('TIMEOUT', 'AI 请求超时（25 秒无响应），请稍后重试');
      req.destroy(err);
    });
    req.write(payload);
    req.end();
  });
}

function isRetryableError(e) {
  const msg = String(e && e.message || e).toLowerCase();
  return /socket|tls|econnreset|hang up|disconnected|etimedout|timeout|network|getaddrinfo|ENOTFOUND|ECONNREFUSED/i.test(msg);
}

// ---------------- 流式调用（SSE） ----------------
// 首字延迟是体验的关键：非流式要等整段生成完（2–3 秒），流式首个 token 通常 300–800ms。
// 回调 onDelta(text) 逐块交付；返回 { finishReason } 或抛错。
function streamModel({ system, messages, apiKey, model, apiBase, maxTokens, temperature, onDelta, signal }) {
  return new Promise((resolve, reject) => {
    const cleanMessages = normalizeMessages(messages);
    const body = {
      model,
      messages: [{ role: 'system', content: system }, ...cleanMessages],
      temperature,
      max_tokens: maxTokens,
      stream: true
    };
    const base = (apiBase || DEEPSEEK_BASE).replace(/\/+$/, '');
    const targetUrl = base + '/chat/completions';
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new ChatError('BAD_URL', '接口地址非法')); }

    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
      agent: false, servername: u.hostname,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        let errBody = '';
        resp.on('data', d => errBody += d);
        resp.on('end', () => reject(new ChatError('HTTP_' + resp.statusCode,
          '上游返回 ' + resp.statusCode + '：' + String(errBody).slice(0, 160))));
        return;
      }
      let buf = '';
      let finishReason = null;
      resp.setEncoding('utf8');
      resp.on('data', chunk => {
        buf += chunk;
        // SSE 以空行分隔事件
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { finishReason = finishReason || 'stop'; return; }
          try {
            const j = JSON.parse(data);
            const choice = j.choices && j.choices[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta && choice.delta.content;
            if (delta) onDelta(delta);
          } catch (e) { /* 忽略不完整片段 */ }
        }
      });
      resp.on('end', () => resolve({ finishReason }));
      resp.on('error', e => reject(new ChatError('STREAM_ERROR', String(e && e.message || e))));
    });

    req.on('error', e => reject(new ChatError('NETWORK', '网络连接失败：' + (e && e.message || e))));
    // 6 秒无响应即判失败：交给上层回落非流式，避免用户干等 30 秒
    req.setTimeout(6000, () => req.destroy(new ChatError('TIMEOUT', '流式请求 6 秒无响应')));

    if (signal) {
      signal.addEventListener('abort', () => req.destroy(new ChatError('ABORTED', '客户端已断开')));
    }

    req.write(payload);
    req.end();
  });
}

async function callAiping(personaId, messages, apiKeyOverride, forceModel, apiBase, opts = {}) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      return await callAipingOnce(personaId, messages, apiKeyOverride, forceModel, apiBase, opts);
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e)) throw e;
      await new Promise(r => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

// ---------------- 百度语音识别（短语音识别极速版，仅用内置 https） ----------------
let baiduTokenCache = { key: '', token: '', exp: 0 };
function getBaiduToken(apiKey, secretKey) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    if (baiduTokenCache.key === apiKey && baiduTokenCache.token && baiduTokenCache.exp > now) {
      return resolve(baiduTokenCache.token);
    }
    const url = 'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=' +
      encodeURIComponent(apiKey) + '&client_secret=' + encodeURIComponent(secretKey);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET'
    }, (resp) => {
      let out = '';
      resp.on('data', d => out += d);
      resp.on('end', () => {
        try {
          const j = JSON.parse(out);
          if (!j.access_token) return reject(new Error('获取百度 token 失败: ' + (j.error_description || out.slice(0, 160))));
          baiduTokenCache = { key: apiKey, token: j.access_token, exp: now + (parseInt(j.expires_in, 10) || 2592000) * 1000 - 60000 };
          resolve(j.access_token);
        } catch (e) { reject(new Error('解析百度 token 失败: ' + out.slice(0, 160))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('获取百度 token 超时')));
    req.end();
  });
}
function callBaiduAsr(apiKey, secretKey, audioBase64, audioLen) {
  return getBaiduToken(apiKey, secretKey).then(token => new Promise((resolve, reject) => {
    const body = JSON.stringify({
      format: 'wav', rate: 16000, channel: 1, cuid: 'jianan_web',
      token, speech: audioBase64, len: audioLen, dev_pid: 1537
    });
    const u = new URL('https://vop.baidu.com/server_api');
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (resp) => {
      let out = '';
      resp.on('data', d => out += d);
      resp.on('end', () => {
        try {
          const j = JSON.parse(out);
          if (j && j.err_no === 0 && j.result && j.result.length) resolve(j.result[0]);
          else reject(new Error('百度识别失败: ' + (j && (j.err_msg || j.error) || out.slice(0, 160))));
        } catch (e) { reject(new Error('解析百度识别失败: ' + out.slice(0, 160))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('百度识别超时')));
    req.write(body);
    req.end();
  }));
}

// ---------------- 访问门：口令 / 邀请码（轻量访问控制，不做注册登录） ----------------
// 为什么必须有这层：/chat 是公网可直达的接口，服务端持有的是你自己的 DeepSeek Key。
// 没有门，任何人拿到链接都能用你的 Key 无限聊天，账单记在你头上。
// 设计取舍：只做「一个口令 → 一个有时效的 Cookie」，不做账号体系，熟人小范围分享够用。
// 没配置 ACCESS_CODE 时整层自动关闭，本地开发不受影响。
const ACCESS_CODES = (process.env.ACCESS_CODE || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const GATE_ON = ACCESS_CODES.length > 0;
const GATE_TTL_DAYS = Number(process.env.ACCESS_TTL_DAYS || 30);
const COOKIE_NAME = 'ja_pass';
// 签名密钥由口令派生：服务重启后已发出的 Cookie 仍然有效，熟人不用重新输码
const GATE_SECRET = crypto.createHash('sha256').update('jianan-gate|' + ACCESS_CODES.join('|')).digest();

function signGate(exp) {
  const payload = 'v1.' + exp;
  return payload + '.' + crypto.createHmac('sha256', GATE_SECRET).update(payload).digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}
function parseCookie(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
/** 校验访问凭证；未开启门时恒为 true */
function gateAllows(req) {
  if (!GATE_ON) return true;
  const v = parseCookie(req.headers.cookie)[COOKIE_NAME];
  if (!v) return false;
  const parts = String(v).split('.');
  if (parts.length !== 3) return false;
  const exp = Number(parts[1]);
  if (!exp || Date.now() > exp) return false;
  return safeEqual(v, signGate(parts[1]));
}
function matchCode(input) {
  const s = String(input || '').trim().toLowerCase();
  return ACCESS_CODES.some(c => c.toLowerCase() === s);
}
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

// —— 轻量限流：防口令爆破 + 防 Key 被盗刷（内存计数，重启清零；够用且不引外部依赖）——
const failLog = new Map();    // ip -> { n, until }
const chatRate = new Map();   // ip -> { min, minN, day, dayN }
let globalDay = '', globalDayN = 0;
const MAX_FAIL = 8, FAIL_WINDOW = 15 * 60 * 1000;
// 三道闸门都留了环境变量口子，便于按实际人数调，也便于本地用极小值做限流自测
const CHAT_PER_MIN = Number(process.env.CHAT_PER_MIN || 10);      // 单 IP 每分钟
const CHAT_PER_DAY = Number(process.env.CHAT_PER_DAY || 150);     // 单 IP 每天
const CHAT_GLOBAL_DAY = Number(process.env.CHAT_GLOBAL_DAY || 600); // 全站每天（守住 Key 预算）

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function failBlocked(ip) {
  const r = failLog.get(ip);
  return !!(r && r.n >= MAX_FAIL && Date.now() < r.until);
}
function failHit(ip) {
  const r = failLog.get(ip) || { n: 0, until: 0 };
  r.n += 1; r.until = Date.now() + FAIL_WINDOW;
  failLog.set(ip, r);
}
function chatQuota(ip) {
  const now = Date.now(), min = Math.floor(now / 60000), day = todayKey();
  const r = chatRate.get(ip) || { min: 0, minN: 0, day: '', dayN: 0 };
  if (r.min !== min) { r.min = min; r.minN = 0; }
  if (r.day !== day) { r.day = day; r.dayN = 0; }
  if (r.minN >= CHAT_PER_MIN) return { ok: false, msg: '说得有点快，歇一分钟再继续。' };
  if (r.dayN >= CHAT_PER_DAY) return { ok: false, msg: '你今天说得很多了，明天再来也不迟。' };
  if (globalDay !== day) { globalDay = day; globalDayN = 0; }
  if (globalDayN >= CHAT_GLOBAL_DAY) return { ok: false, msg: '今天来这儿的人有点多，明天再来吧。' };
  r.minN += 1; r.dayN += 1; globalDayN += 1;
  chatRate.set(ip, r);
  return { ok: true };
}

// —— 口令页：没凭证时，任何静态路径都返回它（含 index.html，防止绕过）——
const GATE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>见岸 · 请输入访问口令</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       background:linear-gradient(160deg,#e6f4f1,#f6f8f7);color:#1f2d3d;padding:24px}
  .card{width:100%;max-width:400px;background:#fff;border-radius:28px;padding:40px 28px;
        box-shadow:0 12px 40px rgba(14,148,136,.10);text-align:center}
  .logo{font-size:60px;line-height:1}
  .name{font-size:30px;font-weight:800;color:#0e9488;letter-spacing:4px;margin-top:12px}
  .slogan{font-size:15px;color:#6b7c8d;margin-top:8px}
  .hint{font-size:14px;color:#6b7c8d;margin:26px 0 14px;line-height:1.7}
  input{width:100%;padding:15px 16px;font-size:17px;border:2px solid #dfe7ea;border-radius:16px;
        outline:none;text-align:center;letter-spacing:2px;background:#fbfdfd}
  input:focus{border-color:#0e9488}
  button{margin-top:14px;width:100%;padding:15px;font-size:17px;font-weight:700;color:#fff;
         border:none;border-radius:16px;background:#0e9488;cursor:pointer}
  button:active{opacity:.75}
  .err{margin-top:14px;font-size:14px;color:#d9534f;min-height:20px}
  .foot{margin-top:22px;font-size:12px;color:#9aa8b4;line-height:1.6}
</style>
</head>
<body>
  <div class="card">
    <div class="logo">&#127965;&#65039;</div>
    <div class="name">见岸</div>
    <div class="slogan">你不必独自扛着</div>
    <div class="hint">这是一个小范围使用的私享入口。<br>输入访问口令，一次验证可保留 30 天。</div>
    <form id="f" autocomplete="off">
      <input id="c" type="password" placeholder="访问口令" autofocus>
      <button type="submit">进入</button>
    </form>
    <div class="err" id="e"></div>
    <div class="foot">忘记口令请联系分享给你链接的人</div>
  </div>
<script>
  var f=document.getElementById('f'),c=document.getElementById('c'),e=document.getElementById('e');
  f.onsubmit=function(ev){
    ev.preventDefault();
    if(!c.value.trim()){e.textContent='请先输入口令';return;}
    e.textContent='';
    var b=document.querySelector('button');b.disabled=true;b.textContent='验证中…';
    fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({code:c.value})})
      .then(function(r){return r.json()})
      .then(function(j){
        if(j&&j.ok){location.replace('/');}
        else{e.textContent=(j&&j.error)||'口令不对，再看看？';
             b.disabled=false;b.textContent='进入';c.value='';c.focus();}
      })
      .catch(function(){e.textContent='网络不太顺，再试一次';b.disabled=false;b.textContent='进入';});
  };
</script>
</body>
</html>`;

function handleUnlock(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!GATE_ON) { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
  const ip = clientIp(req);
  if (failBlocked(ip)) {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: false, error: '尝试次数太多，请 15 分钟后再试。' }));
    return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let code = '';
    try { code = JSON.parse(body || '{}').code; } catch (e) { /* 空 body 视为错误口令 */ }
    if (!matchCode(code)) {
      failHit(ip);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: '口令不对，再看看？' }));
      return;
    }
    failLog.delete(ip);
    const maxAge = GATE_TTL_DAYS * 86400;
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${signGate(Date.now() + maxAge * 1000)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  });
}

// ---------------- 静态托管 + /chat + /stt 代理 ----------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // —— 访问口令：/api/unlock 自身不需要凭证 ——
  if (urlPath === '/api/unlock') { handleUnlock(req, res); return; }

  // —— 没凭证：接口给 401，页面给口令页（含 index.html，防止直接访问 html 绕过）——
  if (!gateAllows(req)) {
    if (urlPath === '/chat' || urlPath === '/stt' || urlPath === '/api/ai/status' || urlPath.startsWith('/api/avatar/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(401);
      res.end(JSON.stringify({
        ok: false, errorCode: 'NO_ACCESS',
        error: '访问口令无效或已过期，请刷新页面重新输入。'
      }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow'
    });
    res.end(GATE_HTML);
    return;
  }

  if (urlPath === '/api/ai/status') {
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
    res.end(JSON.stringify({configured:!!(DEEPSEEK_KEY || AIPING_KEY)}));
    return;
  }
  if (urlPath.startsWith('/api/avatar/')) { handleAvatar(req, res); return; }

  // —— AI 对话流式代理（SSE）——
  // 与非流式 /chat 共用同一套安全分诊与 OCD 路由，只是把回复改成边生成边推送。
  if (urlPath === '/chat/stream') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const started = Date.now();
      let closed = false;
      // 注意：要监听 res 的 close，不能听 req 的 —— req 的 close 在请求体读完后就会触发，
      // 会把下游的模型请求立刻 abort 掉（表现为「客户端已断开」、首字 0ms、0 字符）。
      const ctrl = new AbortController();
      res.on('close', () => {
        closed = true;
        if (!res.writableEnded) ctrl.abort();
      });

      const send = (obj) => {
        if (closed || res.writableEnded) return;
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* 客户端已断开 */ }
      };

      // 先建立 SSE 通道，避免上游慢时浏览器看不到任何响应
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      if (res.flushHeaders) res.flushHeaders();

      try {
        const quota = chatQuota(clientIp(req));
        if (!quota.ok) { send({ type: 'error', message: quota.msg }); res.end(); return; }

        const { personaId, messages, apiKey, apiBase, model } = JSON.parse(body || '{}');
        const userApiBase = (apiBase || '').trim();
        const userModel = (model || '').trim();
        const effApiKey = apiKey || DEEPSEEK_KEY;
        const effModel = userApiBase ? userModel : DEEPSEEK_MODEL;

        const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
        const lastText = lastUser ? String(lastUser.content || '') : '';
        const safety = assessSafety(lastText);

        // 危机 / 安全确认：不调模型，一次性推完整文案
        if (safety.shouldShowCrisisCard === true || safety.shouldAskSafetyCheck === true) {
          const isCrisis = safety.shouldShowCrisisCard === true;
          const text = isCrisis
            ? CRISIS_REPLY
            : (safety.target === 'other' ? OTHER_PERSON_CHECK_REPLY : SAFETY_CHECK_REPLY);
          const emo = isCrisis ? { label: 'crisis', source: 'safety', mode: 'on' } : finalizeEmotion(null, safety, 'on');
          send({
            type: 'meta',
            persona: findPersona(personaId).name,
            isCrisis,
            safety,
            emotion: emo,
            ocd: null,
            firstByteMs: Date.now() - started
          });
          send({ type: 'delta', text });
          send({ type: 'done' });
          res.end();
          return;
        }

        // OCD 路由与提示词组装（纯计算，毫秒级）
        const subtype = classifySubtype(lastText);
        const comorbidity = detectComorbidity(lastText);
        const priority = decidePriority({ text: lastText, subtype: subtype.subtype, flags: comorbidity.flags });
        const persona = findPersona(personaId);
        const specialist = SPECIALIST_PERSONAS[personaId] || SPECIALIST_PERSONAS.jianan;
        const system = buildPersonaSystem(
          { prompt: specialist + '\n\n' + persona.prompt },
          {
            subtype: subtype.subtype,
            priority: priority.level,
            flags: comorbidity.flags,
            knowledge: buildContext(subtype.subtype, priority.level)
          }
        );

        const ruleEmotion = classifyRule(lastText);
        const emotion = finalizeEmotion(ruleEmotion, safety, 'on');

        send({
          type: 'meta',
          persona: persona.name,
          isCrisis: false,
          safety,
          emotion,
          ocd: {
            subtype: subtype.subtype,
            priority: priority.level,
            dual: priority.dual === true,
            comorbidity: { flags: comorbidity.flags, suggestProfessional: comorbidity.suggestProfessional === true }
          }
        });

        let firstByteSent = false;
        let charCount = 0;

        await streamModel({
          system,
          messages: messages || [],
          apiKey: effApiKey,
          model: effModel,
          apiBase: userApiBase || null,
          maxTokens: persona.maxTokens || 600,
          temperature: persona.temperature || 0.9,
          signal: ctrl.signal,
          onDelta: (text) => {
            if (!text) return;
            charCount += text.length;
            if (!firstByteSent) {
              firstByteSent = true;
              send({ type: 'meta2', firstByteMs: Date.now() - started });
            }
            send({ type: 'delta', text });
          }
        });

        // 空回复兜底：流式一个字都没出来
        if (charCount === 0) {
          send({ type: 'delta', text: '这次没能生成回复，可以再说一句，或者换个说法试试。' });
        }
        send({ type: 'done', totalMs: Date.now() - started, chars: charCount });
        res.end();
      } catch (e) {
        console.error('[/chat/stream] 失败', { code: e && e.code, msg: e && e.message });
        send({ type: 'error', message: String(e && e.message || e), errorCode: (e && e.code) || 'UNKNOWN' });
        try { res.end(); } catch (err) { /* ignore */ }
      }
    });
    return;
  }

  // —— AI 对话代理（同源）——
  if (urlPath === '/chat') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
          // 用量闸门：先扣额度再调模型，避免 Key 被人拿去无限刷
          const quota = chatQuota(clientIp(req));
          if (!quota.ok) {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: false, error: quota.msg, errorCode: 'RATE_LIMIT' }));
            return;
          }
          const { personaId, messages, apiKey, apiBase, model } = JSON.parse(body || '{}');
          // 用户没填自定义网关 → 服务端默认走 DeepSeek，让任何设备打开直接能用，无需填 Key
          const userApiBase = (apiBase || '').trim();
          const userModel = (model || '').trim();

          // 用户填了自定义网关，就必须同时给出模型名。
          // 早期版本漏了这个校验：即便没填模型，代码也会用 DEEPSEEK_MODEL 顶上，
          // 结果请求发到用户的网关却带着 DeepSeek 的模型名，报出 400/405 这种看不懂的错。
          if (userApiBase && !userModel) {
            res.writeHead(200);
            res.end(JSON.stringify({
              ok: false,
              error: '你在设置里填了自定义接口地址，但没填模型名。请同时填写对应的「模型名」（如 deepseek-flash、gpt-4o-mini）。',
              errorCode: 'NO_MODEL',
              errorHint: '请补上模型名'
            }));
            return;
          }

          const effApiBase = userApiBase || DEEPSEEK_BASE;
          const effApiKey = apiKey || DEEPSEEK_KEY;
          // 自定义网关用用户填的模型名；默认链路用服务端配置的模型
          const effModel = userApiBase ? userModel : DEEPSEEK_MODEL;

          // ── 1. 安全分诊（纯规则，不调模型，几十毫秒内出结果）──
          const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
          const lastText = lastUser ? String(lastUser.content || '') : '';
          const safety = assessSafety(lastText);

          // 真实危机：不进入模型，直接返回固定文案与热线
          if (safety.shouldShowCrisisCard === true) {
            res.writeHead(200);
            res.end(JSON.stringify({
              ok: true,
              reply: CRISIS_REPLY,
              isCrisis: true,
              persona: findPersona(personaId).name,
              safety,
              emotion: { label: 'crisis', source: 'safety' }
            }));
            return;
          }

          // 需要澄清的安全确认 / 他人风险：同样不进入自由对话
          if (safety.shouldAskSafetyCheck === true) {
            res.writeHead(200);
            res.end(JSON.stringify({
              ok: true,
              reply: safety.target === 'other' ? OTHER_PERSON_CHECK_REPLY : SAFETY_CHECK_REPLY,
              isCrisis: false,
              persona: findPersona(personaId).name,
              safety,
              emotion: finalizeEmotion(null, safety, 'on')
            }));
            return;
          }

          // ── 2. OCD 路由：亚型 / 共病 / 优先级 ──
          const subtype = classifySubtype(lastText);
          const comorbidity = detectComorbidity(lastText);
          const priority = decidePriority({
            text: lastText,
            subtype: subtype.subtype,
            flags: comorbidity.flags
          });

          // ── 3. 组装 system：专精定位 + 人格语气 + OCD 红线 + 知识片段 ──
          const persona = findPersona(personaId);
          const specialist = SPECIALIST_PERSONAS[personaId] || SPECIALIST_PERSONAS.jianan;
          const system = buildPersonaSystem(
            { prompt: specialist + '\n\n' + persona.prompt },
            {
              subtype: subtype.subtype,
              priority: priority.level,
              flags: comorbidity.flags,
              knowledge: buildContext(subtype.subtype, priority.level)
            }
          );

          // ── 4. 调模型 ──
          // 结构化输出（response_format: json_object）在 deepseek-flash 上存在已知缺陷：
          // 「带 assistant 历史 + 长 system」时会输出整段空白（finish=stop，token 全花在空格上）。
          // 默认关闭结构化，直接走纯文本；情绪改用规则通道。
          // 需要模型情绪时设 EMOTION_STRUCTURED=1 打开（关闭是本项目实测后的默认选择）。
          const STRUCTURED_EMOTION = process.env.EMOTION_STRUCTURED === '1';

          let raw = '';
          let parsed = { content: '', emotion: null, parseStatus: 'skipped' };
          let reply = '';

          if (STRUCTURED_EMOTION) {
            try {
              raw = await callAiping(personaId, messages || [], effApiKey, effModel, userApiBase || null, {
                system: buildStructuredSystem(system),
                structured: true
              });
              parsed = parseAssistantContent(raw, true);
              reply = (parsed.content && parsed.content.trim()) ? parsed.content : '';
            } catch (e1) {
              parsed = { content: '', emotion: null, parseStatus: 'structured_failed' };
            }
          }

          // 未开结构化，或结构化没拿到正文 → 纯文本
          if (!reply) {
            raw = await callAiping(personaId, messages || [], effApiKey, effModel, userApiBase || null, {
              system,
              structured: false
            });
            parsed = parseAssistantContent(raw, false);
            reply = (parsed.content && parsed.content.trim()) ? parsed.content : '';
          }

          // 仍然空：给用户一句可操作的提示，而不是一个空白气泡
          if (!reply) {
            reply = '这次没能生成回复，可以再说一句，或者换个说法试试。';
          }

          // ── 5. 情绪：规则优先，模型标签兜底，危机已在上方覆盖 ──
          const ruleEmotion = classifyRule(lastText);
          const candidate = ruleEmotion
            || (parsed.emotion ? { label: parsed.emotion, source: 'model' } : null);
          const emotion = finalizeEmotion(candidate, safety, 'on');

          res.writeHead(200);
          res.end(JSON.stringify({
            ok: true,
            reply,
            isCrisis: false,
            persona: persona.name,
            safety,
            emotion,
            parseStatus: parsed.parseStatus,
            ocd: {
              subtype: subtype.subtype,
              priority: priority.level,
              dual: priority.dual === true,
              comorbidity: {
                flags: comorbidity.flags,
                suggestProfessional: comorbidity.suggestProfessional === true
              }
            }
          }));
      } catch (e) {
        // 带上 errorCode 与中文提示，前端能直接展示可定位的原因
        const code = (e && e.code) || 'UNKNOWN';
        console.error('[/chat] 调用失败', {
          code,
          msg: (e && e.message) || e,
          model: DEEPSEEK_MODEL,
          key: maskKeyLocal(DEEPSEEK_KEY)
        });
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: false,
          error: String(e && e.message ? e.message : e),
          errorCode: code,
          errorHint: friendlyHint(code)
        }));
      }
    });
    return;
  }

  // —— 语音识别代理（百度，同源）——
  if (urlPath === '/stt') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { audio, len, apiKey, secretKey } = JSON.parse(body || '{}');
        if (!apiKey || !secretKey) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: false, needConfig: true, error: '未配置百度语音 Key' }));
          return;
        }
        const text = await callBaiduAsr(apiKey, secretKey, audio, len || 0);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, text }));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
      }
    });
    return;
  }

  // —— 静态文件 ——
  let sp = urlPath === '/' || urlPath === '' ? '/index.html' : urlPath;
  const safe = path.normalize(sp).replace(/^(\.\.[\/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('见岸公网站已启动: http://0.0.0.0:' + PORT);
});
