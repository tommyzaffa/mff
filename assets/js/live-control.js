(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { request, errorText, tail, CaptionBuffer } = window.MFFLive;
  let session = ''; let run = null; let wakeLock = null; let discovering = false;
  try { session = sessionStorage.getItem('mff-live-session') || ''; } catch (_) { /* memory-only login */ }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fields = ['room', 'title', 'device', 'minutes', 'context', 'terms', 'glossary'];
  function status(text, state = '') { $('status').textContent = text; $('status').dataset.state = state; }
  function controls(active) {
    for (const id of fields) $(id).disabled = active;
    $('start').disabled = active || discovering; $('stop').disabled = !active;
    $('logout').disabled = active; $('devices').disabled = active || discovering;
  }
  function remember(value) {
    session = value;
    try { if (value) sessionStorage.setItem('mff-live-session', value); else sessionStorage.removeItem('mff-live-session'); } catch (_) { /* memory only */ }
  }
  function showControl(configured) {
    $('login-panel').hidden = true; $('control-panel').hidden = false;
    if (!configured) $('error').textContent = errorText({ code: 'not_configured' });
    share();
  }
  function share() {
    const url = new URL('../', location.href); url.searchParams.set('room', $('room').value);
    $('audience-link').href = url.href; url.searchParams.set('screen', '1'); $('screen-link').href = url.href;
    $('qr').replaceChildren();
    if (window.QrCreator) QrCreator.render({ text: $('audience-link').href, size: 108, ecLevel: 'M', fill: '#2e1b54', background: '#ffffff' }, $('qr'));
  }
  $('room').addEventListener('change', share);
  $('copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText($('audience-link').href); $('copy-link').textContent = 'Link copiato'; }
    catch (_) { $('notice').textContent = 'Apri la pagina pubblico e copia l’indirizzo dal browser.'; }
  };
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $('login-error').textContent = '';
    try {
      const data = await request({ action: 'login', password: $('password').value });
      remember(data.session); $('password').value = ''; showControl(data.configured);
    } catch (error) { $('login-error').textContent = errorText(error); }
    finally { button.disabled = false; }
  });
  $('logout').onclick = () => {
    remember(''); $('control-panel').hidden = true; $('login-panel').hidden = false; $('password').focus();
  };
  async function listDevices() {
    const selected = $('device').value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    $('device').replaceChildren(new Option('Ingresso predefinito', ''));
    for (const device of devices.filter(d => d.kind === 'audioinput')) {
      $('device').append(new Option(device.label || 'Ingresso audio', device.deviceId));
    }
    if (Array.from($('device').options).some(option => option.value === selected)) $('device').value = selected;
  }
  $('devices').onclick = async () => {
    discovering = true; controls(false); $('error').textContent = '';
    let stream;
    try {
      if (!navigator.mediaDevices) throw new Error('Apri la pagina tramite HTTPS o localhost per usare il microfono.');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await listDevices();
    } catch (error) { $('error').textContent = errorText(error); }
    finally { if (stream) stream.getTracks().forEach(t => t.stop()); discovering = false; controls(!!run); }
  };
  async function keepAwake() {
    try { if (navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { /* optional */ }
  }
  document.addEventListener('visibilitychange', () => { if (run && !run.stopping) void keepAwake(); });
  function render(r) {
    $('translation').textContent = tail(r.buffer.translated) || 'I sottotitoli appariranno qui.';
    $('draft').textContent = r.buffer.draft ? 'In elaborazione: ' + r.buffer.draft : '';
    $('original').textContent = tail(r.buffer.original, 400) || 'In attesa dell’audio.';
  }
  function message(r, state) {
    return { action: 'publish', session, room: r.room, publisher: r.publisher, sequence: ++r.sequence,
      state, original: r.buffer.original, translated: r.buffer.translated };
  }
  // Only one publish request in flight; retry the SAME sequence after a lost
  // response. A database-side lease and sequence check also protect other tabs.
  async function publish(r, force = false) {
    if (r.publishing) return r.publishing;
    if (!r.claimed || (!force && r.stopping)) return;
    if (!r.pending) {
      if (!force && !r.dirty && Date.now() - r.lastPublish < 8000) return;
      r.pending = message(r, r.state); r.dirty = false;
    }
    const payload = r.pending;
    r.publishing = (async () => {
      try {
        await request(payload); r.pending = null; r.lastPublish = Date.now();
      } catch (error) {
        if (run === r && !r.stopping) {
          $('notice').textContent = 'Invio al pubblico interrotto. La regia sta tentando di ricollegarsi.';
          if (['unauthorised', 'lease_lost'].includes(error.code) || Date.now() - r.lastPublish > 25000) {
            // Do not await stop here: it drains this very publish promise.
            void stop(errorText(error));
          }
        }
      } finally { r.publishing = null; }
    })();
    return r.publishing;
  }
  async function release(r) {
    if (!r.claimed) return;
    if (r.publishing) await r.publishing; // final update follows all earlier requests
    r.pending = null;
    try { await request(message(r, 'ended'), { keepalive: true }); }
    catch (_) { if (run === r) $('notice').textContent = 'Audio fermato. Il pubblico vedrà l’interruzione entro 30 secondi se la rete non torna.'; }
    r.claimed = false;
  }
  function context() {
    return {
      general: [{ key: 'domain', value: 'Film festival, cinema and artificial intelligence' }, { key: 'topic', value: $('title').value }],
      text: $('context').value.trim(),
      terms: ['Merge Film Festival', ...$('terms').value.split('\n').map(s => s.trim()).filter(Boolean)].slice(0, 80),
      translation_terms: $('glossary').value.split('\n').map(line => {
        const i = line.indexOf('=');
        return i > 0 ? { source: line.slice(0, i).trim(), target: line.slice(i + 1).trim() } : null;
      }).filter(term => term && term.source && term.target).slice(0, 50),
    };
  }
  function closeAudio(r) {
    if (r.node) { r.node.port.onmessage = null; r.node.disconnect(); }
    if (r.source) r.source.disconnect();
    if (r.stream) r.stream.getTracks().forEach(track => track.stop());
    if (r.audio) void r.audio.close().catch(() => {});
    $('level').value = 0;
  }
  async function connect(r) {
    if (run !== r || r.stopping) return;
    r.state = r.attempts ? 'reconnecting' : 'connecting'; r.dirty = true;
    status(r.attempts ? 'Riconnessione…' : 'Collegamento…', r.state);
    const key = await request({ action: 'key', session, room: r.room, publisher: r.publisher });
    if (run !== r || r.stopping) return;
    const ws = new WebSocket(key.websocket_url); r.ws = ws;
    r.lastResponse = Date.now();
    ws.onopen = () => {
      if (run !== r || r.stopping) { ws.close(); return; }
      ws.send(JSON.stringify({ api_key: key.api_key, model: key.model, audio_format: 'pcm_s16le',
        sample_rate: r.audio.sampleRate, num_channels: 1, language_hints: ['it', 'en'],
        enable_language_identification: true, enable_endpoint_detection: true, max_endpoint_delay_ms: 1000,
        translation: { type: 'one_way', target_language: 'en' }, context: r.context }));
      key.api_key = ''; r.socketOpened = Date.now();
    };
    ws.onmessage = event => {
      if (run !== r || ws !== r.ws) return;
      let data;
      try { data = JSON.parse(event.data); } catch (_) { ws.close(); return; }
      r.lastResponse = Date.now();
      if (data.error_code) {
        r.fatal = ![408, 429, 500, 502, 503, 504].includes(Number(data.error_code));
        r.failure = Number(data.error_code) === 403 ? 'Sessione Soniox terminata: verifica credito e durata massima.' :
          'Soniox ha interrotto la traduzione. Verifica connessione, credito e configurazione.';
        ws.close(); return;
      }
      r.buffer.accept(data); r.dirty = true; render(r);
      if (!r.stopping) {
        r.state = 'live'; status('In diretta', 'live');
        if (Date.now() - r.socketOpened > 30000) r.attempts = 0;
      }
      if (data.finished && r.finish) r.finish();
    };
    ws.onerror = () => { /* onclose handles retries */ };
    ws.onclose = () => {
      if (r.finish) r.finish();
      if (run !== r || r.stopping || ws !== r.ws) return;
      r.buffer.clearDraft(); render(r);
      if (r.fatal) { void stop(r.failure); return; }
      scheduleReconnect(r);
    };
  }
  function scheduleReconnect(r) {
    if (run !== r || r.stopping) return;
    if (++r.attempts > 3) { void stop('Connessione persa dopo tre tentativi. Controlla la rete e riavvia la diretta.'); return; }
    r.state = 'reconnecting'; r.dirty = true; status('Riconnessione…', r.state);
    $('notice').textContent = 'Connessione interrotta: il parlato durante questa pausa non verrà recuperato.';
    r.retry = setTimeout(() => { void connect(r).catch(error => {
      if (['lease_lost', 'unauthorised'].includes(error.code)) void stop(errorText(error));
      else scheduleReconnect(r);
    }); }, Math.min(1000 * 2 ** (r.attempts - 1), 4000));
  }
  async function start() {
    if (run || discovering) return;
    $('error').textContent = ''; $('notice').textContent = '';
    if (!$('title').value.trim()) { $('title').focus(); $('error').textContent = 'Inserisci il titolo del talk.'; return; }
    if (!window.isSecureContext || !navigator.mediaDevices || !window.AudioWorkletNode) {
      $('error').textContent = 'Usa un browser aggiornato su HTTPS o localhost per avviare l’audio.'; return;
    }
    const r = { publisher: crypto.randomUUID(), room: $('room').value, buffer: new CaptionBuffer(), sequence: 0,
      state: 'connecting', stopping: false, claimed: false, dirty: true, attempts: 0, audioSeconds: 0,
      lastPublish: Date.now(), context: context() };
    run = r; controls(true); render(r); status('Apertura microfono…');
    try {
      // Resume during the user's gesture (important on Safari).
      r.audio = new AudioContext(); await r.audio.resume();
      if (run !== r || r.stopping) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: $('device').value ? { exact: $('device').value } : undefined,
        channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
      if (run !== r || r.stopping) { stream.getTracks().forEach(track => track.stop()); return; }
      r.stream = stream;
      stream.getAudioTracks()[0].addEventListener('ended', () => { if (run === r && !r.stopping) void stop('Ingresso audio scollegato. Ricollega il mixer e riavvia.'); });
      await r.audio.audioWorklet.addModule('../../assets/js/live-audio-worklet.js?v=1');
      if (run !== r || r.stopping) return;
      const claim = await request({ action: 'start', session, room: r.room, publisher: r.publisher,
        title: $('title').value.trim(), minutes: Number($('minutes').value) });
      r.claimed = true; r.endsAt = Date.parse(claim.ends_at); r.startedAt = Date.now();
      if (run !== r || r.stopping) { await release(r); return; }
      r.source = r.audio.createMediaStreamSource(stream);
      r.node = new AudioWorkletNode(r.audio, 'mff-capture');
      r.source.connect(r.node); r.node.connect(r.audio.destination);
      r.node.port.onmessage = event => {
        if (run !== r || r.stopping) return;
        const { audio, level } = event.data; $('level').value = Math.min(1, level * 4);
        if (level > 0.002) r.lastSound = Date.now();
        if (r.ws && r.ws.readyState === WebSocket.OPEN) {
          if (r.ws.bufferedAmount > r.audio.sampleRate * 2 * 3) { r.ws.close(); return; }
          r.ws.send(audio); r.audioSeconds += audio.byteLength / 2 / r.audio.sampleRate;
        }
      };
      r.pump = setInterval(() => { void publish(r); }, 1200);
      r.tick = setInterval(() => {
        const elapsed = Math.floor((Date.now() - r.startedAt) / 1000);
        $('elapsed').textContent = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
        $('cost').textContent = '$' + (r.audioSeconds / 3600 * 0.18).toFixed(2);
        if (Date.now() >= r.endsAt) { void stop('Durata massima raggiunta. Avvia una nuova sessione per continuare.'); return; }
        if (r.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(r.ws.readyState) && Date.now() - r.lastResponse > 20000) r.ws.close();
        if (r.state === 'live' && Date.now() - (r.lastSound || r.startedAt) > 15000) {
          $('notice').textContent = 'Nessun segnale audio da 15 secondi. Controlla il mixer e l’ingresso selezionato.';
        }
      }, 1000);
      void keepAwake();
      await connect(r);
    } catch (error) { if (run === r) await stop(errorText(error)); }
    finally { if (run !== r || r.stopping) closeAudio(r); }
  }
  async function stop(reason = '') {
    const r = run;
    if (!r || r.stopping) return;
    r.stopping = true; controls(true); $('stop').disabled = true; status('Chiusura…');
    clearInterval(r.pump); clearInterval(r.tick); clearTimeout(r.retry);
    // Stop capture immediately, then let Soniox finalize the remaining words.
    closeAudio(r);
    if (r.ws && r.ws.readyState === WebSocket.OPEN) {
      const drained = new Promise(resolve => { r.finish = resolve; });
      r.ws.send(''); await Promise.race([drained, delay(3500)]);
    }
    if (r.ws) { r.ws.onclose = null; r.ws.close(); }
    r.state = 'ended'; r.buffer.clearDraft(); r.dirty = true; render(r);
    await release(r);
    if (wakeLock) { await wakeLock.release().catch(() => {}); wakeLock = null; }
    if (run === r) {
      run = null; controls(false); status('Fermato');
      $('error').textContent = reason;
    }
  }
  $('start').onclick = () => { void start(); };
  $('stop').onclick = () => { void stop(); };
  window.addEventListener('beforeunload', event => { if (run && !run.stopping) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => {
    if (!run) return;
    const r = run; r.stopping = true;
    clearInterval(r.pump); clearInterval(r.tick); clearTimeout(r.retry);
    closeAudio(r); if (r.ws) r.ws.close();
    if (r.claimed) void request(message(r, 'ended'), { keepalive: true }).catch(() => {});
    run = null; controls(false); status('Fermato');
  });
  if (session) request({ action: 'check', session }).then(data => showControl(data.configured)).catch(error => {
    if (error.code === 'unauthorised') remember('');
    $('login-error').textContent = errorText(error);
  });
})();
