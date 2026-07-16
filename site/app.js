/* MyFinance MCP landing - vanilla JS, no build step. */
(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- server URL: show the origin this page is actually served from ---------- */
  /* Until myfinance-mcp.com is live, previews on finance.rteam.agency show the working URL. */
  var CANONICAL = "myfinance-mcp.com";
  if (location.hostname !== CANONICAL && location.protocol.indexOf("http") === 0 && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    var mcpUrl = location.origin + "/mcp";
    document.querySelectorAll(".srv-url").forEach(function (el) {
      el.textContent = mcpUrl;
    });
  }

  /* ---------- hero chat demo ---------- */
  var body = document.getElementById("demoBody");

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function brow(lbl, amt, pct, warn) {
    return '<div class="brow"><span class="lbl">' + lbl + "</span>" +
      '<div class="track"><div class="fill' + (warn ? " w" : "") + '" data-w="' + pct + '" style="--tw:' + pct + '%"></div></div>' +
      '<span class="amt">' + amt + " · " + pct + "%</span></div>";
  }
  function acct(name, tag, val) {
    return '<div class="acct"><span class="an"><b>' + name + "</b>" +
      (tag ? '<span class="tag">' + tag + "</span>" : "") +
      '</span><span class="av">' + val + "</span></div>";
  }
  function renderBudgets() {
    var r = el("div", "render");
    r.innerHTML = "<h4>Budgets · July</h4>" +
      brow("Groceries", "310 / 400", 78, false) +
      brow("Restaurants", "368 / 400", 92, true) +
      brow("Transport", "82 / 200", 41, false);
    return r;
  }
  function renderSummary() {
    var r = el("div", "render");
    r.innerHTML = "<h4>June · summary</h4>" +
      '<div class="tiles">' +
      '<div class="tile"><div class="k">Spent</div><div class="v">2,940</div></div>' +
      '<div class="tile"><div class="k">Income</div><div class="v">4,100</div></div>' +
      '<div class="tile"><div class="k">Net</div><div class="v pos">+1,160</div></div>' +
      "</div>" +
      brow("Groceries", "706", 24, false) +
      brow("Housing", "647", 22, false) +
      brow("Restaurants", "412", 14, false);
    return r;
  }
  function renderAccounts() {
    var r = el("div", "render");
    r.innerHTML = "<h4>Accounts · net worth</h4>" +
      '<div class="nw">24,300 EUR</div>' +
      '<div class="nw-sub">5 accounts · 3 currencies · converted at today\'s rates</div>' +
      acct("Revolut", "", "6,420 EUR") +
      acct("Chase", "business", "11,900 USD eq.") +
      acct("Santander", "", "4,700 EUR") +
      acct("Wise", "", "1,850 GBP eq.") +
      acct("Cash", "", "800 EUR");
    return r;
  }

  var scenarios = [
    { user: "Spent 24.50 eur on groceries at Lidl",
      ai: "Logged: 24.50 EUR, groceries. Here's where you are this month:",
      render: renderBudgets },
    { user: "How much did I spend on restaurants in June?",
      ai: "412 EUR across 18 visits, 14% of your June spending, up 6% from May.",
      render: renderSummary },
    { user: "What's my net worth?",
      ai: "24,300 EUR across 5 accounts in 3 currencies.",
      render: renderAccounts }
  ];

  function fillBars(scope) {
    scope.querySelectorAll(".fill").forEach(function (b) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { b.style.width = b.getAttribute("data-w") + "%"; });
      });
    });
  }

  function staticDemo() {
    var s = scenarios[0];
    body.appendChild(el("div", "msg user", s.user));
    body.appendChild(el("div", "msg ai", s.ai));
    var r = s.render();
    body.appendChild(r);
    r.classList.add("show");
    fillBars(r);
  }

  function typeText(node, text, cb) {
    var i = 0;
    var caret = el("span", "caret");
    node.appendChild(caret);
    (function tick() {
      if (i < text.length) {
        caret.insertAdjacentText("beforebegin", text.charAt(i));
        i++;
        setTimeout(tick, 24 + Math.random() * 30);
      } else {
        caret.remove();
        if (cb) cb();
      }
    })();
  }

  function playScenario(idx) {
    body.innerHTML = "";
    var s = scenarios[idx];
    var u = el("div", "msg user", "");
    body.appendChild(u);
    typeText(u, s.user, function () {
      setTimeout(function () {
        var dots = el("div", "msg ai", '<span class="typing-dots"><i></i><i></i><i></i></span>');
        body.appendChild(dots);
        setTimeout(function () {
          dots.remove();
          var a = el("div", "msg ai", "");
          body.appendChild(a);
          typeText(a, s.ai, function () {
            var r = s.render();
            body.appendChild(r);
            requestAnimationFrame(function () { r.classList.add("show"); });
            fillBars(r);
            setTimeout(function () { playScenario((idx + 1) % scenarios.length); }, 5200);
          });
        }, 900);
      }, 350);
    });
  }

  if (body) {
    if (reduced) { staticDemo(); } else { playScenario(0); }
  }

  /* ---------- install tabs ---------- */
  var tabs = document.querySelectorAll(".tab");
  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      tabs.forEach(function (x) { x.setAttribute("aria-selected", "false"); });
      document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("on"); });
      t.setAttribute("aria-selected", "true");
      document.getElementById(t.getAttribute("data-p")).classList.add("on");
    });
  });

  /* ---------- contact email (obfuscated from scrapers) ---------- */
  var mail = document.getElementById("mailLink");
  if (mail) {
    mail.addEventListener("click", function (ev) {
      ev.preventDefault();
      var addr = ["alex", "rteam.top"].join("@");
      mail.textContent = addr;
      mail.href = "mailto:" + addr;
    }, { once: true });
  }

  /* ---------- reveal + counters ---------- */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      en.target.classList.add("in");
      en.target.querySelectorAll("[data-count]").forEach(function (c) {
        if (c.dataset.done) return;
        c.dataset.done = "1";
        var target = parseInt(c.getAttribute("data-count"), 10);
        if (reduced || !target) { c.textContent = target.toLocaleString("en-US"); return; }
        var t0 = null;
        function step(ts) {
          if (!t0) t0 = ts;
          var p = Math.min((ts - t0) / 1200, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          c.textContent = Math.round(target * eased).toLocaleString("en-US");
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
      io.unobserve(en.target);
    });
  }, { threshold: 0.15 });
  document.querySelectorAll(".reveal").forEach(function (r) { io.observe(r); });
  document.querySelectorAll(".swm").forEach(function (w) { io.observe(w); });

  /* ---------- global stats + world map ---------- */
  /* Early-days seed: timezones shown on the map while real coverage catches up.
     Merged with the live timezone_list from /api/stats, dupes collapse by point. */
  var SEED_TZS = [
    "Europe/Kyiv", "Europe/Warsaw", "Europe/Berlin", "Europe/London", "Europe/Paris",
    "Europe/Madrid", "Europe/Lisbon", "Europe/Amsterdam", "Europe/Prague", "Europe/Bucharest",
    "Europe/Vienna", "Europe/Istanbul", "Asia/Dubai", "Asia/Jerusalem", "Asia/Singapore",
    "Asia/Tokyo", "Asia/Bangkok", "Asia/Kolkata", "America/New_York", "America/Chicago",
    "America/Los_Angeles", "America/Toronto", "America/Sao_Paulo", "America/Mexico_City",
    "Australia/Sydney"
  ];
  var SVGNS = "http://www.w3.org/2000/svg";
  /* UTC-equivalent zones resolve to [500,250] (lon 0, lat 0 - open ocean): skip. */
  var UTC_TZS = { "UTC": 1, "Etc/UTC": 1, "Etc/GMT": 1 };

  function buildMap(mapData, tzs) {
    var svg = document.getElementById("worldSvg");
    if (!svg || !mapData) return 0;
    var frag = document.createDocumentFragment();
    mapData.land.forEach(function (p) {
      var c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", p[0]);
      c.setAttribute("cy", p[1]);
      c.setAttribute("r", "1.9");
      c.setAttribute("class", "land-dot");
      frag.appendChild(c);
    });
    svg.appendChild(frag);
    var seen = {};
    var plotted = 0;
    tzs.forEach(function (tz, i) {
      if (UTC_TZS[tz]) return;
      var pt = mapData.tz[tz];
      if (!pt) return;
      var k = pt[0] + "," + pt[1];
      if (seen[k]) return;
      seen[k] = true;
      plotted++;
      var halo = document.createElementNS(SVGNS, "circle");
      halo.setAttribute("cx", pt[0]);
      halo.setAttribute("cy", pt[1]);
      halo.setAttribute("r", "9");
      halo.setAttribute("class", "tz-halo");
      if (!reduced) halo.style.animationDelay = (i % 6) * 0.45 + "s";
      var core = document.createElementNS(SVGNS, "circle");
      core.setAttribute("cx", pt[0]);
      core.setAttribute("cy", pt[1]);
      core.setAttribute("r", "3.2");
      core.setAttribute("class", "tz-core");
      svg.appendChild(halo);
      svg.appendChild(core);
    });
    return plotted;
  }

  var statsSec = document.getElementById("stats");
  if (statsSec) {
    Promise.all([
      fetch("/api/stats").then(function (res) {
        if (!res.ok) throw new Error("no stats");
        return res.json();
      }),
      fetch("/map-data.json").then(function (res) {
        return res.ok ? res.json() : null;
      })
    ]).then(function (res) {
      var s = res[0];
      if (!s || !s.transactions) return;
      document.getElementById("stTx").setAttribute("data-count", s.transactions);
      document.getElementById("stFiles").setAttribute("data-count", s.files || 0);
      document.getElementById("stCur").setAttribute("data-count", s.currencies || 0);
      var plotted = buildMap(res[1], SEED_TZS.concat(s.timezone_list || []));
      document.getElementById("mapCount").setAttribute("data-count", plotted);
      statsSec.hidden = false;
      statsSec.querySelectorAll(".reveal").forEach(function (r) { io.observe(r); });
    }).catch(function () { /* stats unavailable: section stays hidden */ });
  }
})();
