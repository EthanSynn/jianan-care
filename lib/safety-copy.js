'use strict';

const CRISIS_REPLY = '我很担心你现在的安全。请先告诉我：你此刻是否已经准备了伤害自己的物品，或正在实施？如果是，请立即拨打 120、110 或全国心理援助热线 12356，并尽快让身边可信任的人来到你身边。先不要独自承受。';
const SAFETY_CHECK_REPLY = '我想先确认你此刻的安全：你现在是否有伤害自己的意图、具体计划，或已经准备了相关物品？';
const OTHER_PERSON_CHECK_REPLY = '我想先确认对方此刻的安全：你提到的这个人现在是否正处于即时危险，或已经准备了伤害自己的物品？';
const OTHER_PERSON_DANGER_REPLY = '谢谢你确认。请立即联系 120、110 或全国心理援助热线 12356，并尽量让一位可信任的人陪在对方身边；如果安全可行，移开可能造成伤害的物品。不要独自承担救援，也不要为了阻止对方而让自己处于危险中。';

const SAFETY_CHECK_INSTRUCTION = [
  '【本轮安全确认】',
  '本轮只做一件事：用直接、平静、不评判的语言询问用户现在是否有伤害自己的意图、具体计划，或已经准备了相关物品。',
  '只问一个问题，不做诊断，不继续普通话题，不连续审问，不用长篇解释。'
].join('\n');

const OCD_SUPPORT_INSTRUCTION = [
  '【OCD侵入性思维支持】',
  '用户的表达更像害怕、排斥或反复确认可怕念头，但这不是医学诊断。',
  '不要分析念头内容是真是假，不要保证“你绝不会做”，不要证明用户是好人或安全的。',
  '先简短承认不适；若本轮尚未完成安全确认，只问一次是否存在现实意图、计划或已准备物品；确认没有后，邀请用户允许不确定感暂时存在，并给一个很小的当下行动。'
].join('\n');

const OTHER_PERSON_INSTRUCTION = [
  '【帮助他人安全确认】',
  '用户主要在描述朋友或家属的风险，不要把用户本人标记为危机。',
  '先询问对方是否正处于即时危险或已经准备相关物品；如是，建议用户立即联系 120、110、12356 或当地急救，并尽量让可信任的人陪在对方身边。不要让用户独自承担救援责任。'
].join('\n');

const UNCERTAINTY_PAUSE_INSTRUCTION = [
  '【不确定性暂停键】',
  '用户可能正在重复寻求确定答案。不要继续证明、保证或反复分析念头。',
  '温和指出继续确认可能只能带来短暂缓解，邀请用户把再次确认推迟两分钟，并观察不适变化。最多提出一个问题；用户拒绝时尊重并继续普通陪伴。'
].join('\n');

module.exports = {
  CRISIS_REPLY,
  SAFETY_CHECK_REPLY,
  OTHER_PERSON_CHECK_REPLY,
  OTHER_PERSON_DANGER_REPLY,
  SAFETY_CHECK_INSTRUCTION,
  OCD_SUPPORT_INSTRUCTION,
  OTHER_PERSON_INSTRUCTION,
  UNCERTAINTY_PAUSE_INSTRUCTION
};
