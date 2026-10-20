'use strict';

const RULE_VERSION = '2026-10-15.v1';

const LEVELS = Object.freeze({
  CRISIS: 'crisis',
  SAFETY_CHECK: 'safety_check',
  OCD_INTRUSIVE: 'ocd_intrusive',
  NONE: 'none'
});

const ROUTES = Object.freeze({
  CRISIS_RESPONSE: 'CRISIS_RESPONSE',
  CLARIFY_SAFETY: 'CLARIFY_SAFETY',
  OCD_SUPPORT: 'OCD_SUPPORT',
  OTHER_PERSON_SUPPORT: 'OTHER_PERSON_SUPPORT',
  GENERAL: 'GENERAL'
});

const VALID_ANSWERS = new Set(['yes', 'unsure', 'no']);

const HARM_TOPIC_PATTERNS = [
  /自杀|轻生|寻死|自尽/,
  /不想活|活不下去|想死|不想再活/,
  /伤害自己|杀死自己|结束生命|结束自己/,
  /割腕|吞药|跳楼|上吊|服药过量/,
  // 药物吞咽的语境限定（审核修订：不再收泛化的「吞下去」——「我把饭吞了下去」会误报；
  // 「我吃药了」这类遵医嘱陈述同样不命中——只有「把」字处置结构或「吞/服」动作才进入分诊）。
  /药(?:片|丸子|胶囊)?[^。！？\n]{0,10}(?:吞|服)(?:了下去|下去|了)/,
  /把[^。！？\n]{0,8}药(?:片|丸子|胶囊)?[^。！？\n]{0,8}(?:吞|吃|服)(?:了下去|下去|完)/
];

const DIRECT_SELF_WISH_PATTERNS = [
  /我(?:现在|真的|已经|还是|就是|很|一直|总|老是|经常)?想死/,
  /我.{0,8}不想再?活(?:了)?/,
  /我.{0,8}活不下去(?:了)?/,
  /我(?:想|要|准备|打算|决定)自杀/,
  /我(?:想|要|准备|打算|决定)轻生/,
  /我(?:想|要|准备|打算|决定).{0,5}(伤害自己|结束生命|结束自己|杀死自己)/,
  /^(?:想死|不想活了?|活不下去了?|不想再活了?)/,
  /没有计划.{0,8}(?:但|可是|不过|只是)?.{0,4}(?:仍然|还是)?想死/
];

const PLAN_OR_ACTION_PATTERNS = [
  /(?:有|做好了?|制定了?|写下了?)自杀计划/,
  /(?:计划|准备|打算|决定).{0,10}(?:自杀|轻生|割腕|吞药|跳楼|上吊|结束生命)/,
  /(?:自杀|轻生).{0,8}(?:计划|方法|时间|地点)/,
  /(?:写了|写好|留下).{0,5}遗书/,
  /(?:选好|找好|确定了?).{0,5}(?:时间|地点|方法)/,
  /(?:买了|存了|攒了|拿出|拿着|准备了?).{0,8}(?:药|刀|绳)/,
  /把.{0,4}(?:药|刀|绳).{0,6}(?:拿出|准备好|放在)/,
  /(?:站在|到了|正在).{0,5}(?:天台|楼顶|桥边|轨道边)/,
  /(?:已经|正在|刚刚).{0,5}(?:割腕|吞药|跳楼|上吊|服药过量|伤害自己)/,
  /(?:今晚|今天|现在|马上|等会).{0,8}(?:自杀|轻生|结束生命|跳楼|吞药|割腕)/,
  /(?:刀|药|绳).{0,6}(?:在手里|在旁边|已经准备好)/,
  // 药物吞咽动作（语境限定，与 HARM_TOPIC 同源）：
  // 「把药吞下去 / 把药片吃下去」是处置式（已实施或即将实施）；「吃了很多药」是过量信号。
  // 「我吃药了」（遵医嘱、无把字结构）不命中，避免误报。
  /把[^。！？\n]{0,8}药(?:片|丸子|胶囊)?[^。！？\n]{0,8}(?:吞|吃|服)(?:了下去|下去|完)/,
  /(?:吃了|服下|吞下)(?:很多|大量|整瓶|所有|全部的)(?:药|片|安眠药)/,
  /把[^。！？\n]{0,8}(?:安眠药|镇静剂)[^。！？\n]{0,8}(?:吃|吞|服)/
];

