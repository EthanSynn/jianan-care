/* The product's /chat backend owns dialogue and safety; Xingyun only speaks its reply. */
window.jiananAvatar = (() => {
  let agent = null, generation = 0, turn = 0, ready = false, busy = false, scriptPromise;
  // localMode：星云凭证未配置时的降级形态——保留静态形象，用浏览器语音合成播报。
  let localMode = false;
  const el = id => document.getElementById(id);
  let persona = 'jianan';
  const names = {jianan:'见岸', xiaoxian:'小暖', anxin:'安心'};
  const panel = el('avatarPanel');
  const anchor = document.createComment('avatar panel home');
  panel.before(anchor);
  function preview() {
    const stage = el('agent-avatar');
    stage.style.backgroundImage = names[persona] ? 'url("/avatar-previews/' + persona + '.jpg")' : 'none';
    stage.style.backgroundSize = 'contain';
    stage.style.backgroundPosition = 'center';
    stage.style.backgroundRepeat = 'no-repeat';
    stage.setAttribute('aria-label', (names[persona] || '') + '数字人');
  }
  function expand() {
    document.querySelector('.screen').appendChild(panel);
    panel.classList.add('avatar-full');
    el('avatarSubtitle').textContent = '';
  }
  function collapse() {
    panel.classList.remove('avatar-full');
    anchor.after(panel);
  }
  const status = text => { el('avatarStatus').textContent = text; };
  function controls() {
    el('avatarConnect').disabled = busy || ready;
    el('avatarTest').disabled = !ready;
    el('avatarStop').disabled = !ready;
    el('avatarDisconnect').disabled = !agent && !busy && !localMode;
  }
  function loadSDK() {
    if (window.XingyunAvatarAgent) return Promise.resolve();
    if (!scriptPromise) scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/xingyun/xmovAvatar_e2e.js';
      script.onload = resolve;
      script.onerror = () => { script.remove(); scriptPromise = null; reject(Error('数字人资源加载失败，请检查网络')); };
      document.head.appendChild(script);
    });
    return scriptPromise;
  }
  async function disconnect() {
    const version=++generation; turn++; ready = false; busy = true;
    if (localMode) { localMode = false; try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {} }
    collapse();
    const old = agent; agent = null; controls();
    status('数字人未连接');
    if (old) { try { await old.destroy('user'); } catch {} }
    if(version!==generation)return;
    if (!agent) el('agent-avatar').replaceChildren();
    preview();
    busy = false; controls();
  }
  async function connect() {
    if (busy || ready || agent) return;
    const version = ++generation;
    const name = names[persona];
    busy = true; expand(); controls(); status('正在连接' + name + '…');
    try {
      const response = await fetch('/api/avatar/config?persona=' + persona);
      if (!response.ok) throw Error('请刷新页面，检查访问权限');
      const config = await response.json();
      if(version!==generation)return;
      if (!config.configured) throw Error('服务端尚未配置星云凭证');
      await loadSDK();
      if (version !== generation) return;
      const current = new window.XingyunAvatarAgent({
        container:el('agent-avatar'), appId:config.appId, appSecret:'',
        gatewayServer:location.origin + config.gateway,
        onMessage(error) { if (version === generation && error && error.code) status('数字人提示：' + (error.message || error.code)); },
        agentCallbacks:{
          onAgentStateChange(state) {
            if (version !== generation) return;
            if (['stopped','destroyed','reconnecting'].includes(state)) { ready = false; controls(); status('数字人连接已中断，请断开后重连'); }
            if (state === 'running') { ready = true; controls(); status(name + '已连接，可以试听或发消息'); }
          },
          onConversationChange(event) {
            if (version !== generation) return;
            if (['speaking','speaking-directly'].includes(event.state)) status(name + '正在说话…');
            if (event.state === 'completed') status(name + '在听');
          },
          onError(error) { if (version === generation) status('数字人提示：' + (error.message || error.code || '连接异常')); }
        }
      });
      agent = current;
      await current.init({onDownloadProgress(progress) { if(version === generation && busy) status('正在加载形象 ' + progress.toFixed(0) + '%'); }});
      if (version !== generation) { await current.destroy('user'); return; }
      ready = true; status(name + '已连接，可以试听或发消息');
    } catch (error) {
      if (version !== generation) return;
      const msg = String((error && error.message) || error || '');
      const old = agent; agent = null; ready = false;
      if (old) { try { await old.destroy('init_failed'); } catch {} }

      // 星云凭证未配置：不当作故障，降级为「静态形象 + 浏览器语音播报」。
      // 这样即使没有数字人服务，仍能演示完整对话与播报，凭证到位后重连即自动切换回真数字人。
      if(version!==generation)return;
      if (/尚未配置星云凭证/.test(msg)) {
        // 注意：不要用 speechSynthesis.getVoices() 判断是否支持中文——
        // 它在页面刚加载时通常返回空数组（语音列表异步加载），会误判为不支持。
        // 直接进本地模式，播报失败时再提示。
        localMode = true; ready = true; busy = false;
        expand(); preview(); controls();
        status(names[persona] + ' · 本地语音模式（数字人未开通）');
        return;
      }

      collapse();
      status('连接失败：' + msg);
    } finally { if (version === generation) { busy = false; controls(); } }
  }
  function interrupt() {
    turn++;
    if (localMode) {
      try { window.speechSynthesis && window.speechSynthesis.cancel(); status('已停止播报'); } catch {}
      return;
    }
    if (ready && agent) { try { agent.interrupt('speak'); status('已停止播报'); } catch {} }
  }
  function speak(text, ticket) {
    if (ticket !== undefined && ticket !== turn) return;
    if (!text || el('avatarPanel').hidden) return;
    el('avatarSubtitle').textContent = text;

    // 降级形态：静态形象 + 浏览器语音合成，无需任何云端凭证
    if (localMode) {
      const speechGeneration=generation, speechTurn=turn;
      const current=()=>localMode && generation===speechGeneration && turn===speechTurn;
      try {
        if (!window.speechSynthesis) { status('当前浏览器不支持语音播报，文字可正常阅读'); return; }
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-CN';
        utter.rate = 0.95;
        utter.pitch = 1;
        utter.onstart = () => current() && status(names[persona] + '正在说话…');
        utter.onend = () => current() && status(names[persona] + '在听');
        utter.onerror = () => current() && status('语音播放失败，文字仍可阅读');
        window.speechSynthesis.speak(utter);
      } catch { status('语音播放失败，文字仍可阅读'); }
      return;
    }

    if (!ready || !agent) return;
    try { agent.speak(text, true, true); } catch { status('播报失败，请断开后重连；文字仍可阅读'); }
  }
  function begin() { interrupt(); return turn; }
  function sync(nextPersona, chatActive) {
    const changed = persona !== nextPersona;
    const visible = !!names[nextPersona] && chatActive;
    el('avatarPanel').hidden = !visible;
    if ((!visible || changed) && (agent || busy || localMode)) void disconnect();
    persona = nextPersona;
    preview();
  }
  el('avatarConnect').onclick = connect;
  el('avatarDisconnect').onclick = disconnect;
  el('avatarStop').onclick = interrupt;
  el('avatarTest').onclick = () => { interrupt(); speak('你好，我是' + names[persona] + '。很高兴在这里和你见面。你可以慢慢说，我会认真听。'); };
  el('avatarChatForm').onsubmit = async event => {
    event.preventDefault();
    const input = el('avatarChatInput'), text = input.value.trim();
    if (!text || input.disabled) return;
    el('chatInput').value = text; input.disabled = true;
    el('avatarSubtitle').textContent = '我在听，正在回复…';
    try { await window.sendMsg(); if(!el('chatInput').value)input.value=''; }
    finally { input.disabled = false; }
  };
  window.addEventListener('pagehide', () => { void disconnect(); });
  controls();
  preview();
  return {begin, speak, sync, interrupt};
})();
