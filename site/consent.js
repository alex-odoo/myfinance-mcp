/* Google Analytics only with consent. Nothing is sent to Google until the
   visitor clicks Allow: gtag.js itself is injected only then (or on a later
   visit with the stored "granted"). Before a choice and after Decline no
   request leaves for Google at all, not even a cookieless ping: several EU
   regulators treat that transfer (IP, page, referrer) as needing consent.
   Loaded with defer; banner styles live in styles.css. No inline script:
   the landing CSP allows scripts from 'self' and googletagmanager.com only. */
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

  /* ---------- GA cookies ---------- */
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

  /* ---------- GA, after consent only ---------- */
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  var gaLoaded = false;

  function loadGa() {
    if (gaLoaded) return;
    gaLoaded = true;
    gtag("consent", "default", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "granted"
    });
    gtag("set", "ads_data_redaction", true);
    gtag("js", new Date());
    gtag("config", GA_ID);
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(s);
  }

  var choice = readChoice();
  if (choice === "granted") loadGa();
  // Cookies from before this banner existed (GA ran unconditionally until
  // 2026-10-01) go for everyone who has not allowed them.
  else dropGaCookies();

  /* ---------- banner ---------- */
  var banner, now, opener;

  function build() {
    banner = document.createElement("div");
    banner.className = "mf-consent";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Analytics consent");
    banner.hidden = true;
    banner.innerHTML =
      '<div class="mf-consent-copy">' +
        "<p>May we use Google Analytics to see which pages are useful? It loads only if you allow it, and your financial data is never part of it. " +
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
    now.textContent = choice === "granted" ? "You allowed Google Analytics. You can change that here."
      : choice === "denied" ? "You declined Google Analytics. You can change that here." : "";
    banner.hidden = false;
    reserve();
    if (from) {
      opener = from;
      banner.querySelector("button").focus();
    }
  }

  function hide() {
    var hadFocus = banner.contains(document.activeElement);
    banner.hidden = true;
    reserve();
    if (opener) {
      opener.focus();
      opener = null;
    } else if (hadFocus) {
      // First-visit choice: the focused button just vanished; continue at
      // the content instead of the top of the document.
      var main = document.querySelector("main");
      if (main) {
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus({ preventScroll: true });
      }
    }
  }

  function decide(v) {
    var was = choice;
    choice = v;
    saveChoice(v);
    if (v === "granted") {
      loadGa();
    } else {
      // Withdrawn on a page where GA already runs: Google's own opt-out flag
      // stops it on this page (consent "denied" alone still lets it send a
      // cookieless hit, e.g. the engagement beacon on leaving); from the
      // next page on it is not loaded at all.
      if (was === "granted" && gaLoaded) {
        window["ga-disable-" + GA_ID] = true;
        gtag("consent", "update", { analytics_storage: "denied" });
      }
      dropGaCookies();
    }
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
