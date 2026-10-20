'use strict';

const SUBTYPE_RULES = {
  contamination: ['脏', '细菌', '污染', '传染', '洗手', '洗到破皮', '消毒', '清洁'],
  harm: ['伤害别人', '伤害家人', '伤害孩子', '伤害父母', '伤害伴侣', '撞人', '推人', '拿刀', '失控伤人', '万一我做了', '伤人'],
  sexual: ['禁忌念头', '性方面', '性念头', '不敢想', '色情画面'],
  religious: ['亵渎', '报应', '道德', '做错事', '忏悔', '祈祷'],
  relationship: ['他爱不爱我', '是不是对的人', '反复确认关系', '伴侣', '爱不爱'],
  // 检查门锁/煤气/电器属典型 checking 行为，归入对称秩序类（不单独设 checking 亚型）
  symmetry: ['对称', '顺序', '摆正', '必须一样', 'just right', '不对劲', '整齐', '检查', '门锁', '锁门', '门没锁', '煤气', '电器'],
  somatic: ['呼吸', '心跳', '身体感觉', '咽口水', '盯着某个感觉', '吞咽'],
  magical: ['吉利数字', '倒霉', '忌讳', '必须做几次', '数字', '魔法'],
  hoarding: ['扔不掉', '囤着', '舍不得丢', '堆满', '保存东西']
};

const COMORBIDITY_RULES = {
  depression: ['没兴趣', '什么都不想做', '没力气', '活着没意思', '无望', '早醒', '吃不下', '自责', '觉得自己没用'],
  anxiety: ['控制不住地担心', '心慌', '惊恐', '喘不上气', '坐立不安'],
  sleep: ['睡不着', '失眠', '早醒', '整夜醒'],
  substance: ['靠酒才能睡', '喝酒才放松', '吃药助眠', '靠酒睡'],
  adhd: ['从小就坐不住', '注意力集中不了', '老是忘事'],
  tic: ['眨眼控制不住', '清嗓子', '抽动'],
  eating: ['暴食', '催吐', '不敢吃', '体重掉得很快'],
  trauma: ['闪回', '噩梦', '一提到就发抖']
};

const ACUTE_WORDS = ['反复确认', '反复检查', '仪式', '强迫', '忍不住', '停不下来', '反刍', '求保证', '暴露中', 'suds', '冲动', '回去看', '回去再看', '看一眼', '确认一下'];
const INFO_WORDS = ['是什么', '为什么', '机制', '亚型', '怎么做', '计划', '阶梯', '复发', '科普', '解释'];
const OTHER_SUBJECT = /(?:朋友|家人|妈妈|爸爸|同学|同事|伴侣|他人|她|他|孩子|室友)(?:[^。！？!?；;，,]{0,20})/g;

function normalizeTexts(text, history) {
  const list = Array.isArray(history) ? history : [];
  return [...list.slice(-6), text || ''].filter(Boolean).map(item => String(item)).join('\n');
}

function classifySubtype(text, history, modelCandidate) {
  const full = normalizeTexts(text, history);
  const distress = /(痛苦|害怕|焦虑|耗时|影响|停不下|反复|强迫|仪式|不敢|破皮|两小时|每天都)/i.test(full);
  const scores = Object.entries(SUBTYPE_RULES).map(([id, words]) => ({ id, score: words.reduce((n, word) => n + (full.toLowerCase().includes(word.toLowerCase()) ? 1 : 0), 0) }));
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  // 单独一句“我每天洗手/我洗手”缺少痛苦和功能损害信息，暂不贴污染标签。
  if (top && top.id === 'contamination' && !distress && /^\s*我?(每天|经常)?洗手[。！？!?\s]*$/i.test(String(text || ''))) {
    return { subtype: 'mixed', source: 'default', confidence: 0.35 };
  }
  if (!top || top.score === 0) {
    if (Object.prototype.hasOwnProperty.call(SUBTYPE_RULES, modelCandidate)) return { subtype: modelCandidate, source: 'model', confidence: 0.55 };
    return { subtype: 'mixed', source: 'default', confidence: 0.25 };
  }
  const confidence = Math.min(0.98, 0.55 + top.score * 0.1 + (distress ? 0.12 : 0));
  return { subtype: top.id, source: 'rule', confidence };
}

