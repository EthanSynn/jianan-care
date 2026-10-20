'use strict';

// app/chat/model-output.js
// 模型输出解析纯函数模块：把上游响应拆成「给用户看的正文」与「情绪标签」。
//
// 设计约束（来自审核修订版）：
// 1. parseStatus 五分类：json_ok / plain_text / invalid_emotion / malformed_json / empty。
// 2. JSON 外形明显但解析失败（如截断）→ malformed_json，调用方必须重试或兜底，
//    绝不允许把原始 JSON 片段展示给用户。
// 3. reply 必须是非空字符串，否则视为 malformed。
// 4. emotion 只做提取与白名单校验；crisis 永远不到这里（安全层专属）。
// 5. 支持纯 JSON 与 ```json 代码围栏两种外形。
// 6. 保留 reasoning_content 有值但正文为空的诊断。

const { normalizeModelEmotion } = require('./emotion');

// 追加到 system 末尾的结构化输出指令（shadow/on 模式使用）。
const STRUCTURED_OUTPUT_INSTRUCTION = [
  '【输出协议】只返回一个 JSON 对象，不要输出任何其他文字、解释或代码围栏：',
  '{"reply": "给用户的回复正文", "emotion": "从 calm/sad/anxious/angry/tired/warm 中选一个最能反映用户当前情绪的，不确定就选 calm"}',
  '【情绪标签规则】emotion 只反映"发消息的用户本人"此刻的情绪：',
  '- 用户描述别人的情绪（朋友很难过、家人很焦虑）时，不要把这个情绪当作 emotion；看用户本人是担心、心疼（warm）还是平静（calm）。',
  '- 用户在讨论新闻、论文、影视、科普概念时，emotion 取用户本人的状态，不要取内容里的情绪。',
  '- 用户反复提问、寻求保证时，其情绪更接近 anxious，而不是 calm。',
  '- 你在回复里表达的情绪（安慰、关切）不是 emotion，emotion 只描述用户。'
].join('\n');

function buildStructuredSystem(system) {
  return String(system || '') + '\n\n' + STRUCTURED_OUTPUT_INSTRUCTION;
}

function stripFence(text) {
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  return m ? m[1].trim() : text;
}

/**
 * 解析上游 HTTP 响应体，取出 message.content。
 * 成功返回 { content }；失败返回 { err, ...诊断标志 }（与旧 parseChoices 契约兼容）。
 */
function parseProviderResponse(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    return { err: '返回非 JSON：' + jsonText.slice(0, 120) };
  }
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  // 思考模式下可能 content 为空但 reasoning_content 有值（预算被思考耗尽），单独给提示
  if (msg && !msg.content && msg.reasoning_content) {
    return {
      err: '模型把预算全用在思考上了，没产出正文（可将 reasoning_effort 调低或加大 max_tokens）',
      reasoningOnly: true
    };
  }
  if (!msg || !msg.content) {
    return { err: '返回内容为空', empty: true };
  }
  return { content: msg.content };
}

/**
 * 解析模型正文，拆出 reply 与 emotion。
 * @param {string} content 模型返回的正文
 * @param {boolean} structuredExpected 本轮是否请求了结构化输出
 * @returns {{content:string, emotion:?string, parseStatus:string}}
 */
function parseAssistantContent(content, structuredExpected) {
  const raw = String(content == null ? '' : content).trim();
  if (!raw) {
    return { content: '', emotion: null, parseStatus: 'empty' };
  }
  const body = stripFence(raw);
  const looksJson = body.startsWith('{');

  if (looksJson) {
    let obj = null;
    try {
      obj = JSON.parse(body);
    } catch (e) {
      obj = null;
    }
    if (!obj || typeof obj !== 'object') {
      return { content: '', emotion: null, parseStatus: 'malformed_json' };
    }
    if (typeof obj.reply !== 'string' || !obj.reply.trim()) {
      return { content: '', emotion: null, parseStatus: 'malformed_json' };
    }
    const normalized = normalizeModelEmotion(obj.emotion);
    const hasEmotionField = obj.emotion != null && String(obj.emotion).trim() !== '';
    if (hasEmotionField && normalized === null) {
      // JSON 合法、reply 合法、emotion 非法：保留 reply，丢弃 emotion，不触发重试。
      return { content: obj.reply.trim(), emotion: null, parseStatus: 'invalid_emotion' };
    }
    return { content: obj.reply.trim(), emotion: normalized, parseStatus: 'json_ok' };
  }

  // 未请求结构化却收到非 JSON 内容：正常纯文本放行，情绪交给规则/默认通道。
  return { content: raw, emotion: null, parseStatus: 'plain_text' };
}

module.exports = {
  STRUCTURED_OUTPUT_INSTRUCTION,
  buildStructuredSystem,
  parseProviderResponse,
  parseAssistantContent
};
