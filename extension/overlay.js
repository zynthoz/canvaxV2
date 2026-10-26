(() => {
  // ── Universal Text Highlighting & Selection Unlocker ──────────────────────
  // Executes immediately across all frames (top-level and iframes) to break through:
  // 1. CSS user-select: none / -webkit-user-select: none
  // 2. JavaScript event killers: selectstart, mousedown, mouseup, copy, cut, contextmenu
  // 3. Inline attributes: onselectstart="return false", oncopy="return false"
  // 4. Transparent overlay div shields sitting over text (disables pointer-events on empty overlay layers)
  function unlockPageHighlighting() {
    try {
      const styleId = "cx-highlight-unlocker";
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          *, *::before, *::after {
            -webkit-user-select: text !important;
            -moz-user-select: text !important;
            -ms-user-select: text !important;
            user-select: text !important;
            -webkit-touch-callout: default !important;
          }
          /* Neutralize invisible shields/canvas overlays that block text selection */
          div[style*="opacity: 0"], div[style*="opacity:0"],
          .prevent-select, .no-select, .unselectable, .protected-content {
            -webkit-user-select: text !important;
            user-select: text !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }

      // Neutralize JS-level event cancellation in the capturing phase
      const unblockEvents = ["selectstart", "mousedown", "mouseup", "copy", "cut", "contextmenu", "dragstart"];
      unblockEvents.forEach(evt => {
        window.addEventListener(evt, e => {
          // If the page's event listener tries to prevent selection/copying, stop it
          if (e.target && !e.target.closest?.("#cx-host")) {
            e.stopPropagation ? e.stopPropagation() : null;
          }
        }, true);
      });

      // Clear inline HTML attribute blocks (e.g. <body onselectstart="return false">)
      function clearInlineBlocks() {
        if (!document.body) return;
        const inlineAttrs = ["onselectstart", "oncopy", "oncut", "oncontextmenu", "ondragstart", "onmousedown"];
        [document.body, document.documentElement].forEach(target => {
          if (!target) return;
          inlineAttrs.forEach(attr => {
            if (target.hasAttribute(attr)) target.removeAttribute(attr);
            if (target[attr]) target[attr] = null;
          });
        });
      }

      clearInlineBlocks();
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", clearInlineBlocks, { once: true });
      }

      // Detect and neutralize transparent blocker elements floating over content
      function neutraliseOverlays() {
        const potentialShields = document.querySelectorAll("div, span");
        potentialShields.forEach(el => {
          if (el.id === "cx-host" || el.closest("#cx-host")) return;
          const cs = window.getComputedStyle ? getComputedStyle(el) : null;
          if (cs && (cs.position === "absolute" || cs.position === "fixed")) {
            const z = parseInt(cs.zIndex, 10);
            const isTransparent = cs.opacity === "0" || cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent";
            const hasNoDirectText = !el.innerText || !el.innerText.trim();
            // If it's a floating transparent layer with high z-index and no text, disable its pointer events
            if (z > 10 && isTransparent && hasNoDirectText && el.children.length === 0) {
              el.style.pointerEvents = "none";
            }
          }
        });
      }

      if (document.readyState === "complete" || document.readyState === "interactive") {
        neutraliseOverlays();
      } else {
        window.addEventListener("load", neutraliseOverlays, { once: true });
      }
    } catch {}
  }

  // Run immediately on script evaluation
  unlockPageHighlighting();

  const isTopFrame = window.self === window.top;
  const IDLE_MS = 1500, MIN_CHARS = 3, MAX_CHARS = 8000;

  // ── Child Frame Handler (iframes / embedded quizzes) ──────────────────────
  // If we are inside an iframe, DO NOT inject the overlay DOM.
  // Instead, passively listen for selections and forward them to the top frame.
  if (!isTopFrame) {
    let visible = true, idleTimer = null, lastText = "";
    try {
      chrome.storage.local.get("cxVisible", data => {
        if (data.cxVisible !== undefined) visible = data.cxVisible;
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.cxVisible !== undefined) {
          visible = changes.cxVisible.newValue;
        }
      });
    } catch {}

    document.addEventListener("selectionchange", () => {
      if (!visible) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const sel = window.getSelection();
        const raw = sel?.toString().trim() ?? "";
        if (!raw || raw.length < MIN_CHARS || raw === lastText) return;

        const container = findContainer(sel.anchorNode);
        const context = extractContext(container);
        let promptContent = raw;
        if (context && context.length > raw.length && context.includes(raw)) {
          promptContent = `FOCUSED SELECTION: "${raw}"\n\nLOCAL QUESTION CONTEXT & OPTIONS:\n${context}`;
        }

        lastText = raw;
        try {
          chrome.runtime.sendMessage({
            type: "FRAME_SELECTION",
            text: raw,
            enriched: promptContent,
            preview: raw
          });
        } catch {}
      }, IDLE_MS);
    });
    return;
  }

  if (document.getElementById("cx-host")) return;

  let visible = false, lastText = "", idleTimer = null, apiKey = null;
  let currentMode = "highlight"; // "highlight" | "screen"
  let dragging = false, dragOX = 0, dragOY = 0;
  let resizing = false, resStartX, resStartY, resStartW, resStartH;
  let port = null, reqId = 0;        // active streaming port / request counter (stale-reply guard)
  let lastAskText = "", answerPlain = "";

  // ── DOM ─────────────────────────────────────────────────────────────────
  // Shadow DOM host: isolates the overlay from the page's CSS (and the page from ours).
  const host = document.createElement("div");
  host.id = "cx-host";
  const root = host.attachShadow({ mode: "closed" });
  const $ = id => root.getElementById(id);

  const styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = chrome.runtime.getURL("overlay.css");
  root.appendChild(styleLink);

  const overlay = document.createElement("div");
  overlay.id = "cx-overlay";
  overlay.className = "cx-hidden"; // Start hidden until visibility preference is checked
  overlay.innerHTML = `
    <div id="cx-header">
      <span id="cx-title">canvax</span>
      <div class="cx-header-actions">
        <button id="cx-cfg" title="Settings">⚙</button>
        <button id="cx-close" title="Close">×</button>
      </div>
    </div>

    <!-- Setup / first-run key entry -->
    <div id="cx-setup">
      <div id="cx-setup-t">Connect Gemini API</div>
      <div id="cx-setup-d">Paste your key from <a href="https://aistudio.google.com/app/apikey" target="_blank">Google AI Studio</a>.</div>
      <input id="cx-ki" type="password" placeholder="AIzaSy..." autocomplete="off" spellcheck="false" />
      <div id="cx-setup-btns">
        <button id="cx-kb" style="display:none">Back</button>
        <button id="cx-ks">Connect</button>
      </div>
      <div id="cx-err"></div>
    </div>

    <!-- Settings panel -->
    <div id="cx-settings" style="display:none">
      <div class="cx-set-row">
        <span class="cx-set-label">Mode</span>
        <div id="cx-modes">
          <button class="cx-mode active" data-mode="highlight">Highlight</button>
          <button class="cx-mode" data-mode="screen">Screen</button>
        </div>
      </div>
      <div class="cx-set-row">
        <span class="cx-set-label">Theme</span>
        <div id="cx-themes">
          <button class="cx-mode active" data-theme="auto">Auto</button>
          <button class="cx-mode" data-theme="light">Light</button>
          <button class="cx-mode" data-theme="dark">Dark</button>
        </div>
      </div>
      <div class="cx-set-row">
        <span class="cx-set-label">API Key</span>
        <button id="cx-rekey">Change Key</button>
      </div>
      <div class="cx-set-row" style="justify-content:flex-end">
        <button id="cx-set-done">Done</button>
      </div>
    </div>

    <!-- Main body -->
    <div id="cx-body" style="display:none">
      <div id="cx-status">Highlight text to query</div>
      <div id="cx-sel" style="display:none" title="Click to expand"><span id="cx-sel-badge">Q</span><span id="cx-sel-txt"></span></div>
      <div id="cx-think" style="display:none"><div class="cx-d"></div><div class="cx-d"></div><div class="cx-d"></div></div>
      <div id="cx-ans-wrap" style="display:none"><div id="cx-ans"></div></div>
      <div id="cx-foot">
        <button id="cx-tag"></button>
        <div class="cx-foot-actions">
          <button id="cx-copy">Copy</button>
          <button id="cx-clr">Clear</button>
        </div>
      </div>
    </div>
    <div id="cx-rz"></div>`;
  root.appendChild(overlay);
  document.documentElement.appendChild(host);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const bodyEl    = $("cx-body");
  const setupEl   = $("cx-setup");
  const settingsEl= $("cx-settings");
  const statusEl  = $("cx-status");
  const selEl     = $("cx-sel");
  const selBadge  = $("cx-sel-badge");
  const selTxt    = $("cx-sel-txt");
  const ansWrap   = $("cx-ans-wrap");
  const ansEl     = $("cx-ans");
  const thinkEl   = $("cx-think");
  const closeBtn  = $("cx-close");
  const cfgBtn    = $("cx-cfg");
  const clrBtn    = $("cx-clr");
  const keyIn     = $("cx-ki");
  const ksBtn     = $("cx-ks");
  const kbBtn     = $("cx-kb");
  const errEl     = $("cx-err");
  const rekeyBtn  = $("cx-rekey");
  const doneBtn   = $("cx-set-done");
  const header    = $("cx-header");
  const rzHandle  = $("cx-rz");
  const tagEl     = $("cx-tag");
  const copyBtn   = $("cx-copy");

  // ── Panels ──────────────────────────────────────────────────────────────
  function hideAll3() {
    setupEl.style.display = "none";
    settingsEl.style.display = "none";
    bodyEl.style.display = "none";
  }

  function showMain() { hideAll3(); bodyEl.style.display = "flex"; }
  function showSetup() {
    hideAll3(); setupEl.style.display = "flex"; errEl.textContent = "";
    kbBtn.style.display = apiKey ? "" : "none";
    keyIn.placeholder = apiKey ? "> new key_" : "> key_";
    keyIn.value = "";
  }
  function showSettings() { hideAll3(); settingsEl.style.display = "flex"; }

  // ── Init ────────────────────────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: "GET_KEY" }, r => {
    if (r?.apiKey) { apiKey = r.apiKey; showMain(); } else showSetup();
  });

  // ── Key save ────────────────────────────────────────────────────────────
  ksBtn.addEventListener("click", () => {
    const k = keyIn.value.trim();
    if (!k) { errEl.textContent = "no key"; return; }
    ksBtn.disabled = true; ksBtn.textContent = "...";
    chrome.runtime.sendMessage({ type: "SAVE_KEY", apiKey: k }, () => {
      apiKey = k; ksBtn.disabled = false; ksBtn.textContent = "connect"; showMain();
    });
  });
  keyIn.addEventListener("keydown", e => { if (e.key === "Enter") ksBtn.click(); });
  kbBtn.addEventListener("click", () => { if (apiKey) showMain(); });

  // ── Settings ────────────────────────────────────────────────────────────
  cfgBtn.addEventListener("click", () => {
    if (apiKey) showSettings(); else showSetup();
  });

  doneBtn.addEventListener("click", () => showMain()); // call by name so the screen-mode wrapper below applies
  rekeyBtn.addEventListener("click", showSetup);

  // mode buttons
  root.querySelectorAll("#cx-modes .cx-mode").forEach(btn => {
    btn.addEventListener("click", () => {
      root.querySelectorAll("#cx-modes .cx-mode").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentMode = btn.dataset.mode;
    });
  });

  // ── Theme ───────────────────────────────────────────────────────────────
  let theme = "auto"; // "auto" (follows the page) | "light" | "dark"

  function pageIsDark() {
    for (const el of [document.body, document.documentElement]) {
      const m = el && getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const [r, g, b, a = 1] = m[1].split(",").map(parseFloat);
        if (a > 0.5) return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
      }
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function applyTheme() {
    const dark = theme === "dark" || (theme === "auto" && pageIsDark());
    overlay.classList.toggle("cx-dark", dark);
  }
  function markTheme() {
    root.querySelectorAll("#cx-themes .cx-mode").forEach(b => b.classList.toggle("active", b.dataset.theme === theme));
  }
  root.querySelectorAll("#cx-themes .cx-mode").forEach(btn => {
    btn.addEventListener("click", () => {
      theme = btn.dataset.theme; markTheme(); applyTheme();
      try { chrome.storage.local.set({ cxTheme: theme }); } catch {}
    });
  });
  try {
    chrome.storage.local.get("cxTheme", d => { if (d.cxTheme) theme = d.cxTheme; markTheme(); applyTheme(); });
  } catch {}
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  applyTheme();

  // ── Visibility (synchronized across all tabs) ──────────────────────────
  function setVisible(v) {
    visible = !!v;
    overlay.classList.toggle("cx-hidden", !visible);
    if (!visible) { clearTimeout(idleTimer); idleTimer = null; cancelRequest(); }
  }

  function toggle() {
    chrome.runtime.sendMessage({ type: "TOGGLE_GLOBAL" });
  }

  closeBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SET_GLOBAL_VISIBILITY", visible: false });
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "TOGGLE") toggle();
    if (msg.type === "SET_VISIBILITY") setVisible(msg.visible);
    if (msg.type === "QUERY_FROM_FRAME") {
      if (!visible) return;
      setPreview(msg.preview || msg.text);
      lastText = msg.text;
      ask(msg.enriched);
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.cxVisible !== undefined) {
        setVisible(changes.cxVisible.newValue);
      }
    });
    chrome.storage.local.get("cxVisible", data => {
      // Default to true on initial install, otherwise follow saved state
      const isVis = data.cxVisible !== undefined ? data.cxVisible : true;
      setVisible(isVis);
    });
  } catch {}

  // ── UI helpers ──────────────────────────────────────────────────────────
  function setStatus(m) {
    statusEl.textContent = m; statusEl.style.display = "block";
    ansWrap.style.display = "none"; thinkEl.style.display = "none";
  }

  // footer tag: "" | "act" (clickable) | "warn"
  function setTag(text = "", kind = "") {
    tagEl.textContent = text;
    tagEl.className = kind ? "cx-" + kind : "";
    tagEl.title = kind === "act" ? "ask again, skipping the cache" : "";
  }
  tagEl.addEventListener("click", () => {
    if (tagEl.classList.contains("cx-act") && lastAskText) ask(lastAskText, true);
  });

  clrBtn.addEventListener("click", () => {
    cancelRequest();
    lastText = ""; setPreview(""); answerPlain = ""; setTag();
    setStatus(currentMode === "highlight" ? "highlight text to query" : "reading page...");
  });

  function setPreview(raw) {
    if (!raw || !raw.trim()) {
      selEl.style.display = "none";
      selEl.classList.remove("cx-expanded");
      return;
    }
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    let badge = "";
    const filtered = [];

    for (const line of lines) {
      const qm = line.match(/^Question\s+(\d+)|^Q(\d+)/i);
      if (qm && !badge) {
        badge = `Q${qm[1] || qm[2]}`;
        continue;
      }
      if (/^\d+(?:\.\d+)?\s*(?:pts?|points?)\b/i.test(line)) continue;
      filtered.push(line);
    }

    let clean = filtered.join(" ").replace(/\s+/g, " ").trim();
    if (!clean && lines.length) clean = lines.join(" ").trim();

    selBadge.textContent = badge || "Q";
    selTxt.textContent = clean;
    selEl.title = clean;
    selEl.style.display = "flex";
  }

  selEl.addEventListener("click", () => selEl.classList.toggle("cx-expanded"));

  async function copyText(t) {
    if (!t) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch {}
    return false;
  }
  async function flashCopy(btn, text) {
    if (!text) return;
    await copyText(text);
    const old = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = old; }, 900);
  }
  copyBtn.addEventListener("click", () => flashCopy(copyBtn, answerPlain));

  // ── Context extraction ──────────────────────────────────────────────────
  // Walk up from the selection to find ONLY the enclosing question container.
  // CRITICAL: Never fall back to document.body or ancestors with multiple questions,
  // which previously leaked the whole page and caused the AI to hallucinate.
  function findContainer(node) {
    let el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el || el === document.body || el === document.documentElement) return null;

    // Direct quiz/question containers in Canvas LMS, Moodle, Blackboard, Google Forms, etc.
    const QUESTION_SELECTORS = [
      ".display_question",
      ".question_holder",
      ".quiz_sortable",
      ".take_quiz_question",
      "[data-question-id]",
      "[data-testid*='question']",
      "[id^='question_']",
      ".quiz-item",
      ".quiz-question",
      "fieldset",
      "[role='radiogroup']",
      ".freebirdFormviewerComponentsQuestionBaseRoot"
    ];

    // 1) Check ancestors for a standard question wrapper
    for (const sel of QUESTION_SELECTORS) {
      const q = el.closest(sel);
      if (q && q !== document.body && q !== document.documentElement) {
        const cls = q.className?.toString() || "";
        // Exclude inner partial wrappers
        if (!/\b(question_text|question_prompt|question_name|question_header|prompt_text)\b/i.test(cls)) {
          return q;
        }
      }
    }

    // 2) Upward climb: stop strictly if multiple questions or huge containers are encountered
    let curr = el;
    let best = null;

    for (let i = 0; i < 8 && curr && curr !== document.body && curr !== document.documentElement; i++) {
      const hasControls = curr.querySelectorAll("select, input[type='radio'], input[type='checkbox'], input[type='text'], textarea").length > 0;
      if (hasControls) {
        best = curr;
        const cls = curr.className?.toString() || "";
        if (/\b(question|quiz|item|card|problem|row)\b/i.test(cls) &&
            !/\b(text|prompt|title|header|name|label)\b/i.test(cls)) {
          return curr;
        }
      }

      const parent = curr.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;

      // Stop immediately if parent holds multiple distinct questions or questions indicators
      const qCount = parent.querySelectorAll(".display_question, .question_holder, [data-question-id], [id^='question_'], fieldset").length;
      if (qCount > 1) break;

      const pText = parent.innerText || "";
      const qHeaders = pText.match(/\bQuestion\s+\d+\b/gi);
      if (qHeaders && qHeaders.length > 1) break;

      curr = parent;
      if (hasControls) best = curr;
    }

    return best;
  }

  // Placeholder <option>s that are not real answers
  const PLACEHOLDER = /^(\[?\s*(choose|select|pick)\b.*\]?|[-—–.]+)$/i;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION"]);

  // ── Anti-Obfuscation DOM Unmasker & Serializer ──────────────────────────
  // Reads content faithfully even when pages attempt obfuscation via:
  // - user-select: none, pointer-events: none, contextmenu/copy blocking
  // - font-size: 0px, opacity: 0, offscreen absolute positioning, color: transparent
  // - Open Shadow DOMs and custom web components
  // - Canvas/Image/SVG math & diagrams (aria-label, alt, title)
  // - CSS ::before and ::after pseudo-content injected terms
  // - Scrambled or empty markup that relies on accessible ARIA trees
  function serialize(root) {
    let out = "", ddCount = 0, lastLabel = "";
    const nl = () => { if (out && !out.endsWith("\n")) out += "\n"; };

    function cleanStr(s) {
      return (s || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ");
    }

    function walk(n) {
      if (typeof host !== "undefined" && host && n === host) return;

      // Text Node
      if (n.nodeType === 3) {
        const raw = cleanStr(n.textContent);
        if (raw.trim() && !/^[\s\-_.:·—–]+$/.test(raw.trim())) {
          out += raw;
          lastLabel = raw.trim();
        }
        return;
      }

      if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName)) return;

      const cs = window.getComputedStyle ? getComputedStyle(n) : null;

      // Anti-obfuscation check:
      // Even if display is none or visibility is hidden, inspect whether it holds critical quiz/text data
      // (often hidden by anti-reader scripts, tab-switch detectors, or custom modal disguises).
      const isHidden = cs && (cs.display === "none" || cs.visibility === "hidden");
      const hasAccessibilityLabel = n.getAttribute("aria-label") || n.getAttribute("alt") || n.getAttribute("title");

      // Extract ARIA / accessible description if element is an image/math/svg or has rich aria
      if (hasAccessibilityLabel && (n.tagName === "IMG" || n.tagName === "SVG" || n.tagName === "CANVAS" || isHidden)) {
        const alt = cleanStr(hasAccessibilityLabel).trim();
        if (alt && !/^[\s\-_.:·—–]+$/.test(alt)) {
          nl();
          out += alt + " ";
          lastLabel = alt;
        }
      }

      // Check for CSS generated pseudo-content (often used to render question numbers or terms)
      if (cs) {
        const before = cs.getPropertyValue("content");
        if (before && before !== "none" && before !== "normal") {
          const bText = cleanStr(before.replace(/^['"]|['"]$/g, "")).trim();
          if (bText) out += bText + " ";
        }
      }

      // Don't completely skip hidden containers if they contain actual inputs/selects or forms
      if (isHidden && n.tagName !== "SELECT" && !n.querySelector("select, input, textarea")) {
        // If it's a hidden span/div with meaningful text used to bypass display, read textContent if not script/style
        const hiddenTxt = cleanStr(n.textContent).trim();
        if (hiddenTxt.length > 2 && (n.className?.includes("math") || n.className?.includes("katex") || n.className?.includes("sr-only") || n.className?.includes("visually-hidden"))) {
          nl();
          out += hiddenTxt + " ";
        }
        return;
      }

      const block = cs ? !cs.display.startsWith("inline") : true;
      if (block) nl();

      if (n.tagName === "SELECT") {
        let itemLabel = n.getAttribute("aria-label")?.trim() || n.title?.trim() || n.labels?.[0]?.textContent?.trim();
        if (!itemLabel) {
          const row = n.closest(".row, tr, [class*='row'], [class*='match'], [class*='item'], div");
          const left = row?.querySelector("[class*='left'], [class*='term'], [class*='label'], [class*='stem'], [class*='header']");
          if (left && left !== n) {
            const lt = cleanStr(left.textContent).trim();
            if (lt && !/^[\s\-_.:·—–]+$/.test(lt)) itemLabel = lt;
          }
        }
        if (!itemLabel || /^[\s\-_.:·—–]+$/.test(itemLabel)) {
          itemLabel = lastLabel;
        }

        const seen = new Set();
        const opts = Array.from(n.options)
          .map(o => cleanStr(o.textContent).trim())
          .filter(t => t && !PLACEHOLDER.test(t) && !seen.has(t) && seen.add(t));
        if (opts.length) {
          const cur = cleanStr(n.options[n.selectedIndex]?.textContent).trim();
          nl();
          out += `[Dropdown #${++ddCount}${itemLabel ? ` for item "${itemLabel}"` : ""} — choose exactly one of:\n` +
            opts.map((o, i) => `  ${i + 1}. ${o}`).join("\n") +
            (cur && !PLACEHOLDER.test(cur) ? `\n  (currently selected: ${cur})` : "") + "\n]\n";
        }
        lastLabel = "";
        return;
      }

      if (n.tagName === "INPUT") {
        const type = (n.type || "text").toLowerCase();
        if (type === "radio") out += n.checked ? "(x) " : "( ) ";
        else if (type === "checkbox") out += n.checked ? "[x] " : "[ ] ";
        else if (type === "text" || type === "number") out += "[Blank input] ";
        return;
      }
      if (n.tagName === "TEXTAREA") {
        out += "[Blank input] ";
        return;
      }
      if (n.tagName === "BR") { nl(); return; }

      // Traverse shadow roots if present (e.g. customized quiz components / Web Components)
      if (n.shadowRoot) {
        Array.from(n.shadowRoot.childNodes).forEach(walk);
      }

      Array.from(n.childNodes).forEach(walk);

      if (cs) {
        const after = cs.getPropertyValue("content");
        if (after && after !== "none" && after !== "normal") {
          const aText = cleanStr(after.replace(/^['"]|['"]$/g, "")).trim();
          if (aText) out += " " + aText;
        }
      }

      if (block) nl();
    }

    walk(root);
    return out.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim().slice(0, MAX_CHARS);
  }

  function extractContext(container) {
    return container ? serialize(container) : "";
  }

  // ── Selection watcher (highlight mode) ─────────────────────────────────
  document.addEventListener("selectionchange", () => {
    if (!visible || currentMode !== "highlight") return;
    const sel = window.getSelection();
    const raw = sel?.toString().trim() ?? "";
    if (host.contains(sel?.anchorNode)) return; // selections inside the shadow root retarget to the host

    setPreview(raw);

    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const s = window.getSelection();
      const t = s?.toString().trim();
      if (!t || t.length < MIN_CHARS || t === lastText) return;
      if (host.contains(s?.anchorNode)) return;

      // Extract enriched context from the question container if present
      const container = findContainer(s.anchorNode);
      const context = extractContext(container);
      
      // If we found a valid focused container with controls/options, provide both selection & context
      let promptContent = t;
      if (context && context.length > t.length && context.includes(t)) {
        promptContent = `FOCUSED SELECTION: "${t}"\n\nLOCAL QUESTION CONTEXT & OPTIONS:\n${context}`;
      }

      lastText = t;
      ask(promptContent);
    }, IDLE_MS);
  });

  // ── Screen mode: extract questions from page ───────────────────────────
  // First tries DOM unmasking. If the page is heavily canvas/image/svg based,
  // or text content is blank/scrambled, it automatically falls back to visual OCR.
  async function scanPage() {
    const text = serialize(document.body);
    const preview = text.replace(/\s+/g, " ");
    
    // Check if the DOM appears stripped or obfuscated (e.g. Canvas/SVG heavy or < 25 chars)
    const hasCanvasOrSvg = document.querySelectorAll("canvas, svg").length > 0;
    const looksObfuscated = text.length < 25 || (hasCanvasOrSvg && text.length < 100);

    if (looksObfuscated) {
      setStatus("visual scan in progress...");
      chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN" }, res => {
        if (res?.ok && res.base64) {
          const imgPrompt = text.length > 5 
            ? `NOTE: The page has HTML content but may be visual or obfuscated:\n${text}`
            : "The page content is visually rendered (canvas, SVG, or image). Read the visible question(s) and answers in the image.";
          setPreview("Visual Screen Scan");
          lastText = text || "visual_scan";
          ask(imgPrompt, false, { base64: res.base64, mimeType: res.mimeType });
        } else {
          // Fall back to standard DOM text if capture is unavailable
          setPreview(preview || "Screen Scan");
          lastText = text;
          ask(text);
        }
      });
      return;
    }

    setPreview(preview);
    lastText = text;
    ask(text);
  }

  const origShowMain = showMain;
  showMain = function() {
    origShowMain();
    if (currentMode === "screen") {
      setStatus("scanning page...");
      setTimeout(scanPage, 300);
    } else {
      setStatus("highlight text to query");
    }
  };

  // ── Question types & prompts ────────────────────────────────────────────
  const VERBATIM = "Copy each option VERBATIM, character for character, from the options list — never paraphrase, shorten or reword it.";
  const COMMON = "Be as concise as possible. No preamble, no explanation, no prefixes. Output ONLY the direct answer. Never repeat or echo the question or input labels. If you are not confident in an answer, append \" [?]\" to that line.";
  const TASKS = {
    matching: `This is a MATCHING question. The dropdowns are numbered (#1, #2, ...) and each has its own numbered options. For EACH dropdown output exactly one line, in order, formatted exactly as: <dropdown #> → <option #>. <option text>   (example: "2 → 4. Water"). The option # MUST be the number from that dropdown's list, and the option text must be copied VERBATIM. Each option is normally used only once.`,
    dropdown: `This is a dropdown question. Output exactly one line formatted as: <dropdown #> → <option #>. <option text>   (example: "1 → 3. Water"). The option # MUST be the number from the list, and the option text must be copied VERBATIM.`,
    choice:   `This is a single-answer multiple-choice question (options marked ( )). Output ONLY the text of the one correct option — no letter, no number. ${VERBATIM}`,
    multi:    `This is a select-all-that-apply question (options marked [ ]). Output every correct option, one per line. ${VERBATIM}`,
    truefalse:`This is a true/false question. Output ONLY "True" or "False".`,
    fill:     `This is an IDENTIFICATION / short-answer / fill-in-the-blank question. Output ONLY the exact answer (the specific term, name, number, formula, or short phrase) that should be typed into the answer box. Do NOT include any label or prefix like "Answer:", "Input:", "Result:", or brackets. Do NOT repeat the question. If there are several distinct blanks, output each answer on its own line numbered "1. ", "2. ", ...`,
    general:  `Answer directly. For a term or concept, explain it in 1-2 sentences. If there are several questions, answer each on its own line.`,
    page:     `This is a whole page. Find every question on it and answer each on its own line, prefixed by its number. For each dropdown output one line formatted exactly as: <dropdown #> → <option #>. <option text>   (the option # from that dropdown's list, text copied VERBATIM). For multiple choice output the option text. ${VERBATIM}`
  };

  function detectType(text) {
    if (currentMode === "screen") return "page";
    const dd = (text.match(/\[Dropdown #/g) || []).length;
    if (dd >= 2) return "matching";
    if (dd === 1) return "dropdown";
    const radios = (text.match(/^\s*\([x ]\)/gm) || []).length;
    const boxes  = (text.match(/^\s*\[[x ]\]/gm) || []).length;
    const tf = /\btrue\b/i.test(text) && /\bfalse\b/i.test(text);
    if (radios === 2 && tf) return "truefalse";
    if (radios) return "choice";
    if (boxes) return "multi";
    if (/\btrue\s*(or|\/)\s*false\b/i.test(text)) return "truefalse";
    if (/\[Blank input\]|_{3,}|fill in the blank|identification|short answer/i.test(text)) return "fill";
    return "general";
  }

  function buildPrompt(text) {
    return `TASK: ${TASKS[detectType(text)]}\n${COMMON}\n\nCONTENT:\n${text}`;
  }

  // ── Answer cache (persists across pages/sessions) ───────────────────────
  const CACHE_KEY = "cxCache", CACHE_MAX = 150;

  function hash(s) { // cyrb53: 53-bit string hash
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function cacheGet(key) {
    return new Promise(resolve => {
      try { chrome.storage.local.get(CACHE_KEY, d => resolve(d?.[CACHE_KEY]?.[key]?.a ?? null)); }
      catch { resolve(null); }
    });
  }
  function cacheSet(key, answer) {
    try {
      chrome.storage.local.get(CACHE_KEY, d => {
        const c = d?.[CACHE_KEY] || {};
        c[key] = { a: answer, t: Date.now() };
        const keys = Object.keys(c);
        if (keys.length > CACHE_MAX) {
          keys.sort((x, y) => c[x].t - c[y].t).slice(0, keys.length - CACHE_MAX).forEach(k => delete c[k]);
        }
        chrome.storage.local.set({ [CACHE_KEY]: c });
      });
    } catch {}
  }

  // ── Answer rendering ────────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const badge = () => {
    const b = el("span", "cx-badge", "?");
    b.title = "The model is not confident — double-check this one";
    return b;
  };

  // ── Option parsing & snapping ────────────────────────────────────────────────
  // The page's own option strings are the source of truth. We read them back out of
  // the serialized content so that whatever is displayed/copied is EXACTLY what the
  // page offers, no matter how the model worded its answer.
  function parseOptions(text) {
    const dropdowns = [];
    const re = /\[Dropdown #(\d+)(?: for item "(.*?)")? — choose exactly one of:\n((?:  \d+\. [^\n]*\n?)+)/g;
    let m;
    while ((m = re.exec(text))) {
      dropdowns.push({
        n: +m[1],
        label: m[2] || "",
        options: m[3].split("\n").map(l => (l.match(/^  \d+\. (.*)$/) || [])[1]?.replace(/\]+$/, "").trim()).filter(Boolean)
      });
    }

    const choices = [];
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      const c = l.match(/^\s*[(\[][x ][)\]]\s*(.*)$/);
      if (!c) return;
      const t = c[1].trim() || (lines[i + 1] || "").trim(); // label may sit on the next line
      if (t) choices.push(t);
    });

    return { dropdowns, choices, all: [...dropdowns.flatMap(d => d.options), ...choices] };
  }

  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  function dice(a, b) { // bigram similarity, 0..1
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = s => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
    const A = grams(a), B = grams(b);
    let inter = 0;
    for (const [k, c] of A) inter += Math.min(c, B.get(k) || 0);
    return (2 * inter) / (a.length + b.length - 2);
  }
  // Replace the model's wording with the closest real option (if it is close enough).
  function snap(answer, options) {
    if (!options?.length) return answer;
    const n = norm(answer);
    let best = null, bestScore = 0;
    for (const o of options) {
      const s = dice(n, norm(o));
      if (s > bestScore) { bestScore = s; best = o; }
    }
    return bestScore >= 0.55 ? best : answer;
  }

  // Renders streamed text. Rows are built from the page's own options (see above);
  // a trailing "[?]" becomes a low-confidence badge. Returns true if any line was unsure.
  function renderAnswer(raw, meta = { dropdowns: [], choices: [], all: [] }) {
    const frag = document.createDocumentFragment();
    const plain = [];
    let anyUnsure = false, rowIdx = 0;

    for (let line of raw.split("\n")) {
      let unsure = false;
      line = line.trim()
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\s*\[\?\]\s*$/, () => { unsure = true; return ""; })
        .replace(/\s*\[\??$/, "")
        .replace(/^\[?(?:input|answer|result|blank|identification)\s*[:=-]?\s*/i, "")
        .replace(/\]+$/, "")
        .trim();
      if (!line) continue;
      if (/^#?\d+\s*(?:→|->)\s*#?$/.test(line)) continue; // half-streamed "2 →"
      if (unsure) anyUnsure = true;

      let item = "", pickText = null;

      // 1) "<dropdown #> → <option #>" or "<dropdown #>: <option #>" (only if dropdowns exist)
      if (meta.dropdowns.length > 0) {
        const nm = line.match(/^#?(\d+)\s*(?:→|->|:)\s*#?(\d+)\b/);
        if (nm) {
          const dd = meta.dropdowns.find(d => d.n === +nm[1]);
          const opt = dd?.options[+nm[2] - 1];
          if (dd && opt) { item = dd.label || `Dropdown ${dd.n}`; pickText = opt; }
        }
      }
      // 2) "<item> → <text>" or (if dropdowns exist) "<item>: <text>" → snap text to the dropdown's real options
      if (pickText == null) {
        const m = meta.dropdowns.length > 0
          ? line.match(/^(.*?)\s*(?:→|->|:)\s*(.+)$/)
          : line.match(/^(.*?)\s*(?:→|->)\s*(.+)$/);
        if (m) {
          const rawItem = m[1].replace(/^#?\d+[\s.)-]*/, "").trim();
          if (!/^\[?(input|answer|question|q\d*)\b/i.test(rawItem)) {
            item = rawItem;
            const dd = meta.dropdowns.find(d => d.label && norm(d.label) === norm(item)) || meta.dropdowns[rowIdx];
            pickText = snap(m[2], dd?.options || meta.all);
          }
        }
      }

      if (pickText != null) {
        rowIdx++;
        plain.push(item ? `${item} → ${pickText}` : pickText);
        const row = el("div", "cx-row"), rc = el("div", "cx-rc");
        if (item) rc.append(el("div", "cx-item", item));
        const pick = el("div", "cx-pick", pickText);
        if (unsure) pick.append(badge());
        rc.append(pick);
        const cp = el("button", "cx-cp", "copy");
        cp.addEventListener("click", () => flashCopy(cp, pickText));
        row.append(rc, cp);
        frag.append(row);
      } else {
        // 3) plain answer (identification, short answer, multiple choice, etc.)
        const shown = snap(line, meta.choices);
        plain.push(shown);
        const row = el("div", "cx-row"), rc = el("div", "cx-rc");
        const pick = el("div", shown.length > 120 ? "cx-line" : "cx-pick", shown);
        if (unsure) pick.append(badge());
        rc.append(pick);
        const cp = el("button", "cx-cp", "copy");
        cp.addEventListener("click", () => flashCopy(cp, shown));
        row.append(rc, cp);
        frag.append(row);
      }
    }
    answerPlain = plain.join("\n");
    ansEl.replaceChildren(frag);
    return anyUnsure;
  }

  function showAnswerPane() {
    statusEl.style.display = "none";
    thinkEl.style.display = "none";
    ansWrap.style.display = "flex";
  }

  // ── Request handling ────────────────────────────────────────────────────
  // Disconnecting the port makes the background abort the in-flight request.
  function cancelRequest() {
    reqId++;
    if (port) { try { port.disconnect(); } catch {} port = null; }
  }

  function errText(m) {
    if (m.status === 429) return "rate limited — wait a moment, then highlight again";
    if (m.status >= 500) return "Gemini is having issues — try again shortly";
    if (/timed out/i.test(m.message)) return "request timed out — highlight again";
    if (/failed to fetch|networkerror|load failed/i.test(m.message)) return "offline — check your connection";
    return m.message;
  }

  // ── Ask Gemini ──────────────────────────────────────────────────────────
  async function ask(text, fresh = false, image = null) {
    if (!apiKey) { showSetup(); return; }
    cancelRequest();
    const id = reqId;
    lastAskText = text;
    applyTheme();

    statusEl.style.display = "none";
    ansWrap.style.display = "none";
    thinkEl.style.display = "flex";
    setTag();

    const prompt = buildPrompt(text);
    const ckey = hash(prompt + (image?.base64 ? "_img" : ""));
    const meta = parseOptions(text);

    if (!fresh) {
      const hit = await cacheGet(ckey);
      if (id !== reqId) return; // superseded while reading the cache
      if (hit) {
        showAnswerPane();
        renderAnswer(hit, meta);
        setTag("cached ↻", "act");
        return;
      }
    }

    let acc = "", finished = false, reconnects = 0;

    function connect() {
      let p;
      try {
        p = chrome.runtime.connect({ name: "gemini-stream" });
      } catch {
        setStatus("err: extension was updated — refresh this page");
        return;
      }
      port = p;

      p.onMessage.addListener(m => {
        if (id !== reqId) return; // stale reply from a cancelled request

        if (m.type === "model") {
          if (m.backup) setTag("answered by " + m.label); // primary was busy/slow
        } else if (m.type === "status") {
          setStatus(m.message);
          thinkEl.style.display = "flex";
        } else if (m.type === "chunk") {
          acc += m.text;
          showAnswerPane();
          renderAnswer(acc, meta);
        } else if (m.type === "done") {
          finished = true;
          showAnswerPane();
          const unsure = renderAnswer(m.text, meta);
          if (unsure) setTag("? = low confidence — double-check", "warn");
          else cacheSet(ckey, m.text); // only cache answers the model was sure about
          p.disconnect(); port = null;
        } else if (m.type === "error") {
          finished = true;
          p.disconnect(); port = null;
          if (m.status === 401 || m.status === 403 || /API[ _]key/i.test(m.message || "")) {
            showSetup(); errEl.textContent = "bad key";
          } else if (acc) {
            setTag("⚠ interrupted: " + errText(m), "warn"); // keep the partial answer visible
          } else {
            setStatus("err: " + errText(m));
          }
        }
      });

      p.onDisconnect.addListener(() => {
        if (id !== reqId || finished) return;
        port = null;
        // The background worker can be restarted by the browser; if nothing has
        // streamed yet, quietly start over instead of showing an error.
        if (!acc && reconnects++ < 2) { connect(); return; }
        if (acc) setTag("⚠ interrupted — highlight again", "warn");
        else setStatus("err: connection lost — highlight again");
      });

      p.postMessage({ type: "ASK", text: prompt, apiKey, image });
    }

    connect();
  }

  // ── Drag ─────────────────────────────────────────────────────────────────
  header.addEventListener("mousedown", e => {
    if (e.target.closest("button")) return;
    dragging = true;
    const r = overlay.getBoundingClientRect();
    dragOX = e.clientX - r.left; dragOY = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", e => {
    if (dragging) {
      overlay.style.left = e.clientX - dragOX + "px";
      overlay.style.top = e.clientY - dragOY + "px";
      overlay.style.right = "auto"; overlay.style.bottom = "auto";
    }
    if (resizing) {
      overlay.style.width = Math.max(240, resStartW + (e.clientX - resStartX)) + "px";
      overlay.style.height = Math.max(160, resStartH + (e.clientY - resStartY)) + "px";
      overlay.style.maxHeight = "none";
    }
  });
  document.addEventListener("mouseup", () => { dragging = false; resizing = false; });
  rzHandle.addEventListener("mousedown", e => {
    resizing = true;
    resStartX = e.clientX; resStartY = e.clientY;
    resStartW = overlay.offsetWidth; resStartH = overlay.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  });
  // ── Event & Focus Isolation ──────────────────────────────────────────────
  // 1) Prevent focus theft: e.preventDefault() on mousedown ensures the browser never shifts
  //    document.activeElement away from the host page (e.g. active form fields or text inputs).
  // 2) Prevent mouse, pointer, clipboard, and keyboard events from bubbling past the shadow boundary to host listeners.
  const POINTER_EVENTS = [
    "mousedown", "mouseup", "click", "dblclick", "auxclick",
    "pointerdown", "pointerup", "pointercancel", "contextmenu"
  ];

  POINTER_EVENTS.forEach(type => {
    overlay.addEventListener(type, e => {
      if (type === "mousedown") {
        // Allow text cursor focus only on actual text input elements inside the overlay (e.g. API key)
        const tag = e.target?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "A") {
          e.preventDefault();
        }
      }
      if (type === "mouseup") {
        dragging = false;
        resizing = false;
      }
      e.stopPropagation();
    });

    // Ensure events never escape the shadow host element in the page DOM
    host.addEventListener(type, e => e.stopPropagation());
  });

  // Keep typing or editing in the overlay from triggering the host page's keyboard shortcuts or listeners
  ["keydown", "keyup", "keypress", "copy", "cut", "paste"].forEach(type => {
    overlay.addEventListener(type, e => e.stopPropagation());
    host.addEventListener(type, e => e.stopPropagation());
  });
})();
