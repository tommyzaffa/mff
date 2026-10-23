/* Shared caption logic. No credentials, DOM writes, or network side effects. */
(function (root) {
  'use strict';
  class CaptionBuffer {
    constructor(target = 'en') { this.target = target; this.original = ''; this.translated = ''; this.draft = ''; }
    accept(event) {
      if (!Array.isArray(event.tokens)) return;
      this.draft = '';
      for (const token of event.tokens) {
        if (typeof token.text !== 'string' || /^<[^>]+>$/.test(token.text)) continue;
        const translation = token.translation_status === 'translation';
        if (token.is_final) {
          if (translation) this.translated = (this.translated + token.text).slice(-1400);
          else {
            this.original = (this.original + token.text).slice(-1400);
            // In one-way mode speech already in the target language is never
            // translated. Soniox may answer 'zh-CN' where we asked for 'zh'.
            const spoken = typeof token.language === 'string' ? token.language.slice(0, 2).toLowerCase() : '';
            if (spoken === this.target) this.translated = (this.translated + token.text).slice(-1400);
          }
        } else if (translation) this.draft += token.text;
      }
      this.draft = this.draft.slice(-500);
    }
    clearDraft() { this.draft = ''; }
  }
  // Keep whole words at the start of the rolling screen. Final text only goes
  // to the audience; provisional hypotheses stay in the operator preview.
  // Chinese writes no spaces, so there the cut simply falls where it falls.
  function tail(text, limit = 320) {
    text = String(text || '').trim();
    if (text.length <= limit) return text;
    const cut = text.slice(-limit);
    const space = cut.indexOf(' ');
    return space >= 0 && space < 40 ? cut.slice(space + 1) : cut;
  }
  const errors = {
    unauthorised: 'Session expired or wrong password. Sign in again.',
    room_busy: 'Another control room is already live. Stop that session before starting a new one.',
    lease_lost: 'The link with the room expired. Stop and start the session again.',
    room_not_found: 'Room not configured.',
    not_configured: 'Soniox or the control-room password is not configured on the server yet.',
    service_unavailable: 'Service temporarily unavailable. Try again shortly.',
    soniox_unavailable: 'Soniox is unavailable. Check the key and the credit in its dashboard.',
    soniox_capacity: 'Soniox hit its connection limit. Try again shortly.',
    rate_limited: 'Too many requests. Wait a minute before trying again.',
    NotAllowedError: 'Microphone access denied. Allow it in the browser settings.',
    NotFoundError: 'No audio input available. Connect the mixer or a microphone.',
    NotReadableError: 'The audio input is busy or unavailable.',
    AbortError: 'The request took too long. Check the connection.',
  };
  function errorText(error) { return errors[error.code || error.name] || error.message || 'Connection interrupted. Try again.'; }
  async function request(body, { keepalive = false } = {}) {
    const url = root.MFF_PASSES && root.MFF_PASSES.url;
    if (!url) throw new Error('Site configuration unavailable.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url + '/functions/v1/live-captions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), cache: 'no-store', signal: controller.signal, keepalive,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const error = new Error(errors[data.error] || 'Service unavailable. Try again.');
        error.code = data.error; throw error;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }
  root.MFFLive = { CaptionBuffer, tail, errorText, request };
})(typeof window === 'undefined' ? globalThis : window);
