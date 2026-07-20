/* Blog interactivity: dialog typing animation, demo tabs, in-view video.
   Progressive enhancement: all content is plain text in the DOM; with JS off
   or prefers-reduced-motion everything is simply visible/static. */
(() => {
  "use strict";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- demo tabs (Naive vs proper import, etc.) ---- */
  document.querySelectorAll("[data-demo-tabs]").forEach((group) => {
    const tabs = Array.from(group.querySelectorAll(".tab"));
    const panels = Array.from(group.querySelectorAll(".panel"));
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t, j) => t.setAttribute("aria-selected", String(i === j)));
        panels.forEach((p, j) => p.classList.toggle("on", i === j));
      });
    });
  });

  /* ---- videos: play while visible, pause offscreen ---- */
  const clips = document.querySelectorAll("video[data-inview]");
  if (reduced) {
    clips.forEach((v) => { v.controls = true; });
  } else if ("IntersectionObserver" in window) {
    const vio = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const v = e.target;
        if (e.intersectionRatio >= 0.4) v.play().catch(() => {});
        else v.pause();
      });
    }, { threshold: [0, 0.4] });
    clips.forEach((v) => vio.observe(v));
  }

  /* ---- dialog typing animation ---- */
  if (reduced || !("IntersectionObserver" in window)) return;

  const TYPE_MS = 16;        // per char, user messages
  const DOTS_MS = 800;       // assistant "thinking" pause
  const GAP_MS = 350;        // pause between messages

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function playDialog(dialog) {
    const msgs = Array.from(dialog.querySelectorAll(".u, .a"));
    for (const msg of msgs) {
      const text = msg.textContent;
      if (msg.classList.contains("u")) {
        msg.textContent = "";
        const caret = document.createElement("span");
        caret.className = "caret";
        msg.appendChild(caret);
        msg.classList.add("shown");
        for (let i = 0; i < text.length; i++) {
          caret.before(text[i]);
          await sleep(TYPE_MS);
        }
        caret.remove();
      } else {
        msg.textContent = "";
        msg.insertAdjacentHTML("afterbegin",
          '<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>');
        msg.classList.add("shown");
        await sleep(DOTS_MS);
        msg.textContent = text;
      }
      await sleep(GAP_MS);
    }
  }

  const dialogs = Array.from(document.querySelectorAll(".dialog"))
    .filter((d) => !d.hasAttribute("data-noanim"));
  if (!dialogs.length) return;

  /* Lock height before clearing messages so the page does not jump. */
  dialogs.forEach((d) => {
    d.style.minHeight = d.offsetHeight + "px";
    d.classList.add("anim");
  });
  const dio = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      dio.unobserve(e.target);
      playDialog(e.target);
    });
  }, { threshold: 0.5 });
  dialogs.forEach((d) => dio.observe(d));
})();
