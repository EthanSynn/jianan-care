'use strict';

// app/chat/emotion.js
// 情绪标签纯函数模块（不依赖任何外部服务）。
//
// 设计约束（来自审核修订版）：
// 1. 规则通道追求高精度：只用第一人称锚定的高置信短语，拿不准返回 null 交给模型或默认值。
// 2. 不收宽泛词（崩溃/受不了/恶心/单独出现的抑郁）——这些词在否定句、转述、科普中误判率高。
// 3. 否定语境过滤：「不焦虑了」「没那么难过」不得命中。
// 4. 科普问句与第三人称描述优先返回 null。
// 5. crisis 标签只能由安全层（finalizeEmotion 中的 shouldShowCrisisCard）产生，
//    规则通道与模型通道都无权输出 crisis。
// 6. 文本上限 2000 字，与 index.js 的输入归一化保持一致。

// 非危机标签白名单。模型只允许输出这六个。
const LABELS = Object.freeze(['calm', 'sad', 'anxious', 'angry', 'tired', 'warm']);

// ── 第一人称锚定语法 ──────────────────────────────────────────
// 主语「我」+ 最多 4 个闭类填充词（副词/时间词/频率词/自我指涉短语）+ 情绪核心词。
// 任何非闭类词介入（人名、他人代词、名词）都会断链，从而天然过滤
// 「朋友很难过」「我室友说她压力很大」这类第三人称描述。
const FP = '我';
const GAP = '(?:\\s*(?:真的|确实|简直|说真的|其实|可能|已经|最近|这段时间|每天|晚上|早上|刚才|现在|当时|有时候|经常|总是|一度|完全|整个人|感觉|觉得|今天|昨天|明天|今早|昨晚|近日|近来|就|都|也|还|又|挺|那么|这么)){0,4}';
const DEG = '(?:\\s*(?:很|太|超级|巨|贼|好|有点|特别|非常))?'; // 程度前缀
const SUF = '(?:了|过|死|得不行)?'; // 语气后缀

// 高精度核心词表。刻意剔除审核点名删除的宽泛词：崩溃、受不了、恶心、单独出现的抑郁。
const CORE = {
  sad: ['难过', '伤心', '想哭', '哭了', '委屈', '难受', '低落', '心酸'],
  anxious: ['焦虑', '紧张', '害怕', '心慌', '恐慌', '睡不着', '失眠', '喘不上气'],
  angry: ['烦', '生气', '火大', '愤怒', '恼火'],
  tired: ['累', '没劲', '麻木', '撑不住', '不想动', '精疲力尽'],
  warm: ['感动', '开心', '高兴', '欣慰']
};

// 由核心词表生成规则。warm 额外收「谢谢你/感谢你」，但要求出现在句首或句界，
// 避免「他说谢谢你」这类第三人称转述被当成用户本人情绪（实测漏洞）。
const RULES = Object.keys(CORE).map(label => ({
  label,
  patterns: CORE[label].map(word =>
    new RegExp(FP + GAP + DEG + word + SUF))
})).concat([{
  label: 'warm',
  patterns: [
    /(?:^|[。！？；\n])\s*(?:真的|非常|太|好)?谢谢你/,
    /(?:^|[。！？；\n])\s*(?:真的|非常|太|好)?感谢你/,
    /抱抱/
  ]
}]);

// 否定词：出现在命中位置之前的一定窗口内，则该命中作废（用户可能在说「不焦虑了」）。
const NEGATIONS = ['不', '没', '别', '非', '无', '毫不', '并不', '不怎么', '不太', '没啥', '没有', '未必', '谈不上'];

// 科普/求知问句：这类文本即使含情绪词也是知识提问，交模型处理。
const INFO_PATTERNS = [
  /是什么意思/,
  /什么是/,
  /怎么理解/,
  /科普一下/,
  /解释一下/,
  /如何界定/,
  /有什么区别/
];

const TEXT_LIMIT = 2000;
// 否定词回看窗口（字符数）。
const NEGATION_WINDOW = 6;

function isInformational(text) {
  return INFO_PATTERNS.some(p => p.test(text));
}

function isNegated(text, matchIndex) {
  // 取命中位置之前的窗口，检查否定词。
  const start = Math.max(0, matchIndex - NEGATION_WINDOW);
  const before = text.slice(start, matchIndex);
  return NEGATIONS.some(n => before.includes(n));
}

/**
 * 规则通道：返回六标签之一或 null（拿不准）。
 * @param {string} rawText 用户消息
 * @param {object} [context] 预留上下文（当前未使用，签名稳定便于测试注入 safety）
 */
function classifyRule(rawText, context) {
  const text = String(rawText || '').slice(0, TEXT_LIMIT);
  if (!text) return null;
  if (isInformational(text)) return null;

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const m = pattern.exec(text);
      if (m && !isNegated(text, m.index)) {
        return rule.label;
      }
    }
  }
  return null;
}

// 他人情绪描述检测：用于丢弃模型通道的误判。
// 背景：安全层的 target=other 只覆盖「他人有危机风险」，不覆盖「朋友很难过」这类
// 普通情绪描述。模型会把他人情绪当成用户本人的，因此需要独立判断。
const OTHER_EMOTION_PATTERN = /(?:他|她|他们|她们|朋友|同学|同事|家人|妈妈|母亲|爸爸|父亲|对象|伴侣|室友|孩子|儿子|女儿)[^。！？\n]{0,10}(?:难过|伤心|焦虑|紧张|害怕|生气|烦躁|累|抑郁|崩溃|低落|委屈)/;

function mentionsOtherEmotion(rawText) {
  return OTHER_EMOTION_PATTERN.test(String(rawText || '').slice(0, TEXT_LIMIT));
}

/**
 * 模型通道标签归一化：白名单校验。crisis 与一切非法值返回 null。
 */
function normalizeModelEmotion(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  return LABELS.includes(v) ? v : null;
}

/**
 * 安全层覆盖：危机卡标志为最高优先级，输出 crisis/safety。
 * @param {{label:string, source:string}} candidate 规则或模型给出的候选
 * @param {{shouldShowCrisisCard?: boolean}} safety 安全层结果
 * @param {string} mode off/shadow/on
 */
function finalizeEmotion(candidate, safety, mode) {
  if (safety && safety.shouldShowCrisisCard === true) {
    return { label: 'crisis', source: 'safety', mode };
  }
  const base = candidate && typeof candidate.label === 'string'
    ? { label: candidate.label, source: candidate.source || 'default' }
    : { label: 'calm', source: 'default' };
  return Object.assign({}, base, { mode });
}

module.exports = {
  LABELS,
  RULES,
  classifyRule,
  normalizeModelEmotion,
  mentionsOtherEmotion,
  finalizeEmotion
};
