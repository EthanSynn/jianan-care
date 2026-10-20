'use strict';

// 见岸 OCD 知识卡：全部为面向普通人的自编短句，供 system prompt 按需注入。
const SUBTYPES = [
  { id: 'contamination', name: '污染/清洗', obsessions: ['担心细菌、污物或传染'], compulsions: ['洗手、消毒、反复清洁'], erpHints: ['从较轻的接触开始，练习延迟清洗并记录不适变化'] },
  { id: 'harm', name: '伤害/攻击', obsessions: ['担心自己会伤害别人或失控'], compulsions: ['回避工具、反复检查记忆、求保证'], erpHints: ['在安全前提下接近触发线索，停止反复确认'] },
  { id: 'sexual', name: '性/禁忌', obsessions: ['出现违背价值观的性或禁忌画面'], compulsions: ['压制念头、反复自证、寻求保证'], erpHints: ['把念头当作心理事件，减少中和与自我审查'] },
  { id: 'religious', name: '宗教/道德', obsessions: ['担心亵渎、做错或承担过度责任'], compulsions: ['忏悔、祈祷、反复道德检查'], erpHints: ['练习允许不确定，逐步减少重复忏悔或确认'] },
  { id: 'relationship', name: '关系', obsessions: ['怀疑是否爱对方、是否选对关系'], compulsions: ['比较感受、测试、反复确认关系'], erpHints: ['把注意力放回共同生活，减少测试和保证循环'] },
  { id: 'symmetry', name: '对称/秩序', obsessions: ['觉得不整齐、不对称或“不对劲”'], compulsions: ['排列、计数、重做直到刚刚好'], erpHints: ['从轻微不整齐开始，允许“差一点”存在'] },
  { id: 'somatic', name: '躯体感觉', obsessions: ['过度关注呼吸、心跳或吞咽等感觉'], compulsions: ['扫描身体、调整呼吸、反复测量'], erpHints: ['观察感觉而不修正，逐步把注意力带回活动'] },
  { id: 'magical', name: '迷信/魔幻思维', obsessions: ['担心数字、动作会带来坏事'], compulsions: ['按数字做、重复动作、避开忌讳'], erpHints: ['从低难度的“不按规则做”开始，等待不确定感过去'] },
  { id: 'hoarding', name: '囤积', obsessions: ['担心丢弃会浪费、后悔或需要用到'], compulsions: ['保存、收集、反复决定是否丢弃'], erpHints: ['先选低价值物品，练习一次决定后不回收'] },
  { id: 'mixed', name: '混合/待了解', obsessions: ['多种主题交织或暂未说清'], compulsions: ['回避、反刍、求保证等混合反应'], erpHints: ['先记录触发、行为、耗时和痛苦，再选择最小一步'] }
];

const MECHANISMS = [
  { id: 'negative-reinforcement', title: '短暂缓解会把循环固定下来', summary: '仪式让焦虑马上下降，大脑就学会下次继续做。', explainForUser: '不是你不够自律，而是“做一下就舒服”在训练这个循环。', misconception: '停止仪式不是靠意志硬扛，而是逐步练习让大脑学会新的安全经验。' },
  { id: 'uncertainty', title: '不确定性不等于危险', summary: '强迫会把“不能百分百确定”解释成必须处理。', explainForUser: '生活本来就没有绝对保证，练习可以从允许一点未知开始。', misconception: '接纳不确定不是放弃责任，而是不再用仪式换确定感。' },
  { id: 'thought-action-fusion', title: '想到不等于做到', summary: '念头、画面和冲动并不会自动变成行为或道德事实。', explainForUser: '大脑会产生各种内容，内容本身不能证明你的意图。', misconception: '与念头相处不是证明它“绝不会发生”，而是减少反复验证。' },
  { id: 'reassurance', title: '保证可能变成下一次怀疑', summary: '反复询问会短暂安心，却让大脑更依赖外部答案。', explainForUser: '可以先说“也许是，也许不是”，把一次确认延迟两分钟。', misconception: '不提供保证不等于冷漠，而是在帮助你脱离循环。' },
  { id: 'erp-learning', title: 'ERP 是安全学习', summary: '暴露并不是逼自己受苦，而是在不做仪式时积累新经验。', explainForUser: '从能承受的一小步开始，观察不适波动并带着它完成生活。', misconception: '目标不是每次都降到零，而是即使有不适也能选择行动。' }
];