const NEGATED_PLAN_PATTERNS = [
  /没有(?:具体)?计划/,
  /没(?:有)?计划/,
  /没有准备任何东西/,
  /没有(?:时间|地点|方法)/,
  /不会去做/,
  /不准备做/,
  /并不打算做/,
  /不想伤害自己/,
  /不想自杀/,
  /并不想死/,
  /没有要自杀/,
  /没有要轻生/
];

const OCD_MARKERS = [
  '强迫', '侵入性', '闯入', '反复冒出', '脑子里冒出', '停不下来的念头',
  '害怕自己', '担心自己', '怕自己', '万一我', '会不会', '是否会',
  '不想这样', '不希望这样', '并不想', '讨厌这个', '只是一个念头',
  '只是害怕', '反复确认', '越想越怕', '画面反复出现'
];

const LOSS_OF_CONTROL_MARKERS = [
  '控制不住', '马上要失控', '怕我会真的做', '不知道能不能忍住',
  '不确定会不会', '可能会做', '怕自己突然做'
];

const INFO_MARKERS = [
  '新闻', '报道', '文章', '电影', '电视剧', '小说', '书里',
  '论文', '课题', '作业', '考试', '词语', '是什么意思', '怎么理解', '科普'
];

const OTHER_PERSON_PATTERNS = [
  /(?:朋友|同学|同事|家人|家属|妈妈|母亲|爸爸|父亲|孩子|儿子|女儿|对象|伴侣|室友).{0,12}(?:不想活|想死|轻生|自杀|伤害自己|割腕|吞药|跳楼|上吊)/,
  /(?:他|她|他们|她们).{0,8}(?:不想活|想死|轻生|自杀|伤害自己|割腕|吞药|跳楼|上吊)/
];

const REASSURANCE_MARKERS = [
  '你确定', '真的没事吗', '保证没事', '你能保证', '再确认一下',
  '是不是一定', '会不会真的', '百分之百', '到底会不会', '确定不会',
  '我是不是', '这说明我', '这意味着我'
];

function normalize(text) {
  // 安全评估窗口 4000 字（原 2000）：用户长文倾诉时，危机语言可能出现在后半段，
  // 截断过早会漏检。4000 字已覆盖绝大多数真实输入，同时保持正则匹配线性可接受。
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”‘’]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function includesAny(text, values) {
  return values.some(value => text.includes(value));
}

function matchesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function safetyResult(level, route, extra) {
  return Object.assign({
    level,
    route,
    target: 'self',
    confidence: 'medium',
    shouldShowCrisisCard: false,
    shouldAskSafetyCheck: false,
    reasonCodes: [],
    instruction: '',
    ruleVersion: RULE_VERSION,
    fallbackUsed: false
  }, extra || {});
}

function normalizeContext(context) {
  const raw = context && typeof context === 'object' ? context : {};
  const safetyAnswer = VALID_ANSWERS.has(raw.safetyAnswer) ? raw.safetyAnswer : null;
  const validRoutes = new Set(Object.values(ROUTES));
  return {
    pendingSafetyCheck: raw.pendingSafetyCheck === true,
    safetyAnswer,
    previousSafetyRoute: validRoutes.has(raw.previousSafetyRoute) ? raw.previousSafetyRoute : null
  };
}

