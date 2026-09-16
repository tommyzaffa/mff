/* Shared caption logic. No credentials, DOM writes, or network side effects. */
(function (root) {
  'use strict';
  class CaptionBuffer {
    constructor() { this.original = ''; this.translated = ''; this.draft = ''; }
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
            // In one-way mode English speech is already in the target language.
            if (token.language === 'en') this.translated = (this.translated + token.text).slice(-1400);
          }
        } else if (translation) this.draft += token.text;
      }
      this.draft = this.draft.slice(-500);
    }
    clearDraft() { this.draft = ''; }
  }
  // Keep whole words at the start of the rolling screen. Final text only goes
  // to the audience; provisional hypotheses stay in the operator preview.
  function tail(text, limit = 320) {
    text = String(text || '').trim();
    if (text.length <= limit) return text;
    const cut = text.slice(-limit);
    const space = cut.indexOf(' ');
    return space >= 0 ? cut.slice(space + 1) : cut;
  }
  const errors = {
    unauthorised: 'Sessione scaduta o password errata. Accedi di nuovo.',
    room_busy: 'Questa sala è già controllata da un’altra regia. Fermala prima di continuare.',
    lease_lost: 'Il collegamento con la sala è scaduto. Ferma e riavvia la diretta.',
    room_not_found: 'Sala non configurata.',
    not_configured: 'Soniox o la password regia non sono ancora configurati sul server.',
    service_unavailable: 'Servizio momentaneamente non disponibile. Riprova tra poco.',
    soniox_unavailable: 'Soniox non è disponibile. Verifica la chiave e il credito nel suo pannello.',
    soniox_capacity: 'Soniox ha raggiunto il limite di connessioni. Riprova tra poco.',
    rate_limited: 'Troppe richieste. Attendi un minuto prima di riprovare.',
    NotAllowedError: 'Accesso al microfono negato. Abilitalo nelle impostazioni del browser.',
    NotFoundError: 'Nessun ingresso audio disponibile. Collega il mixer o un microfono.',
    NotReadableError: 'L’ingresso audio è occupato o non disponibile.',
    AbortError: 'La richiesta ha impiegato troppo tempo. Controlla la connessione.',
  };
  function errorText(error) { return errors[error.code || error.name] || error.message || 'Collegamento interrotto. Riprova.'; }
  async function request(body, { keepalive = false } = {}) {
    const url = root.MFF_PASSES && root.MFF_PASSES.url;
    if (!url) throw new Error('Configurazione del sito non disponibile.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url + '/functions/v1/live-captions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), cache: 'no-store', signal: controller.signal, keepalive,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const error = new Error(errors[data.error] || 'Servizio non disponibile. Riprova.');
        error.code = data.error; throw error;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }
  root.MFFLive = { CaptionBuffer, tail, errorText, request };
})(typeof window === 'undefined' ? globalThis : window);
