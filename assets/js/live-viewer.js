(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { request, tail } = window.MFFLive;
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || 'main';
  let client; let channel; let snapshot; let connected = false; let fetching = false;
  let stopped = false; let booting = false; let poll; let tick; let bootTimer; let shown = 'en';
  // The audience reads the page in the language it is being translated into.
  const copy = {
    en: { label: 'LIVE CAPTIONS', source: 'Automatically translated in real time.',
      accuracy: 'Names and expressions may contain errors.', size: 'Caption size',
      standard: 'Standard text', large: 'Large text', fullscreen: 'Full screen',
      idle: 'Waiting for the talk', ended: 'Talk ended', reconnecting: 'Reconnecting…',
      connecting: 'Starting…', live: 'Live', waiting: 'Captions will appear when the talk begins.',
      thanks: 'Thank you for joining us.',
      interrupted: 'The live connection was interrupted. The text above is the last received caption.',
      brand: 'LIVE TRANSLATION BY', contact: 'Live caption enquiries' },
    it: { label: 'SOTTOTITOLI LIVE', source: 'Tradotto automaticamente in tempo reale.',
      accuracy: 'Nomi ed espressioni possono contenere errori.', size: 'Dimensione del testo',
      standard: 'Testo standard', large: 'Testo grande', fullscreen: 'Schermo intero',
      idle: 'In attesa del talk', ended: 'Talk terminato', reconnecting: 'Riconnessione…',
      connecting: 'Avvio…', live: 'In diretta', waiting: 'I sottotitoli appariranno all’inizio del talk.',
      thanks: 'Grazie per aver seguito il talk.',
      interrupted: 'Il collegamento si è interrotto. Il testo qui sopra è l’ultimo sottotitolo ricevuto.',
      brand: 'TRADUZIONE LIVE A CURA DI', contact: 'Per info sui sottotitoli live' },
    zh: { label: '实时字幕', source: '实时自动翻译。',
      accuracy: '人名和专有名词可能有误。', size: '字幕大小',
      standard: '标准字号', large: '大字号', fullscreen: '全屏',
      idle: '等待开始', ended: '已结束', reconnecting: '正在重新连接…',
      connecting: '正在启动…', live: '直播中', waiting: '活动开始后将显示字幕。',
      thanks: '感谢观看。',
      interrupted: '连接已中断，以上为最后收到的字幕。',
      brand: '实时翻译提供方', contact: '实时字幕咨询' },
  };
  // The room is international even when the captions are not: every label is
  // said in English and then in the language being translated into.
  let words = copy.en;
  function speak(language) {
    if (language === shown) return;
    shown = language; words = {};
    for (const key in copy.en) {
      const native = copy[language][key];
      words[key] = !native || native === copy.en[key] ? copy.en[key] : copy.en[key] + ' / ' + native;
    }
    document.documentElement.lang = language;
    $('captions').lang = language; $('stage-label').textContent = words.label;
    $('source-note').textContent = words.source; $('accuracy-note').textContent = words.accuracy;
    $('size-label').textContent = words.size; $('fullscreen').textContent = words.fullscreen + ' ↗';
    $('text-size').options[0].textContent = words.standard; $('text-size').options[1].textContent = words.large;
    $('brand-label').textContent = words.brand; $('contact-note').textContent = words.contact;
  }
  if (params.get('screen') === '1') { document.body.classList.add('screen-mode'); document.body.dataset.size = 'large'; $('text-size').value = 'large'; }
  $('text-size').onchange = () => { document.body.dataset.size = $('text-size').value; render(); };
  $('fullscreen').onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else $('viewer-message').textContent = 'Use your browser’s full-screen controls.';
    } catch (_) { $('viewer-message').textContent = 'Full screen is not available in this browser.'; }
  };
  function accept(value) {
    if (!value || value.id !== room || (snapshot && Number(value.revision) < Number(snapshot.revision))) return;
    snapshot = value; render();
  }
  // Append only what is new. Rewriting the paragraph re-wraps every line, and the
  // audience loses the place it was reading; then keep the last line at the bottom.
  let painted = '';
  const glide = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The room publishes a rolling window of the last 1400 characters, so after a
  // couple of minutes a new reading no longer *starts* with what is on screen —
  // it is the same text shifted left, and a naive prefix test repainted the whole
  // paragraph on every update. That is the flicker the audience was following.
  // The window only ever loses characters from its head, so the new reading is
  // `painted` minus some head plus a short tail: find that tail.
  function appended(text) {
    if (!painted) return null;
    if (text.startsWith(painted)) return text.slice(painted.length);
    // Longest first: speech adds a few characters per update, so this matches
    // on the first or second try and never walks the whole window.
    for (let keep = Math.min(painted.length, text.length); keep >= 40; keep--) {
      if (painted.endsWith(text.slice(0, keep))) return text.slice(keep);
    }
    return null; // a different talk, or a gap too long to bridge
  }
  function paint(text, placeholder) {
    const caption = $('captions'); const frame = $('caption-window');
    const grown = text ? appended(text) : null;
    if (!text) { caption.textContent = placeholder; painted = ''; }
    // Appending for ever would make the browser re-lay out an essay on every
    // word, so the paragraph restarts about twice an hour — one jump, not one
    // per update.
    else if (grown === null || painted.length > 24000) { caption.textContent = text; painted = text; }
    else if (grown) { caption.append(grown); painted += grown; }
    const bottom = frame.scrollHeight - frame.clientHeight;
    // A new line glides up; a jump of more than one window (a new talk, a phone
    // waking up) snaps instead, so nobody has to watch the text fly past. A hidden
    // tab cannot animate, so a glide queued there would simply never arrive.
    const far = document.hidden || bottom - frame.scrollTop > frame.clientHeight;
    frame.scrollTo({ top: bottom, behavior: glide && !far ? 'smooth' : 'instant' });
  }
  function render() {
    if (!snapshot) return;
    speak(copy[snapshot.language] ? snapshot.language : 'en');
    const age = Date.now() - Date.parse(snapshot.updated_at);
    const stale = age > 30000;
    // The lease lives 45 seconds, so a room nobody has written to in three minutes
    // has no regia behind it: it is waiting for the next talk, not showing one.
    const state = age > 180000 ? 'idle' : snapshot.state;
    const active = ['connecting', 'live', 'reconnecting'].includes(state);
    const waiting = active && (stale || !connected || state === 'reconnecting');
    const text = state === 'idle' ? words.idle : state === 'ended' ? words.ended :
      waiting ? words.reconnecting : state === 'connecting' ? words.connecting : words.live;
    $('talk-title').textContent = snapshot.title;
    $('viewer-status').textContent = text;
    $('viewer-status').dataset.state = waiting ? 'reconnecting' : state;
    paint(state === 'idle' ? '' : tail(snapshot.translated, 1400), state === 'ended' ? words.thanks : words.waiting);
    $('viewer-message').textContent = waiting ? words.interrupted : '';
  }
  async function read() {
    if (!client || fetching || stopped) return;
    fetching = true;
    try {
      const { data, error } = await client.from('live_caption_rooms').select('*').eq('id', room).maybeSingle();
      if (error) throw error;
      if (!data) { $('viewer-status').textContent = 'Room unavailable'; $('viewer-message').textContent = 'Check the link for this talk.'; return; }
      accept(data);
    } catch (_) { $('viewer-status').textContent = 'Reconnecting…'; }
    finally { fetching = false; }
  }
  async function boot() {
    if (booting || stopped) return;
    booting = true;
    try {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(room)) { $('viewer-status').textContent = 'Invalid room'; return; }
      const config = await request({ action: 'config' });
      if (stopped) return;
      if (!window.supabase) throw new Error('Viewer unavailable');
      client = window.supabase.createClient(config.url, config.public_key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: async (input, options) => {
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
          try { return await fetch(input, { ...options, signal: controller.signal, cache: 'no-store' }); }
          finally { clearTimeout(timer); }
        } },
      });
      channel = client.channel('live-captions-' + room)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_caption_rooms', filter: 'id=eq.' + room }, payload => accept(payload.new))
        .subscribe(state => {
          connected = state === 'SUBSCRIBED'; render();
          if (connected) void read(); // repairs missed updates after every reconnect
        });
      await read();
      poll = setInterval(() => { if (!connected || (snapshot && Date.now() - Date.parse(snapshot.updated_at) > 30000)) void read(); }, 10000);
      tick = setInterval(render, 2000);
    } catch (_) {
      $('viewer-status').textContent = 'Not connected';
      $('viewer-message').textContent = 'Live captions are not available yet. Retrying shortly…';
      bootTimer = setTimeout(boot, 5000);
    } finally { booting = false; }
  }
  window.addEventListener('online', () => { if (client) void read(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void read(); });
  window.addEventListener('pagehide', () => {
    stopped = true; clearInterval(poll); clearInterval(tick); clearTimeout(bootTimer);
    if (client && channel) void client.removeChannel(channel);
  });
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; connected = false; void boot(); } });
  void boot();
})();