function fromSafetyAnswer(context) {
  if (!context.pendingSafetyCheck || !context.safetyAnswer) return null;
  if (context.previousSafetyRoute === ROUTES.OTHER_PERSON_SUPPORT) {
    if (context.safetyAnswer === 'yes') {
      return safetyResult(LEVELS.SAFETY_CHECK, ROUTES.OTHER_PERSON_SUPPORT, {
        target: 'other',
        confidence: 'high',
        shouldAskSafetyCheck: false,
        reasonCodes: ['OTHER_PERSON_IMMEDIATE_DANGER']
      });
    }
    if (context.safetyAnswer === 'unsure') {
      return safetyResult(LEVELS.SAFETY_CHECK, ROUTES.OTHER_PERSON_SUPPORT, {
        target: 'other',
        confidence: 'medium',
        shouldAskSafetyCheck: true,
        reasonCodes: ['OTHER_PERSON_SAFETY_UNSURE']
      });
    }
    return safetyResult(LEVELS.NONE, ROUTES.OTHER_PERSON_SUPPORT, {
      target: 'other',
      confidence: 'medium',
      reasonCodes: ['OTHER_PERSON_NO_IMMEDIATE_DANGER']
    });
  }
  if (context.safetyAnswer === 'yes') {
    return safetyResult(LEVELS.CRISIS, ROUTES.CRISIS_RESPONSE, {
      confidence: 'high',
      shouldShowCrisisCard: true,
      shouldAskSafetyCheck: true,
      reasonCodes: ['SAFETY_ANSWER_YES']
    });
  }
  if (context.safetyAnswer === 'unsure') {
    return safetyResult(LEVELS.SAFETY_CHECK, ROUTES.CLARIFY_SAFETY, {
      confidence: 'medium',
      shouldAskSafetyCheck: true,
      reasonCodes: ['SAFETY_ANSWER_UNSURE']
    });
  }
  if (context.previousSafetyRoute === ROUTES.OCD_SUPPORT) {
    return safetyResult(LEVELS.OCD_INTRUSIVE, ROUTES.OCD_SUPPORT, {
      confidence: 'medium',
      reasonCodes: ['SAFETY_ANSWER_NO', 'RETURN_TO_OCD_SUPPORT']
    });
  }
  return safetyResult(LEVELS.NONE, ROUTES.GENERAL, {
    confidence: 'medium',
    reasonCodes: ['SAFETY_ANSWER_NO']
  });
}

function assessSafety(input, rawContext) {
  const context = normalizeContext(rawContext);
  const answerResult = fromSafetyAnswer(context);
  if (answerResult) return answerResult;

  const text = normalize(input);
  if (!text) {
    return safetyResult(LEVELS.NONE, ROUTES.GENERAL, {
      confidence: 'high',
      reasonCodes: ['EMPTY_INPUT']
    });
  }

  const negatedPlan = matchesAny(text, NEGATED_PLAN_PATTERNS);
  const planOrAction = !negatedPlan && matchesAny(text, PLAN_OR_ACTION_PATTERNS);
  const hasHarmTopic = matchesAny(text, HARM_TOPIC_PATTERNS);
  if (!hasHarmTopic && !planOrAction) {
    return safetyResult(LEVELS.NONE, ROUTES.GENERAL, {
      confidence: 'high',
      reasonCodes: ['NO_HARM_TOPIC']
    });
  }

  const directSelfWish = matchesAny(text, DIRECT_SELF_WISH_PATTERNS);
  const otherPerson = matchesAny(text, OTHER_PERSON_PATTERNS);
  const informational = includesAny(text, INFO_MARKERS);
  const ocdFraming = includesAny(text, OCD_MARKERS);
  const lossOfControl = includesAny(text, LOSS_OF_CONTROL_MARKERS);

  if (informational && !directSelfWish && !planOrAction) {
    return safetyResult(LEVELS.NONE, ROUTES.GENERAL, {
      target: 'topic',
      confidence: 'high',
      reasonCodes: ['INFORMATIONAL_CONTEXT']
    });
  }

  if (otherPerson && !directSelfWish) {
    return safetyResult(LEVELS.SAFETY_CHECK, ROUTES.OTHER_PERSON_SUPPORT, {
      target: 'other',
      confidence: 'medium',
      shouldAskSafetyCheck: true,
      reasonCodes: ['OTHER_PERSON_RISK']
    });
  }

  if (planOrAction) {
    return safetyResult(LEVELS.CRISIS, ROUTES.CRISIS_RESPONSE, {
      confidence: 'high',
      shouldShowCrisisCard: true,
      shouldAskSafetyCheck: true,
      reasonCodes: ['PLAN_MEANS_OR_ACTION']
    });
  }

  if (directSelfWish && !(ocdFraming && negatedPlan)) {
    return safetyResult(LEVELS.CRISIS, ROUTES.CRISIS_RESPONSE, {
      confidence: 'medium',
      shouldShowCrisisCard: true,
      shouldAskSafetyCheck: true,
      reasonCodes: ['DIRECT_SELF_WISH']
    });
  }

  if (ocdFraming && !lossOfControl) {
    return safetyResult(LEVELS.OCD_INTRUSIVE, ROUTES.OCD_SUPPORT, {
      confidence: negatedPlan ? 'high' : 'medium',
      shouldAskSafetyCheck: !negatedPlan,
      reasonCodes: negatedPlan
        ? ['OCD_FRAMING', 'INTENT_OR_PLAN_NEGATED']
        : ['OCD_FRAMING']
    });
  }

  return safetyResult(LEVELS.SAFETY_CHECK, ROUTES.CLARIFY_SAFETY, {
    target: 'unclear',
    confidence: 'low',
    shouldAskSafetyCheck: true,
    reasonCodes: lossOfControl
      ? ['HARM_TOPIC_AMBIGUOUS', 'LOSS_OF_CONTROL']
      : ['HARM_TOPIC_AMBIGUOUS']
  });
}