const ERP_PLAYBOOK = [
  { step: 1, what: '评估触发、回避和仪式', why: '知道循环在哪里发生', example: '记录情境、念头、行为、耗时和 SUDS' },
  { step: 2, what: '列出恐惧阶梯', why: '从可承受的小步开始', example: '按 0–100 难度排序，不追求一次完成最高级' },
  { step: 3, what: '进行暴露', why: '让大脑获得新的安全经验', example: '接近情境，保持在当下，不急着消除不适' },
  { step: 4, what: '阻止外显和内隐仪式', why: '减少“仪式带来缓解”的强化', example: '不检查、不中和、不寻求保证，先延迟两分钟' },
  { step: 5, what: '复盘与泛化', why: '把练习带回生活', example: '记录前后 SUDS 和下一次最小行动' }
];

const DAILY_MANAGEMENT = [
  { topic: '节律', advice: ['尽量固定起床时间', '留意咖啡因、酒精和压力事件'], caution: '睡眠持续受影响时应单独寻求专业评估' },
  { topic: '家庭配合', advice: ['识别家人替做仪式或反复保证', '用温和、事先约定的方式逐步减少配合'], caution: '减少配合要循序渐进，避免突然冲突' },
  { topic: '复发预防', advice: ['列出早期信号', '提前写好下一次最小练习和求助路径'], caution: '波动不代表之前的努力失效' }
];

const COMORBIDITY = [
  { id: 'depression', name: '情绪低落/抑郁信号', signals: ['没兴趣', '什么都不想做', '无望'], relationToOCD: '耗竭和低落可能降低练习动力，也可能反过来加重强迫负担。', support: ['先安排一件很小的可完成活动', '持续两周或影响功能时建议专业评估'] },
  { id: 'anxiety', name: '焦虑/惊恐信号', signals: ['控制不住地担心', '心慌', '惊恐'], relationToOCD: '焦虑和强迫可以同时存在，需要分别看待。', support: ['先放慢呼吸和脚底触感', '反复发作时寻求专业评估'] },
  { id: 'sleep', name: '睡眠信号', signals: ['睡不着', '失眠', '早醒'], relationToOCD: '睡眠不足会放大痛苦，但睡眠问题有自己的处理路径。', support: ['固定起床时间、减少晚间刺激', '持续影响白天功能时就医评估'] },
  { id: 'substance', name: '酒精/药物助眠信号', signals: ['靠酒才能睡', '吃药助眠'], relationToOCD: '依赖物质需要独立关注，不能简单归因于强迫。', support: ['不要自行加量或突然停药', '尽快咨询精神科或成瘾相关专业'] },
  { id: 'adhd', name: '注意力/冲动信号', signals: ['从小就坐不住', '注意力集中不了'], relationToOCD: '注意力问题与检查、反刍的机制不同，可能共存。', support: ['整理从小到大的表现', '可请精神科做鉴别评估'] },
  { id: 'tic', name: '抽动信号', signals: ['眨眼控制不住', '清嗓子', '抽动'], relationToOCD: '抽动是动作或声音冲动，需与强迫行为区分。', support: ['记录出现时间和诱因', '持续或受伤时寻求专业评估'] },
  { id: 'eating', name: '进食信号', signals: ['暴食', '催吐', '不敢吃'], relationToOCD: '进食问题有独立风险，不能只按强迫处理。', support: ['优先保证安全和基本进食', '尽快找精神科或进食障碍专业帮助'] },
  { id: 'trauma', name: '创伤相关信号', signals: ['闪回', '噩梦', '一提到就发抖'], relationToOCD: '过去经历的重现与对未来的强迫性怀疑处理路径不同。', support: ['先回到当下和安全环境', '需要时寻求创伤知情的专业帮助'] }
];

const RED_LINES = [
  '不做诊断，不把信号当作结论。',
  '不提供具体药物、剂量或停药方案。',
  '不替用户保证念头一定不会发生，也不鼓励反复确认。',
  '出现即时自伤或伤人危险时，安全流程优先并联系 12356、120 或 110。'
];

function subtypeById(id) { return SUBTYPES.find(item => item.id === id) || SUBTYPES[SUBTYPES.length - 1]; }

function buildContext(subtype, intent) {
  const item = subtypeById(subtype);
  const mechanism = intent === 'P1' ? MECHANISMS.find(m => m.id === 'negative-reinforcement') : MECHANISMS.find(m => m.id === 'erp-learning');
  const lines = [
    `当前主题：${item.name}（${item.id}）`,
    `常见体验：${item.obsessions.join('、')}`,
    `可能的反应：${item.compulsions.join('、')}`,
    `练习提示：${item.erpHints[0]}`,
    `机制：${mechanism.explainForUser}`,
    `纠偏：${mechanism.misconception}`,
    '回答时先回应当下痛苦，再给一个可执行的小动作；不诊断，不保证，不给药物方案。'
  ];
  return lines.join('\n').slice(0, 1200);
}

module.exports = { SUBTYPES, MECHANISMS, ERP_PLAYBOOK, DAILY_MANAGEMENT, COMORBIDITY, RED_LINES, buildContext };
