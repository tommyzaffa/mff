/* ============================================================
   Merge Film Festival — accreditation form

   Three panels (choose / form / outcome), one submit. The page
   never talks to the database: everything goes to the pass-submit
   edge function, which decides whether this ends in a badge, a
   Stripe checkout, or a request waiting for our approval.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_PASSES || {};
  var ENDPOINT = (CFG.url || "").replace(/\/+$/, "") + "/functions/v1/pass-submit";

  var root = document.getElementById("passForm");
  if (!root) return;

  var form = root;
  var panels = {};
  document.querySelectorAll("[data-panel]").forEach(function (el) {
    panels[el.getAttribute("data-panel")] = el;
  });

  var statusEl = form.querySelector("[data-status]");
  var submitBtn = form.querySelector("[data-submit-label]");
  var titleEl = form.querySelector("[data-pass-title]");
  var photoInput = form.querySelector('input[name="photo"]');
  var previewEl = form.querySelector("[data-photo-preview]");
  var codeInput = form.querySelector('input[name="access_code"]');
  var codeState = form.querySelector("[data-code-state]");
  var codeHint = form.querySelector("[data-code-hint]");
  var orgInput = form.querySelector("[data-org-input]");
  var inviteSelect = form.querySelector('select[name="invite_type"]');

  // What the user picked on the chooser: guest | industry | press | invite.
  var choice = "guest";
  // The photo, already shrunk. Kept apart from the file input because the
  // browser will not let us write back to it.
  var photoBlob = null;
  var codeOk = false;

  // --- panels ---------------------------------------------------------------

  function show(name) {
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== name;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function t(key, fallback) {
    var dict = (window.MFF_I18N || {})[document.documentElement.dataset.lang || "en"];
    var node = dict;
    var parts = key.split(".");
    for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
    return typeof node === "string" ? node : fallback;
  }

  // --- which fields this pass needs ----------------------------------------

  function currentType() {
    if (choice === "guest") {
      var fare = form.querySelector('input[name="fare"]:checked');
      return fare ? fare.value : "guest";
    }
    if (choice === "invite") return inviteSelect ? inviteSelect.value : "delegation";
    return choice;
  }

  function fieldsFor(type) {
    return {
      fare: choice === "guest",
      "invite-type": choice === "invite",
      // The student fare is the only one that needs a document, and a code that
      // makes the pass free makes the document pointless too.
      proof: type === "guest_student" && !codeOk,
      org: type !== "guest" && type !== "guest_student",
      code: true,
    };
  }

  function refresh() {
    var type = currentType();
    var want = fieldsFor(type);

    form.querySelectorAll("[data-when]").forEach(function (el) {
      el.hidden = !want[el.getAttribute("data-when")];
    });

    if (orgInput) {
      var placeholders = {
        industry: "passes.phOrgIndustry",
        press: "passes.phOrgPress",
        delegation: "passes.phOrgDelegation",
        sponsor: "passes.phOrgSponsor",
        staff: "passes.phOrgRole",
        media: "passes.phOrgPress",
      };
      var key = placeholders[type] || "passes.phOrgIndustry";
      orgInput.setAttribute("data-i18n-attr", "placeholder:" + key);
      orgInput.placeholder = t(key, orgInput.placeholder);
      orgInput.required = !!want.org;
    }

    var proof = form.querySelector('input[name="proof"]');
    if (proof) proof.required = !!want.proof;

    // A code is the only way into the four invitation passes.
    if (codeInput) {
      codeInput.required = choice === "invite";
      if (codeHint) {
        var hintKey = choice === "invite" ? "passes.codeHintRequired" : "passes.codeHintOptional";
        codeHint.setAttribute("data-i18n", hintKey);
        codeHint.textContent = t(hintKey, codeHint.textContent);
      }
    }

    if (titleEl) {
      var names = {
        guest: "passes.guestName",
        guest_student: "passes.guestName",
        industry: "passes.industryName",
        press: "passes.pressName",
        delegation: "passes.typeDelegation",
        sponsor: "passes.typeSponsor",
        staff: "passes.typeStaff",
        media: "passes.typeMedia",
      };
      titleEl.setAttribute("data-i18n", names[type]);
      titleEl.textContent = t(names[type], titleEl.textContent);
    }

    if (submitBtn) {
      var free = codeOk || choice === "invite";
      var labelKey = free
        ? "passes.submitFree"
        : choice === "industry" || choice === "press"
        ? "passes.submitRequest"
        : "passes.submitPay";
      submitBtn.setAttribute("data-i18n", labelKey);
      submitBtn.textContent = t(labelKey, submitBtn.textContent);
    }
  }

  // --- chooser --------------------------------------------------------------

  document.querySelectorAll("[data-choose]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      choice = btn.getAttribute("data-choose");
      codeOk = false;
      if (codeState) codeState.textContent = "";
      refresh();
      show("form");
    });
  });

  form.querySelectorAll("[data-back]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      show("choose");
    });
  });

  form.addEventListener("change", function (e) {
    if (e.target.name === "fare" || e.target.name === "invite_type") refresh();
  });

  // --- photo ----------------------------------------------------------------

  // Shrinking here rather than server-side keeps a 12 MP phone photo off the
  // wire entirely: what leaves the browser is around 150 KB.
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var max = 1000;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error("encode"));
        }, "image/jpeg", 0.85);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("decode"));
      };
      img.src = url;
    });
  }

  if (photoInput) {
    photoInput.addEventListener("change", function () {
      var file = photoInput.files && photoInput.files[0];
      photoBlob = null;
      if (previewEl) previewEl.style.backgroundImage = "";
      if (!file) return;

      shrink(file).then(function (blob) {
        photoBlob = blob;
        if (previewEl) {
          previewEl.style.backgroundImage = 'url("' + URL.createObjectURL(blob) + '")';
        }
      }).catch(function () {
        // HEIC on a browser that cannot decode it: send the original and let
        // the server keep it as-is rather than blocking the application.
        photoBlob = file;
      });
    });
  }

  // --- access code ----------------------------------------------------------

  var codeTimer = null;
  if (codeInput) {
    codeInput.addEventListener("input", function () {
      codeInput.value = codeInput.value.toUpperCase();
      clearTimeout(codeTimer);
      codeOk = false;
      if (codeState) {
        codeState.textContent = "";
        codeState.className = "pass-form__code-state";
      }
      var value = codeInput.value.trim();
      if (value.length < 4) {
        refresh();
        return;
      }
      codeTimer = setTimeout(function () { verifyCode(value); }, 450);
    });
  }

  function verifyCode(value) {
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "check_code", code: value, type: currentType() }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        codeOk = !!data.ok;
        if (codeState) {
          codeState.textContent = data.ok
            ? t("passes.codeOk", "Code accepted — this pass is free.")
            : t("passes." + (data.error || "code_invalid"), t("passes.code_invalid", "This code is not valid."));
          codeState.className = "pass-form__code-state " + (data.ok ? "is-ok" : "is-bad");
        }
        refresh();
      })
      .catch(function () {
        codeOk = false;
        refresh();
      });
  }

  // --- submit ---------------------------------------------------------------

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!statusEl) return;

    statusEl.className = "form__status";
    statusEl.textContent = "";

    var type = currentType();
    var data = new FormData();
    data.set("type", type);
    data.set("first_name", form.first_name.value.trim());
    data.set("last_name", form.last_name.value.trim());
    data.set("email", form.email.value.trim());
    data.set("locale", document.documentElement.dataset.lang || "it");
    if (orgInput && !orgInput.closest("[data-when]").hidden) data.set("org", orgInput.value.trim());
    if (codeInput && codeInput.value.trim()) data.set("access_code", codeInput.value.trim());

    if (!data.get("first_name") || !data.get("last_name")) return bad("name_required");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(data.get("email"))) return bad("email_invalid");
    if (orgInput && orgInput.required && !orgInput.value.trim()) return bad("org_required");
    if (!form.consent.checked) return bad("consent_required");
    if (!photoBlob) return bad("photo_required");

    data.set("photo", photoBlob, "photo.jpg");

    var proof = form.querySelector('input[name="proof"]');
    if (proof && !proof.closest("[data-when]").hidden) {
      var file = proof.files && proof.files[0];
      if (!file && proof.required) return bad("proof_required");
      if (file) data.set("proof", file, file.name);
    }

    submitBtn.disabled = true;
    statusEl.textContent = t("passes.sending", "Sending…");

    fetch(ENDPOINT, { method: "POST", body: data })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) {
          submitBtn.disabled = false;
          return bad(res.error || "server_error");
        }
        if (res.outcome === "checkout") {
          // Straight out to Stripe; we come back on /passes/success.html.
          window.location.href = res.url;
          return;
        }
        if (res.outcome === "issued") {
          var link = document.querySelector("[data-badge-link]");
          if (link) link.href = "../badge/?c=" + encodeURIComponent(res.badge_code);
          show("issued");
          return;
        }
        show("review");
      })
      .catch(function () {
        submitBtn.disabled = false;
        bad("network");
      });
  });

  function bad(code) {
    statusEl.className = "form__status is-error";
    statusEl.textContent = t("passes." + code, t("passes.server_error", "Something went wrong. Please try again."));
    submitBtn.disabled = false;
    return false;
  }

  // Re-render the parts we translate by hand whenever the language changes.
  var previous = window.onLangApplied;
  window.onLangApplied = function (lang) {
    if (typeof previous === "function") previous(lang);
    refresh();
  };

  refresh();
})();