function canonicalizeForRepeat(text) {
  // 注意：不要剥离「你确定 / 你能保证 / 是不是 / 会不会」——它们本身就是安慰寻求的标志词。
  // 剥离后不同问题会归一成同一个短串（如「你确定吗」「你确定吧」都变成「吗」），
  // 导致相似度恒为 1.0 的误报。只剥标点、语气词与纯填充语。
  return normalize(text)
    .replace(/[，。！？、,.!?;；:："'（）()]/g, '')
    .replace(/(请|再|一下|真的|到底|就是|那么|所以|我想问|我想知道)/g, '')
    .replace(/[吗呢吧啊呀哦嗯]$/g, '');
}

function similarity(a, b) {
  const left = canonicalizeForRepeat(a);
  const right = canonicalizeForRepeat(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const leftSet = new Set(Array.from(left));
  const rightSet = new Set(Array.from(right));
  let overlap = 0;
  leftSet.forEach(ch => { if (rightSet.has(ch)) overlap += 1; });
  const union = new Set(Array.from(left).concat(Array.from(right))).size;
  return union ? overlap / union : 0;
}

function assessReassuranceLoop(currentText, previousUserTexts) {
  const current = normalize(currentText);
  const history = Array.isArray(previousUserTexts) ? previousUserTexts.slice(-4) : [];
  const hasMarker = includesAny(current, REASSURANCE_MARKERS);
  let repeatScore = 0;
  history.forEach(oldText => {
    repeatScore = Math.max(repeatScore, similarity(current, oldText));
  });
  const likely = hasMarker && repeatScore >= 0.38;
  return {
    likely,
    repeatScore: Number(repeatScore.toFixed(2)),
    reasonCodes: likely ? ['REASSURANCE_MARKER', 'REPEATED_QUESTION'] : [],
    ruleVersion: RULE_VERSION
  };
}

function buildFallbackSafety(legacyHit) {
  if (legacyHit) {
    return safetyResult(LEVELS.CRISIS, ROUTES.CRISIS_RESPONSE, {
      confidence: 'low',
      shouldShowCrisisCard: true,
      shouldAskSafetyCheck: true,
      reasonCodes: ['LEGACY_FALLBACK_MATCH'],
      fallbackUsed: true
    });
  }
  return safetyResult(LEVELS.NONE, ROUTES.GENERAL, {
    confidence: 'low',
    reasonCodes: ['LEGACY_FALLBACK_NO_MATCH'],
    fallbackUsed: true
  });
}

module.exports = {
  RULE_VERSION,
  LEVELS,
  ROUTES,
  assessSafety,
  assessReassuranceLoop,
  buildFallbackSafety,
  similarity
};
