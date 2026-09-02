/* ============================================================
   Merge Film Festival — l'ingresso della sala

   Si sceglie la proiezione che si sta presidiando, poi si
   inquadra il QR: quello del biglietto comprato online oppure
   quello del badge di un accreditato, che il server risolve nel
   posto che quella persona ha prenotato per QUESTA proiezione.

   Due cose non sono negoziabili qui.

   La prima: un biglietto di un'altra proiezione viene rifiutato
   senza essere consumato. Chi ha pagato per le 22:30 e sbaglia
   porta alle 18:00 deve poter entrare al suo film.

   La seconda: senza connessione non si entra. Non teniamo una
   lista scaricata: due telefoni offline farebbero passare due
   volte lo stesso biglietto, ed è esattamente ciò da cui il
   controllo dovrebbe difendere.

   Il verdetto copre la telecamera invece di stargli accanto,
   perché è la sola cosa che si legge davvero mentre scorre la
   fila. Il verde se ne va da solo, il rosso pretende un tocco.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_PASSES || {};
  var ENDPOINT = (CFG.url || "").replace(/\/+$/, "") + "/functions/v1/ticket-door";

  // Otto letture al secondo bastano per una fila e non scaldano il telefono.
  var SCAN_INTERVAL_MS = 125;
  var FRAME_MAX_PX = 480;
  // Lo stesso QR resta inquadrato mentre la persona si sposta: non va riletto.
  var REPEAT_BLOCK_MS = 5000;
  var OK_DISMISS_MS = 1400;

  var panels = {};
  document.querySelectorAll("[data-panel]").forEach(function (el) {
    panels[el.getAttribute("data-panel")] = el;
  });

  var loginForm = document.querySelector("[data-login]");
  var loginError = document.querySelector("[data-login-error]");
  var listEl = document.querySelector("[data-list]");
  var pickStatus = document.querySelector("[data-pick-status]");

  var video = document.querySelector("[data-video]");
  var hintEl = document.querySelector("[data-hint]");
  var countEl = document.querySelector("[data-count]");
  var titleEl = document.querySelector("[data-show-title]");
  var whenEl = document.querySelector("[data-show-when]");

  var verdict = document.querySelector("[data-verdict]");
  var verdictWord = document.querySelector("[data-verdict-word]");
  var verdictName = document.querySelector("[data-verdict-name]");
  var verdictNote = document.querySelector("[data-verdict-note]");

  var manualForm = document.querySelector("[data-manual]");

  var password = "";
  var current = null;      // la proiezione scelta
  var stream = null;
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  var busy = false;        // una richiesta è in volo
  var holding = false;     // il verdetto è a schermo
  var recent = {};         // codice -> timestamp
  var timer = null;
  var dismissTimer = null;
  var audio = null;

  function show(name) {
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
  }

  try {
    password = sessionStorage.getItem("mff_door") || "";
  } catch (e) { /* modalità privata */ }

  function call(body) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ password: password }, body || {})),
    }).then(function (r) { return r.json(); });
  }

  // --- suono e vibrazione ---------------------------------------------------

  // Alla porta nessuno guarda lo schermo: il tono è il vero segnale, e lo
  // schermo serve a capire perché quando il tono è quello sbagliato.
  function unlockAudio() {
    if (audio) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audio = new AC();
    } catch (e) { audio = null; }
  }

  function beep(good) {
    if (audio && audio.state === "suspended") audio.resume();
    if (audio) {
      try {
        var osc = audio.createOscillator();
        var gain = audio.createGain();
        osc.type = good ? "sine" : "square";
        osc.frequency.value = good ? 880 : 220;
        gain.gain.value = 0.12;
        osc.connect(gain).connect(audio.destination);
        osc.start();
        osc.stop(audio.currentTime + (good ? 0.12 : 0.42));
      } catch (e) { /* niente audio, pazienza */ }
    }
    if (navigator.vibrate) navigator.vibrate(good ? 60 : [90, 70, 90]);
  }

  // --- login ----------------------------------------------------------------

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    unlockAudio();
    loginError.textContent = "";
    password = loginForm.password.value;
    if (!password) return;

    var btn = loginForm.querySelector("button");
    btn.disabled = true;
    call()
      .then(function (res) {
        btn.disabled = false;
        if (!res.ok) {
          // A refused password and a broken server look the same from here
          // unless we say so, and whoever is holding the queue has no way to
          // guess which of the two they are looking at.
          loginError.textContent = res.error === "server_error"
            ? "Il server non risponde. Avvisa l'organizzazione."
            : "Password sbagliata.";
          return;
        }
        try { sessionStorage.setItem("mff_door", password); } catch (e2) {}
        toPick(res.screenings || []);
      })
      .catch(function () {
        btn.disabled = false;
        loginError.textContent = "Nessuna connessione. Riprova.";
      });
  });

  // --- scelta della proiezione ----------------------------------------------

  function whenText(iso) {
    try {
      return new Intl.DateTimeFormat("it-CH", {
        weekday: "short", day: "numeric", month: "short",
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich",
      }).format(new Date(iso));
    } catch (e) { return iso; }
  }

  function toPick(screenings) {
    listEl.innerHTML = "";
    pickStatus.textContent = "";

    if (!screenings.length) {
      var empty = document.createElement("li");
      empty.className = "scan__empty";
      empty.textContent = "Nessuna proiezione nelle prossime ore.";
      listEl.appendChild(empty);
    }

    screenings.forEach(function (s) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scan__choice";

      var when = document.createElement("span");
      when.className = "scan__choice-when";
      when.textContent = whenText(s.starts_at);
      btn.appendChild(when);

      var title = document.createElement("span");
      title.className = "scan__choice-title";
      title.textContent = s.title;
      btn.appendChild(title);

      btn.addEventListener("click", function () {
        unlockAudio();
        start(s);
      });
      li.appendChild(btn);
      listEl.appendChild(li);
    });

    show("pick");
  }

  document.querySelector("[data-back]").addEventListener("click", function () {
    stop();
    call()
      .then(function (res) {
        if (!res.ok) return show("login");
        toPick(res.screenings || []);
      })
      .catch(function () { show("pick"); });
  });

  // --- la telecamera --------------------------------------------------------

  function start(screening) {
    current = screening;
    try { sessionStorage.setItem("mff_scan_show", screening.code); } catch (e) {}

    titleEl.textContent = screening.title;
    whenEl.textContent = whenText(screening.starts_at);
    countEl.textContent = "—";
    hideVerdict();
    show("scan");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hintEl.textContent =
        "Questo telefono non dà accesso alla telecamera. Usa il campo qui sotto.";
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .then(function () {
        hintEl.textContent = "Inquadra il QR del biglietto o del badge.";
        timer = setInterval(tick, SCAN_INTERVAL_MS);
      })
      .catch(function () {
        // Il permesso negato non è un errore da nascondere: senza telecamera il
        // turno deve sapere subito di dover scrivere i codici a mano.
        hintEl.textContent =
          "Telecamera non disponibile: dai il permesso al browser, oppure scrivi il codice qui sotto.";
      });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    video.srcObject = null;
    holding = false;
    busy = false;
  }

  function tick() {
    if (busy || holding) return;
    if (!video.videoWidth) return;

    var scale = Math.min(1, FRAME_MAX_PX / Math.max(video.videoWidth, video.videoHeight));
    var w = Math.round(video.videoWidth * scale);
    var h = Math.round(video.videoHeight * scale);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    ctx.drawImage(video, 0, 0, w, h);
    var img;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return; }

    var found = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
    if (found && found.data) submit(found.data);
  }

  // --- la verifica ----------------------------------------------------------

  function submit(raw) {
    var code = String(raw).trim().toUpperCase();
    if (!code) return;

    var now = Date.now();
    if (recent[code] && now - recent[code] < REPEAT_BLOCK_MS) return;
    recent[code] = now;

    busy = true;
    hintEl.textContent = "Verifico…";

    call({ action: "scan", screening: current.code, code: code })
      .then(function (res) {
        busy = false;
        hintEl.textContent = "Inquadra il QR del biglietto o del badge.";

        if (!res.ok) {
          // Sessione scaduta o richiesta rifiutata: non è un verdetto sulla
          // persona, quindi non deve somigliarne a uno.
          if (res.error === "unauthorised") {
            stop();
            show("login");
            loginError.textContent = "Sessione scaduta: rientra.";
            return;
          }
          return render({ ok: false, reason: "server" });
        }
        render(res.scan || { ok: false, reason: "server" });
      })
      .catch(function () {
        busy = false;
        // Senza risposta non sappiamo se il biglietto è buono: si riprova, non
        // si tira a indovinare.
        delete recent[code];
        render({ ok: false, reason: "offline" });
      });
  }

  var WORDS = {
    already_used:     ["GIÀ ENTRATO", "bad"],
    wrong_screening:  ["ALTRA PROIEZIONE", "warn"],
    badge_not_booked: ["ACCREDITO SENZA POSTO", "warn"],
    not_valid:        ["NON VALIDO", "bad"],
    unknown_ticket:   ["SCONOSCIUTO", "bad"],
    screening_required: ["SCEGLI LA PROIEZIONE", "warn"],
    offline:          ["NESSUNA CONNESSIONE", "warn"],
    server:           ["ERRORE", "warn"],
  };

  function timeOnly(iso) {
    try {
      return new Intl.DateTimeFormat("it-CH", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich",
      }).format(new Date(iso));
    } catch (e) { return iso; }
  }

  function render(r) {
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    holding = true;

    var word, kind, name = "", note = "";

    if (r.ok) {
      word = "ENTRA";
      kind = "ok";
      name = r.name || "";
      var bits = [];
      if (r.wheelchair) bits.push("Posto carrozzina");
      if (r.badge) bits.push("Accredito " + r.badge);
      note = bits.join(" · ");
      if (typeof r.checked_in === "number") countEl.textContent = String(r.checked_in);
    } else {
      var spec = WORDS[r.reason] || WORDS.server;
      word = spec[0];
      kind = spec[1];
      name = r.name || "";

      if (r.reason === "already_used" && r.at) {
        note = "Entrato alle " + timeOnly(r.at) + ".";
      } else if (r.reason === "wrong_screening") {
        note = "Questo biglietto è per " + (r.title || r.screening) +
               (r.starts_at ? " delle " + timeOnly(r.starts_at) : "") +
               ". Non è stato consumato.";
      } else if (r.reason === "badge_not_booked") {
        note = "L'accredito è valido ma non ha prenotato un posto per questa " +
               "proiezione. Il posto va prenotato: mandalo in cassa.";
      } else if (r.reason === "offline") {
        note = "Non ho potuto verificare. Riavvicina il QR quando torna la rete.";
      } else if (r.reason === "not_valid") {
        note = "Ordine annullato o pagamento non concluso.";
      }
    }

    verdict.className = "scan__verdict is-" + kind;
    verdictWord.textContent = word;
    verdictName.textContent = name;
    verdictNote.textContent = note;
    verdict.hidden = false;

    beep(!!r.ok);

    // Il verde scorre da solo perché la fila deve muoversi; il rosso resta
    // finché qualcuno lo tocca, perché richiede una decisione.
    if (r.ok) dismissTimer = setTimeout(hideVerdict, OK_DISMISS_MS);
  }

  function hideVerdict() {
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    verdict.hidden = true;
    holding = false;
  }

  document.querySelector("[data-verdict-close]").addEventListener("click", hideVerdict);

  // --- codice a mano --------------------------------------------------------

  manualForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var input = manualForm.code;
    var code = input.value.trim().toUpperCase();
    if (!code) return;
    delete recent[code];
    hideVerdict();
    submit(code);
    input.value = "";
    input.blur();
  });

  // Chiudere la scheda deve bastare a spegnere la telecamera.
  window.addEventListener("pagehide", stop);

  // --- rientro dopo un ricaricamento ---------------------------------------

  if (password) {
    call()
      .then(function (res) {
        if (!res.ok) return;
        toPick(res.screenings || []);
      })
      .catch(function () { /* si resta sul login */ });
  }
})();
