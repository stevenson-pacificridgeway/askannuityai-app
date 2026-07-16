/*
 * Meta Pixel — AskAnnuityAI (drop-in, no app changes required)
 * Pixel: IAS FACEBOOK (614281688337041). Pixel ID is public and safe client-side.
 * Loads base pixel, re-fires PageView on SPA route changes, and wires
 * high-intent events (Lead, AskedAI, CompleteRegistration, ViewContent)
 * via event delegation + DOM observation so no existing code is modified.
 */
(function () {
  var PIXEL_ID =
    (window.AAI_CONFIG && window.AAI_CONFIG.FB_PIXEL_ID) || "614281688337041";

  // --- Base pixel ---
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = "2.0";
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");

  fbq("init", PIXEL_ID);
  fbq("track", "PageView");

  // --- SPA route-change PageView (history + hash) ---
  var lastUrl = location.href;
  function firePageView() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    fbq("track", "PageView");
  }
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var r = orig.apply(this, arguments);
      firePageView();
      return r;
    };
  });
  window.addEventListener("popstate", firePageView);
  window.addEventListener("hashchange", firePageView);

  // --- Helpers ---
  var fired = {};
  function once(key, fn) {
    if (fired[key]) return;
    fired[key] = true;
    fn();
  }
  function closestId(el, id) {
    while (el && el !== document) {
      if (el.id === id) return el;
      el = el.parentNode;
    }
    return null;
  }

  document.addEventListener(
    "submit",
    function (e) {
      var t = e.target;
      if (!t || !t.id) return;
      if (t.id === "leadForm") {
        fbq("track", "Lead", { content_name: "Advisor Review Request" });
      } else if (t.id === "magnetForm" || t.id === "nlForm") {
        fbq("track", "Lead", { content_name: "Guide / Newsletter Opt-in" });
      }
    },
    true
  );

  function askedOscar() {
    fbq("trackCustom", "AskedAI");
    once("askedai_lead", function () {
      fbq("track", "Lead", { content_name: "Asked Oscar (first question)" });
    });
  }
  document.addEventListener(
    "click",
    function (e) {
      if (closestId(e.target, "heroSend")) askedOscar();
      var rcard = e.target.closest && e.target.closest(".rcard");
      if (rcard) fbq("track", "ViewContent", { content_name: rcard.id || "resource" });
    },
    true
  );
  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        var input = closestId(e.target, "heroInput");
        if (input && input.value && input.value.trim()) askedOscar();
      }
    },
    true
  );

  function watchSignIn() {
    var el = document.getElementById("sbEmail");
    if (!el) return;
    var check = function () {
      var v = (el.textContent || "").trim();
      if (v && v.indexOf("@") > -1)
        once("reg", function () {
          fbq("track", "CompleteRegistration", { content_name: "Google Sign-in" });
        });
    };
    check();
    new MutationObserver(check).observe(el, { childList: true, characterData: true, subtree: true });
  }
  if (document.readyState !== "loading") watchSignIn();
  else document.addEventListener("DOMContentLoaded", watchSignIn);
})();
