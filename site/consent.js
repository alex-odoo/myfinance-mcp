/* Google Analytics with consent (Consent Mode v2, advanced). gtag.js always
   loads, but every storage type starts denied for every visitor, so GA gets
   cookieless pings with no identifiers until the visitor clicks Allow.
   Loaded synchronously in <head>, so the consent default is in dataLayer
   before the config command. No inline script: the landing CSP allows
   scripts from 'self' and googletagmanager.com only. */
(function () {
  "use strict";
  var GA_ID = "G-SFT6JY9Q7W";
  var KEY = "mf_consent"; // "granted" | "denied"; absent = not asked yet

  /* ---------- stored choice ---------- */
  // Storage can throw (blocked site data, some private modes): that counts as
  // no choice, and the banner asks again on the next page.
  function readChoice() {
    try {
      var v = window.localStorage.getItem(KEY);
      return v === "granted" || v === "denied" ? v : null;
    } catch (e) {
      return null;
    }
  }
  function saveChoice(v) {
    try {
      window.localStorage.setItem(KEY, v);
    } catch (e) { /* the choice still applies to this page */ }
  }

  /* ---------- gtag bootstrap ---------- */
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  var choice = readChoice();
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: choice === "granted" ? "granted" : "denied"
  });
  gtag("set", "ads_data_redaction", true);
  gtag("js", new Date());
  gtag("config", GA_ID);

  /* ---------- decline: drop GA cookies already set ---------- */
  // GA4 writes _ga and _ga_<stream> on the widest domain the browser accepts
  // (.myfinance-mcp.com, .rteam.agency on the preview host). Expire them
  // host-only and on every parent domain; the browser ignores the rest.
  function dropGaCookies() {
    try {
      var names = document.cookie.split(";").map(function (c) {
        return c.split("=")[0].trim();
      }).filter(function (n) { return /^_ga(_|$)/.test(n); });
      if (!names.length) return;
      var parts = location.hostname.split(".");
      var domains = [""];
      for (var i = 0; i < parts.length - 1; i++) domains.push("; domain=." + parts.slice(i).join("."));
      names.forEach(function (n) {
        domains.forEach(function (d) {
          document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" + d;
        });
      });
    } catch (e) { /* cookies unavailable: nothing to drop */ }
  }

  /* ---------- banner ---------- */
  // Injected here, not in styles.css, so every page gets it. Colors come from
  // the landing's tokens, with fallbacks for a page without styles.css.
  var CSS =
    ".mf-consent{--mfc-bg:var(--surface,#FFFDF8);--mfc-ink:var(--ink,#1C1B16);--mfc-muted:var(--muted,#6F6A5C);" +
      "--mfc-rule:var(--rule,#E5E1D4);--mfc-acc:var(--accent,#0E6B4F);" +
      "position:fixed;left:0;right:0;bottom:16px;z-index:60;box-sizing:border-box;" +
      "width:calc(100% - 32px);max-width:760px;margin:0 auto;padding:16px 18px;" +
      "display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;" +
      "background:var(--mfc-bg);color:var(--mfc-ink);border:1px solid var(--mfc-rule);border-radius:14px;" +
      "box-shadow:var(--shadow,0 1px 2px rgba(28,27,22,.05),0 8px 28px rgba(28,27,22,.06));" +
      "font-family:var(--body,-apple-system,BlinkMacSystemFont,\"Helvetica Neue\",Arial,sans-serif);" +
      "font-size:15px;line-height:1.5;text-align:left}" +
    "@media (prefers-color-scheme:dark){.mf-consent{--mfc-bg:var(--surface,#201F18);--mfc-ink:var(--ink,#EDEAE0);" +
      "--mfc-muted:var(--muted,#9B968A);--mfc-rule:var(--rule,#2F2D24);--mfc-acc:var(--accent,#3EC395)}}" +
    ".mf-consent[hidden]{display:none}" +
    ".mf-consent-copy{flex:999 1 300px;min-width:0}" +
    ".mf-consent p{margin:0}" +
    ".mf-consent a{color:var(--mfc-acc);text-underline-offset:3px}" +
    ".mf-consent .mf-consent-now{margin-top:4px;color:var(--mfc-muted);font-size:13.5px}" +
    ".mf-consent-actions{flex:1 1 auto;display:flex;gap:10px}" +
    ".mf-consent button{flex:1 1 0;min-width:96px;min-height:44px;margin:0;padding:10px 18px;" +
      "border:1px solid var(--mfc-ink);border-radius:10px;background:transparent;color:var(--mfc-ink);" +
      "font-family:inherit;font-size:15px;font-weight:600;line-height:1.2;cursor:pointer}" +
    ".mf-consent button:hover{border-color:var(--mfc-acc);color:var(--mfc-acc)}" +
    ".mf-consent a:focus-visible,.mf-consent button:focus-visible{outline:2px solid var(--mfc-acc);outline-offset:3px}" +
    // Room under the footer while the banner is up, so it never hides the last links.
    "html.mf-consent-open body{padding-bottom:var(--mf-consent-h,0px)}" +
    "@media (max-width:480px){.mf-consent{bottom:10px;width:calc(100% - 20px);padding:14px;font-size:14.5px}}" +
    "@media print{.mf-consent{display:none}}";

  var banner, now, opener;

  function build() {
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    banner = document.createElement("div");
    banner.className = "mf-consent";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Cookie consent");
    banner.hidden = true;
    banner.innerHTML =
      '<div class="mf-consent-copy">' +
        "<p>We use Google Analytics cookies to see which pages are useful. Your financial data is never part of this. " +
        '<a href="/privacy#cookies">Details</a></p>' +
        '<p class="mf-consent-now" hidden></p>' +
      "</div>" +
      // Equal weight on purpose: same size, same style, no default.
      '<div class="mf-consent-actions">' +
        '<button type="button" data-consent="granted">Allow</button>' +
        '<button type="button" data-consent="denied">Decline</button>' +
      "</div>";
    now = banner.querySelector(".mf-consent-now");
    banner.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-consent]");
      if (b) decide(b.getAttribute("data-consent"));
    });
    // Reopened from the footer: Escape keeps the current choice.
    banner.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && choice) hide();
    });
    document.body.appendChild(banner);
    // Re-measure when the text rewraps (web font swap, rotation, resize).
    if (window.ResizeObserver) new ResizeObserver(reserve).observe(banner);
    else window.addEventListener("resize", reserve);
  }

  function reserve() {
    var root = document.documentElement;
    if (!banner || banner.hidden) {
      root.classList.remove("mf-consent-open");
      return;
    }
    root.style.setProperty("--mf-consent-h", banner.offsetHeight + 24 + "px");
    root.classList.add("mf-consent-open");
  }

  function show(from) {
    if (!banner) build();
    now.hidden = !choice;
    now.textContent = choice === "granted" ? "You allowed analytics cookies. You can change that here."
      : choice === "denied" ? "You declined analytics cookies. You can change that here." : "";
    banner.hidden = false;
    reserve();
    if (from) {
      opener = from;
      banner.querySelector("button").focus();
    }
  }

  function hide() {
    banner.hidden = true;
    reserve();
    if (opener) {
      opener.focus();
      opener = null;
    }
  }

  function decide(v) {
    choice = v;
    saveChoice(v);
    gtag("consent", "update", { analytics_storage: v });
    if (v === "denied") dropGaCookies();
    hide();
  }

  // Footer "Cookie settings" links (data-cookie-settings) reopen the banner;
  // their href to the privacy page is the no-JS fallback.
  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("[data-cookie-settings]");
    if (!link) return;
    e.preventDefault();
    show(link);
  });

  if (!choice) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { show(); });
    } else {
      show();
    }
  }
})();