function removeOtherPersonSegments(text) {
  return String(text || '').replace(OTHER_SUBJECT, (match) => /我|自己|本人/.test(match) ? match : '');
}

function detectComorbidity(text, history) {
  const previous = (Array.isArray(history) ? history : []).slice(-5);
  const entries = [...previous, text || ''].map(removeOtherPersonSegments);
  const all = entries.join('\n');
  const flags = [];
  const evidence = [];
  Object.entries(COMORBIDITY_RULES).forEach(([id, words]) => {
    const hit = words.find(word => all.includes(word));
    if (hit) { flags.push(id); evidence.push(`${id}:${hit}`); }
  });
  const count = entries.filter(entry => Object.values(COMORBIDITY_RULES).some(words => words.some(word => entry.includes(word)))).length;
  return { flags, evidence, count, suggestProfessional: flags.length > 0 && (count >= 2 || /(两周|两个星期|半个月|一个月|无法工作|影响生活)/.test(all) || flags.some(id => ['depression', 'substance', 'eating', 'trauma', 'tic', 'adhd', 'anxiety'].includes(id))) };
}

function decidePriority({ safety, subtype, flags, text }) {
  if (safety && (safety.shouldShowCrisisCard === true || safety.level === 'crisis')) return { level: 'P0', reason: '安全危机优先', dual: false };
  const input = String(text || '').toLowerCase();
  const infoOnly = /(?:是什么|为什么|机制|科普|解释|制定.*计划|如何制定)/.test(input) && !/(我.*(?:正在|停不下|忍不住|两个小时|两小时)|我又|帮我阻断)/.test(input);
  const p1 = !infoOnly && (ACUTE_WORDS.some(word => input.includes(word.toLowerCase())) || /检查门锁.*(?:小时|遍)|洗手洗到破皮/.test(input) || (subtype && subtype !== 'mixed' && /(洗到破皮|两个小时|停不下|忍不住)/.test(input)));
  const p3 = Array.isArray(flags) && flags.length > 0;
  if (p1) return { level: 'P1', reason: p3 ? '强迫急性发作并有共病信号' : '强迫急性发作', dual: p3 };
  if (p3) return { level: 'P3', reason: '共病情绪或功能信号', dual: false };
  if (INFO_WORDS.some(word => input.includes(word.toLowerCase())) || (subtype && subtype !== 'mixed')) return { level: 'P2', reason: 'OCD 科普或计划', dual: false };
  return { level: 'P4', reason: '一般支持与闲聊', dual: false };
}

function buildOCDPreamble({ subtype = 'mixed', priority = 'P4', flags = [] } = {}) {
  const comorbidity = flags.length ? `共病提示（仅为信号，不是诊断）：${flags.join('、')}。请独立回应，不要把它们一律归因于 OCD。` : '当前没有识别到明确共病信号。';
  const dual = priority === 'P1' && flags.length ? '本轮先接住强迫急性痛苦，同时明确回应共病信号。' : '';
  return `【OCD 专业路由】当前亚型线索：${subtype}；优先级：${priority}。${comorbidity}${dual}\nP0 安全永远覆盖其他路由；P1 不给保证、不分析念头真伪，提供一个当下可做的小动作；P2 解释机制并给步骤；P3 允许共病议题完整展开；P4 保持简短陪伴。`;
}

module.exports = { classifySubtype, detectComorbidity, decidePriority, buildOCDPreamble, SUBTYPE_RULES, COMORBIDITY_RULES };
