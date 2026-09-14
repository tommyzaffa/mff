// Staff requests need a timeout on older iPhones too (AbortSignal.timeout is newer).
(function () {
  "use strict";
  window.mffStaffRequest = function (endpoint, body) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    return fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    }).then(function (response) { return response.json(); })
      .finally(function () { clearTimeout(timeout); });
  };
})();
