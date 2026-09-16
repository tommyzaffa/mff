(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { request, tail } = window.MFFLive;
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || 'main';
  let client; let channel; let snapshot; let connected = false; let fetching = false;
  let stopped = false; let booting = false; let poll; let tick; let bootTimer;
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
  function render() {
    if (!snapshot) return;
    const stale = Date.now() - Date.parse(snapshot.updated_at) > 30000;
    const state = snapshot.state;
    const active = ['connecting', 'live', 'reconnecting'].includes(state);
    const waiting = active && (stale || !connected || state === 'reconnecting');
    const text = state === 'idle' ? 'Waiting for the talk' : state === 'ended' ? 'Talk ended' :
      waiting ? 'Reconnecting…' : state === 'connecting' ? 'Starting…' : 'Live';
    $('talk-title').textContent = snapshot.title;
    $('viewer-status').textContent = text;
    $('viewer-status').dataset.state = waiting ? 'reconnecting' : state;
    const limit = document.body.dataset.size === 'large' ? 240 : 320;
    $('captions').textContent = tail(snapshot.translated, limit) || (state === 'ended' ? 'Thank you for joining us.' : 'Captions will appear when the talk begins.');
    $('viewer-message').textContent = waiting ? 'The live connection was interrupted. The text above is the last received caption.' : '';
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
