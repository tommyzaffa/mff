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
  var codeInput = form.querySelector('input[name="access_code"]');
  var codeState = form.querySelector("[data-code-state]");
  var codeHint = form.querySelector("[data-code-hint]");
  var orgInput = form.querySelector("[data-org-input]");
  var inviteSelect = form.querySelector('select[name="invite_type"]');

  // What the user picked on the chooser: guest | industry | press | invite.
  var choice = "guest";
  // The file exactly as it was picked. Kept because a browser that cannot decode
  // it (HEIC, mostly) gets no cropper, and then this is what we send.
  var rawFile = null;
  var codeOk = false;

  // --- panels ---------------------------------------------------------------

  // Swapping the panel leaves the page where it is: jumping back to the hero on
  // every step made the form feel like it had reloaded.
  function show(name) {
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== name;
    });
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
    if (e.target.name !== "fare" && e.target.name !== "invite_type") return;
    refresh();
    // A code is only valid for certain types, so changing the type invalidates
    // whatever the green tick said a moment ago. Ask again rather than let
    // somebody reach the submit button on a stale "this pass is free".
    var value = codeInput ? codeInput.value.trim() : "";
    if (value.length >= 4) verifyCode(value);
  });

  // --- photo ----------------------------------------------------------------

  // A phone photo is almost never a passport portrait: it is wide, and the face
  // is off to one side. So the frame is the badge's own photo box and the
  // applicant drags the image inside it — what they line up is what is printed.
  // Cropping and re-encoding here also keeps a 12 MP original off the wire:
  // what leaves the browser is a ~720 x 900 JPEG, around 150 KB.
  var OUT_W = 720;
  var OUT_H = 900;

  var cropBox = form.querySelector("[data-crop]");
  var cropFrame = form.querySelector("[data-crop-frame]");
  var cropImg = form.querySelector("[data-crop-img]");
  var cropZoom = form.querySelector("[data-crop-zoom]");

  // The image's natural size, the zoom, and the offset of its top-left corner
  // from the frame's, in frame pixels. Null while there is nothing to crop.
  var view = null;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // The scale at which the image just covers the frame is zoom 1, so the frame
  // is never left with a gap however the photo is shaped.
  function place() {
    if (!view) return;
    var fw = cropFrame.clientWidth;
    var fh = cropFrame.clientHeight;
    view.scale = Math.max(fw / view.w, fh / view.h) * view.zoom;
    var dw = view.w * view.scale;
    var dh = view.h * view.scale;
    view.x = clamp(view.x, fw - dw, 0);
    view.y = clamp(view.y, fh - dh, 0);
    cropImg.style.width = dw + "px";
    cropImg.style.height = dh + "px";
    cropImg.style.transform = "translate(" + view.x + "px," + view.y + "px)";
  }

  function cropped() {
    return new Promise(function (resolve, reject) {
      var fw = cropFrame.clientWidth;
      var fh = cropFrame.clientHeight;
      var canvas = document.createElement("canvas");
      canvas.width = OUT_W;
      canvas.height = OUT_H;
      // The visible window, expressed back in the original image's pixels.
      canvas.getContext("2d").drawImage(
        cropImg,
        -view.x / view.scale, -view.y / view.scale,
        fw / view.scale, fh / view.scale,
        0, 0, OUT_W, OUT_H
      );
      canvas.toBlob(function (blob) {
        blob ? resolve(blob) : reject(new Error("encode"));
      }, "image/jpeg", 0.85);
    });
  }

  function hasPhoto() { return !!(view || rawFile); }

  // Rendered at submit time rather than on every drag, so the blob can never be
  // one gesture behind what the applicant is looking at.
  function photo() {
    if (!view) return Promise.resolve(rawFile);
    return cropped().catch(function () { return rawFile; });
  }

  if (photoInput) {
    photoInput.addEventListener("change", function () {
      var file = photoInput.files && photoInput.files[0];
      view = null;
      rawFile = file || null;
      if (cropBox) cropBox.hidden = true;
      if (!file || !cropBox) return;

      var url = URL.createObjectURL(file);
      var probe = new Image();
      probe.onload = function () {
        if (cropImg.src) URL.revokeObjectURL(cropImg.src);
        cropImg.src = url;
        cropBox.hidden = false;
        if (cropZoom) cropZoom.value = "1";
        view = { w: probe.naturalWidth, h: probe.naturalHeight, zoom: 1, x: 0, y: 0, scale: 1 };
        // Start centred: the middle of a snapshot is the best guess we have.
        var fw = cropFrame.clientWidth;
        var fh = cropFrame.clientHeight;
        var base = Math.max(fw / view.w, fh / view.h);
        view.x = (fw - view.w * base) / 2;
        view.y = (fh - view.h * base) / 2;
        place();
      };
      probe.onerror = function () {
        // HEIC on a browser that cannot decode it: no cropping is possible, so
        // the original goes up as-is rather than blocking the application.
        URL.revokeObjectURL(url);
      };
      probe.src = url;
    });
  }

  var drag = null;
  if (cropFrame) {
    cropFrame.addEventListener("pointerdown", function (e) {
      if (!view) return;
      drag = { id: e.pointerId, x: e.clientX - view.x, y: e.clientY - view.y };
      cropFrame.setPointerCapture(e.pointerId);
      cropFrame.classList.add("is-dragging");
      e.preventDefault();
    });
    cropFrame.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      view.x = e.clientX - drag.x;
      view.y = e.clientY - drag.y;
      place();
    });
    ["pointerup", "pointercancel"].forEach(function (name) {
      cropFrame.addEventListener(name, function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        cropFrame.classList.remove("is-dragging");
      });
    });
  }

  if (cropZoom) {
    cropZoom.addEventListener("input", function () {
      if (!view) return;
      // Zoom about the middle of the frame, so the face stays where it was put.
      var fw = cropFrame.clientWidth;
      var fh = cropFrame.clientHeight;
      var next = parseFloat(cropZoom.value);
      var k = next / view.zoom;
      view.x = fw / 2 - (fw / 2 - view.x) * k;
      view.y = fh / 2 - (fh / 2 - view.y) * k;
      view.zoom = next;
      place();
    });
  }

  window.addEventListener("resize", place);

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
    if (!hasPhoto()) return bad("photo_required");

    var proof = form.querySelector('input[name="proof"]');
    if (proof && !proof.closest("[data-when]").hidden) {
      var file = proof.files && proof.files[0];
      if (!file && proof.required) return bad("proof_required");
      if (file) data.set("proof", file, file.name);
    }

    submitBtn.disabled = true;
    statusEl.textContent = t("passes.sending", "Sending…");

    photo().then(function (blob) {
      data.set("photo", blob, "photo.jpg");
      return fetch(ENDPOINT, { method: "POST", body: data });
    })
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
