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
  function acct(name, tag, val, pos) {
    return '<div class="acct"><span class="an"><b>' + name + "</b>" +
      (tag ? '<span class="tag">' + tag + "</span>" : "") +
      '</span><span class="av' + (pos ? " pos" : "") + '">' + val + "</span></div>";
  }
  /* Demo text follows the page language (<html lang>): /es/ and /ru/ pages
     get their own words and number formats, everything else English. */
  var LANG = (document.documentElement.lang || "en").slice(0, 2);
  var L = {
    en: {
      locale: "en-US",
      budgets: "Budgets · July", groceries: "Groceries", restaurants: "Restaurants", transport: "Transport",
      summary: "June · summary", spent: "Spent", income: "Income", net: "Net", housing: "Housing",
      tiles: ["2,940", "4,100", "+1,160"],
      accounts: "Accounts · net worth", nw: "24,300 EUR", nwSub: "5 accounts · 3 currencies · converted at today's rates",
      acc: [["Revolut", "", "6,420 EUR"], ["Chase", "business", "11,900 USD eq."], ["Santander", "", "4,700 EUR"], ["Wise", "", "1,850 GBP eq."], ["Cash", "", "800 EUR"]],
      imp: "Statement import · July",
      impRows: [["Rows imported", "new", "61"], ["Lidl, logged by you", "merged", "-24.50"], ["Already imported", "skipped", "2"], ["Net vs statement", "match", "-1,842.30 EUR"]],
      chat: [
        ["Spent 24.50 eur on groceries at Lidl", "Logged: 24.50 EUR, groceries. Here's where you are this month:"],
        ["Here's my bank statement [screenshot]", "Read 64 rows. 61 imported, your hand-logged Lidl entry merged, 2 already there. The total matches the statement:"],
        ["How much did I spend on restaurants in June?", "412 EUR across 18 visits, 14% of your June spending, up 6% from May."],
        ["What's my net worth?", "24,300 EUR across 5 accounts in 3 currencies."]
      ]
    },
    es: {
      locale: "es-419",
      budgets: "Presupuestos · julio", groceries: "Supermercado", restaurants: "Restaurantes", transport: "Transporte",
      summary: "Junio · resumen", spent: "Gastos", income: "Ingresos", net: "Neto", housing: "Vivienda",
      tiles: ["2,940", "4,100", "+1,160"],
      accounts: "Cuentas · patrimonio neto", nw: "24,300 EUR", nwSub: "5 cuentas · 3 monedas · convertido al tipo de cambio de hoy",
      acc: [["Revolut", "", "6,420 EUR"], ["Chase", "empresa", "11,900 USD equiv."], ["Santander", "", "4,700 EUR"], ["Wise", "", "1,850 GBP equiv."], ["Efectivo", "", "800 EUR"]],
      imp: "Importación de extracto · julio",
      impRows: [["Filas importadas", "nuevas", "61"], ["Lidl, registrado por ti", "fusionado", "-24.50"], ["Ya importadas", "omitidas", "2"], ["Neto vs. extracto", "coincide", "-1,842.30 EUR"]],
      chat: [
        ["Gasté 24.50 euros en el súper, en Lidl", "Registrado: 24.50 EUR, supermercado. Así vas este mes:"],
        ["Aquí está mi extracto bancario [captura]", "Leí 64 filas. 61 importadas, tu gasto en Lidl registrado a mano quedó fusionado y 2 ya estaban. El total coincide con el extracto:"],
        ["¿Cuánto gasté en restaurantes en junio?", "412 EUR en 18 visitas, el 14% de tu gasto de junio, un 6% más que en mayo."],
        ["¿Cuál es mi patrimonio neto?", "24,300 EUR en 5 cuentas y 3 monedas."]
      ]
    },
    ru: {
      locale: "ru-RU",
      budgets: "Бюджеты · июль", groceries: "Продукты", restaurants: "Рестораны", transport: "Транспорт",
      summary: "Июнь · сводка", spent: "Расходы", income: "Доходы", net: "Итог", housing: "Жильё",
      tiles: ["2\u00a0940", "4\u00a0100", "+1\u00a0160"],
      accounts: "Счета · капитал", nw: "24\u00a0300 EUR", nwSub: "5 счетов · 3 валюты · по сегодняшнему курсу",
      acc: [["Revolut", "", "6\u00a0420 EUR"], ["Chase", "бизнес", "11\u00a0900 USD экв."], ["Santander", "", "4\u00a0700 EUR"], ["Wise", "", "1\u00a0850 GBP экв."], ["Наличные", "", "800 EUR"]],
      imp: "Импорт выписки · июль",
      impRows: [["Импортировано строк", "новые", "61"], ["Lidl, внесено вами", "объединено", "-24,50"], ["Уже были", "пропущено", "2"], ["Итог по выписке", "совпадает", "-1\u00a0842,30 EUR"]],
      chat: [
        ["Потратил 24,50 евро на продукты в Lidl", "Записал: 24,50 EUR, продукты. Вот как дела с бюджетами в этом месяце:"],
        ["Вот моя банковская выписка [скриншот]", "Прочитал 64 строки. 61 импортирована, ваша ручная запись Lidl объединена, 2 уже были. Итог совпадает с выпиской:"],
        ["Сколько я потратил на рестораны в июне?", "412 EUR за 18 визитов, 14% ваших расходов за июнь, на 6% больше, чем в мае."],
        ["Какой у меня капитал?", "24\u00a0300 EUR на 5 счетах в 3 валютах."]
      ]
    }
  };
  var T = L[LANG] || L.en;

  function renderBudgets() {
    var r = el("div", "render");
    r.innerHTML = "<h4>" + T.budgets + "</h4>" +
      brow(T.groceries, "310 / 400", 78, false) +
      brow(T.restaurants, "368 / 400", 92, true) +
      brow(T.transport, "82 / 200", 41, false);
    return r;
  }
  function renderSummary() {
    var r = el("div", "render");
    r.innerHTML = "<h4>" + T.summary + "</h4>" +
      '<div class="tiles">' +
      '<div class="tile"><div class="k">' + T.spent + '</div><div class="v">' + T.tiles[0] + "</div></div>" +
      '<div class="tile"><div class="k">' + T.income + '</div><div class="v">' + T.tiles[1] + "</div></div>" +
      '<div class="tile"><div class="k">' + T.net + '</div><div class="v pos">' + T.tiles[2] + "</div></div>" +
      "</div>" +
      brow(T.groceries, "706", 24, false) +
      brow(T.housing, "647", 22, false) +
      brow(T.restaurants, "412", 14, false);
    return r;
  }
  function renderAccounts() {
    var r = el("div", "render");
    r.innerHTML = "<h4>" + T.accounts + "</h4>" +
      '<div class="nw">' + T.nw + "</div>" +
      '<div class="nw-sub">' + T.nwSub + "</div>" +
      T.acc.map(function (a) { return acct(a[0], a[1], a[2]); }).join("");
    return r;
  }

  function renderImport() {
    var r = el("div", "render");
    r.innerHTML = "<h4>" + T.imp + "</h4>" +
      T.impRows.map(function (a, i) { return acct(a[0], a[1], a[2], i === 3); }).join("");
    return r;
  }

  var scenarios = [
    { user: T.chat[0][0], ai: T.chat[0][1], render: renderBudgets },
    { user: T.chat[1][0], ai: T.chat[1][1], render: renderImport },
    { user: T.chat[2][0], ai: T.chat[2][1], render: renderSummary },
    { user: T.chat[3][0], ai: T.chat[3][1], render: renderAccounts }
  ];

  function fillBars(scope) {
    scope.querySelectorAll(".fill").forEach(function (b) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { b.style.width = b.getAttribute("data-w") + "%"; });
      });
    });
  }

  /* The chat accumulates like a real conversation and auto-scrolls; a full
     loop ends with a soft fade-restart. Chip clicks interrupt whatever is
     playing (seq token) and append the chosen scenario to the history. */
  var seq = 0;

  function scrollBottom() {
    if (body) body.scrollTop = body.scrollHeight;
  }

  function typeText(node, text, mySeq, cb) {
    if (reduced) { node.textContent = text; if (cb) cb(); return; }
    var i = 0;
    var caret = el("span", "caret");
    node.appendChild(caret);
    (function tick() {
      if (seq !== mySeq) { caret.remove(); return; }
      if (i < text.length) {
        caret.insertAdjacentText("beforebegin", text.charAt(i));
        i++;
        scrollBottom();
        setTimeout(tick, 22 + Math.random() * 26);
      } else {
        caret.remove();
        if (cb) cb();
      }
    })();
  }

  function playScenario(idx, mySeq) {
    var s = scenarios[idx];
    var u = el("div", "msg user", "");
    body.appendChild(u);
    scrollBottom();
    typeText(u, s.user, mySeq, function () {
      setTimeout(function () {
        if (seq !== mySeq) return;
        var dots = el("div", "msg ai", '<span class="typing-dots"><i></i><i></i><i></i></span>');
        body.appendChild(dots);
        scrollBottom();
        setTimeout(function () {
          dots.remove();
          if (seq !== mySeq) return;
          var a = el("div", "msg ai", "");
          body.appendChild(a);
          scrollBottom();
          typeText(a, s.ai, mySeq, function () {
            var r = s.render();
            body.appendChild(r);
            requestAnimationFrame(function () { r.classList.add("show"); scrollBottom(); });
            fillBars(r);
            setTimeout(scrollBottom, 400);
            if (reduced) return;
            setTimeout(function () {
              if (seq !== mySeq) return;
              var next = (idx + 1) % scenarios.length;
              if (next === 0) restartLoop(mySeq); else playScenario(next, mySeq);
            }, 5200);
          });
        }, reduced ? 0 : 900);
      }, reduced ? 0 : 350);
    });
  }

  function restartLoop(mySeq) {
    body.classList.add("fade");
    setTimeout(function () {
      body.classList.remove("fade");
      if (seq !== mySeq) return;
      body.innerHTML = "";
      playScenario(0, mySeq);
    }, 450);
  }

  var chipsWrap = document.getElementById("demoChips");
  if (body && chipsWrap) {
    chipsWrap.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        seq++;
        /* keep the history from growing unbounded on rapid clicks */
        while (body.children.length > 9) body.removeChild(body.firstChild);
        playScenario(parseInt(b.getAttribute("data-s"), 10), seq);
      });
    });
  }

  if (body) playScenario(0, seq);

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
      var addr = ["alex", "a-systems.pro"].join("@");
      mail.textContent = addr;
      mail.href = "mailto:" + addr;
    }, { once: true });
  }

  /* ---------- demo video: poster overlay play ---------- */
  var vplay = document.getElementById("vplay");
  var demoVideo = document.getElementById("demoVideo");
  if (vplay && demoVideo) {
    vplay.addEventListener("click", function () {
      vplay.classList.add("off");
      demoVideo.play();
    });
    demoVideo.addEventListener("play", function () { vplay.classList.add("off"); });
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
        if (reduced || !target) { c.textContent = target.toLocaleString(T.locale, { useGrouping: true }); return; }
        var t0 = null;
        function step(ts) {
          if (!t0) t0 = ts;
          var p = Math.min((ts - t0) / 1200, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          c.textContent = Math.round(target * eased).toLocaleString(T.locale, { useGrouping: true });
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
  /* Live timezones only: the section promises every number is real, so the
     map never pads itself with seed zones (it hides until it has a real dot). */
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
      var plotted = buildMap(res[1], s.timezone_list || []);
      document.getElementById("mapCount").setAttribute("data-count", plotted);
      var mapBlock = statsSec.querySelector(".map-block");
      if (mapBlock && plotted === 0) mapBlock.hidden = true;
      statsSec.hidden = false;
      statsSec.querySelectorAll(".reveal").forEach(function (r) { io.observe(r); });
    }).catch(function () { /* stats unavailable: section stays hidden */ });
  }
})();
