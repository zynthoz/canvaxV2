(() => {
  // ── Completely Passive, Undetectable Accessibility & Selection Handler ─────
  // Zero main-world script injection. No prototype monkey-patching.
  // Proctors probe DOM modifications and prototype tampering.
  // We use adoptedStyleSheets when supported or un-fingerprinted style tags.
  const RESTORE_CSS = `
    body, p, span, div, h1, h2, h3, h4, h5, h6, li, td, th, label, blockquote, q, article, section {
      -webkit-user-select: text !important;
      user-select: text !important;
    }
  `;

  function ensureSelectionAllowed() {
    try {
      if (document.adoptedStyleSheets) {
        // Constructable stylesheet: does not add any <style> node to the DOM tree
        const isAlreadyAdded = Array.from(document.adoptedStyleSheets).some(s => s._cxRestore);
        if (!isAlreadyAdded) {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(RESTORE_CSS);
          sheet._cxRestore = true;
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          return;
        }
      }
    } catch {}

    try {
      if (!document.querySelector("style[data-user-select-restore]")) {
        const style = document.createElement("style");
        style.setAttribute("data-user-select-restore", "true");
        style.textContent = RESTORE_CSS;
        (document.head || document.documentElement).appendChild(style);
      }
    } catch {}
  }

  ensureSelectionAllowed();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureSelectionAllowed, { once: true });
  }

  const isTopFrame = window.self === window.top;
  const IDLE_MS = 1500, MIN_CHARS = 3, MAX_CHARS = 8000;
  const MAX_CONTAINER_CHARS = 4000; // a "question block" larger than this is almost certainly page chrome

  // Shared by the child-frame handler AND the top frame — must be initialized before the
  // child-frame early `return` below (const/let are not hoisted like function declarations).
  // Placeholder <option>s that are not real answers
  const PLACEHOLDER = /^(\[?\s*(choose|select|pick)\b.*\]?|[-—–.]+)$/i;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION"]);

  // Is this a control a student would actually answer with? Ordinary web pages are full of
  // inputs that are NOT answers (search boxes, hidden CSRF tokens, login/newsletter forms,
  // sort/filter dropdowns). Counting those made any page look like a quiz and leaked
  // unrelated page text (e.g. star counts) into the prompt.
  const ANSWER_INPUT_TYPES = new Set(["radio", "checkbox", "text", "number"]);
  const NON_ANSWER_REGION = "nav, header, footer, [role='search'], [role='navigation'], [role='banner'], [role='menu'], form[action*='login'], form[action*='search'], [aria-hidden='true']";
  const NON_ANSWER_TEXT_HINT = /search|filter|find|query|login|log-in|signin|sign-in|password|e-?mail|user(name)?|subscribe|newsletter|coupon|promo|csrf|token|captcha/i;
  const NON_ANSWER_SELECT_HINT = /sort|order.?by|per.?page|page.?size|locale|currency|country|jump|nav/i;
  const NON_ANSWER_CHECK_HINT = /remember|agree|terms|newsletter|subscribe|consent|cookie/i;

  function isAnswerControl(el) {
    if (!el || el.disabled) return false;
    const tag = el.tagName;
    let kind;
    if (tag === "SELECT") kind = "select";
    else if (tag === "TEXTAREA") kind = "text";
    else if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (!ANSWER_INPUT_TYPES.has(t)) return false; // hidden, search, submit, password, email…
      kind = (t === "radio" || t === "checkbox") ? "check" : "text";
    } else return false;

    if (el.closest(NON_ANSWER_REGION)) return false;
    const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("autocomplete") || ""}`;
    if (kind === "text" && NON_ANSWER_TEXT_HINT.test(hint)) return false;
    if (kind === "select" && NON_ANSWER_SELECT_HINT.test(hint)) return false;
    if (kind === "check" && NON_ANSWER_CHECK_HINT.test(hint)) return false;
    return true;
  }

  function countAnswerControls(root) {
    if (!root?.querySelectorAll) return 0;
    let n = 0;
    for (const c of root.querySelectorAll("select, input, textarea")) if (isAnswerControl(c)) n++;
    return n;
  }

  const textLen = el => (el?.innerText || el?.textContent || "").length;

  // Builds what gets sent to the model for a highlight. Page context is attached ONLY when the
  // selection sits inside a real question block (actual answer controls or listed options);
  // otherwise the bare selection is sent so unrelated page text can't leak into the answer.
  function buildSelectionPayload(raw, anchorNode) {
    const container = findContainer(anchorNode);
    const context = extractContext(container);
    if (hasRealOptionsOrControls(container, context) && context.length > raw.length) {
      return `HIGHLIGHTED:\n${raw}\n\nQUESTION BLOCK (the highlighted question with its answer options):\n${context}`;
    }
    return raw;
  }

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

        let promptContent = raw;
        try { promptContent = buildSelectionPayload(raw, sel.anchorNode); } catch {}

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
  let currentProvider = "auto", currentModel = "auto";
  let currentMode = "highlight"; // "highlight" | "screen"
  let dragging = false, dragOX = 0, dragOY = 0;
  let resizing = false, resStartX, resStartY, resStartW, resStartH;
  let port = null, reqId = 0;        // active streaming port / request counter (stale-reply guard)
  let lastAskText = "", answerPlain = "";
  let savedBriefAnswer = null;       // { text, meta, preview, badge, plain }
  let savedExpoundAnswer = null;     // { text, preview, plain }
  let currentView = "brief";         // "brief" | "expound" | "manual"
  let contextDetached = false;       // true if user detached page context for direct search

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
      <div id="cx-setup-t">Connect AI Provider</div>
      <div id="cx-setup-d">Paste your API key. Provider is auto-detected, or choose one manually below.</div>
      <div class="cx-set-row" style="margin-bottom:2px">
        <span class="cx-set-label">Provider</span>
        <select id="cx-setup-prov" class="cx-select">
          <option value="auto">Auto-detect from key</option>
          <option value="gemini">Google Gemini</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic Claude</option>
          <option value="groq">Groq (Ultra-fast)</option>
        </select>
      </div>
      <input id="cx-ki" type="password" placeholder="AIzaSy... / sk-... / gsk_..." autocomplete="off" spellcheck="false" />
      <div id="cx-setup-btns">
        <button id="cx-kb" style="display:none">Back</button>
        <button id="cx-ks">Connect</button>
      </div>
      <div id="cx-err"></div>
    </div>

    <!-- Settings panel -->
    <div id="cx-settings" style="display:none">
      <div class="cx-set-row">
        <span class="cx-set-label">Provider</span>
        <select id="cx-prov-sel" class="cx-select">
          <option value="auto">Auto (from key)</option>
          <option value="gemini">Google Gemini</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic Claude</option>
          <option value="groq">Groq (Ultra-fast)</option>
        </select>
      </div>
      <div class="cx-set-row">
        <span class="cx-set-label">Model</span>
        <select id="cx-model-sel" class="cx-select">
          <option value="auto">Auto (fast failover)</option>
        </select>
      </div>
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
      <div id="cx-status">Highlight text or ask below</div>
      <div id="cx-sel" style="display:none" title="Click to expand"><span id="cx-sel-badge">Q</span><span id="cx-sel-txt"></span></div>
      <div id="cx-think" style="display:none"><div class="cx-d"></div><div class="cx-d"></div><div class="cx-d"></div></div>
      <div id="cx-ans-wrap" style="display:none"><div id="cx-ans"></div></div>
      <div id="cx-ctx-chip" style="display:none">
        <span id="cx-ctx-txt">Linked to current Q</span>
        <button id="cx-ctx-del" title="Detach context — ask or search directly">×</button>
      </div>
      <div id="cx-prompt-wrap">
        <input id="cx-prompt-in" type="text" placeholder="Ask or follow up... (Enter)" autocomplete="off" spellcheck="false" />
        <button id="cx-prompt-send" title="Send (Enter)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
      </div>
      <div id="cx-foot">
        <button id="cx-tag"></button>
        <div class="cx-foot-actions">
          <button id="cx-expound" title="Expound on this answer" style="display:none">Expound</button>
          <button id="cx-copy">Copy</button>
          <button id="cx-clr">Clear</button>
        </div>
      </div>
    </div>
    <div id="cx-rz"></div>`;
  root.appendChild(overlay);

  function attachHost() {
    if (host.isConnected) return;
    const target = document.documentElement || document.body;
    if (target) {
      target.appendChild(host);
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        (document.documentElement || document.body)?.appendChild(host);
      }, { once: true });
    }
  }
  attachHost();

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
  const promptWrap= $("cx-prompt-wrap");
  const promptIn  = $("cx-prompt-in");
  const promptSend= $("cx-prompt-send");
  const expoundBtn= $("cx-expound");
  const ctxChip   = $("cx-ctx-chip");
  const ctxTxt    = $("cx-ctx-txt");
  const ctxDel    = $("cx-ctx-del");
  const setupProv = $("cx-setup-prov");
  const provSel   = $("cx-prov-sel");
  const modelSel  = $("cx-model-sel");

  const PROVIDER_MODEL_CHOICES = {
    gemini: [
      { id: "auto", label: "Auto (Fast Failover & Hedging)" },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" }
    ],
    openai: [
      { id: "gpt-4o-mini", label: "GPT-4o Mini (Default)" },
      { id: "gpt-4o", label: "GPT-4o (High Accuracy)" },
      { id: "chatgpt-4o-latest", label: "ChatGPT-4o Latest" }
    ],
    anthropic: [
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku (Default)" },
      { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet (High Accuracy)" }
    ],
    groq: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Default)" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (Instant)" }
    ]
  };

  function updateModelDropdown(prov, selected) {
    if (!modelSel) return;
    const effectiveProv = (prov && prov !== "auto") ? prov : detectKeyProvider(keyIn.value || apiKey || "");
    const list = PROVIDER_MODEL_CHOICES[effectiveProv] || PROVIDER_MODEL_CHOICES.gemini;
    modelSel.innerHTML = "";
    list.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === selected) opt.selected = true;
      modelSel.appendChild(opt);
    });
  }

  function detectKeyProvider(k) {
    const s = (k || "").trim();
    if (s.startsWith("gsk_")) return "groq";
    if (s.startsWith("sk-ant-")) return "anthropic";
    if (s.startsWith("sk-proj-") || (s.startsWith("sk-") && !s.startsWith("sk-ant-"))) return "openai";
    return "gemini";
  }

  function updateSetupPlaceholders() {
    const prov = setupProv?.value || "auto";
    const det = prov === "auto" ? detectKeyProvider(keyIn.value || apiKey || "") : prov;
    if (det === "openai") keyIn.placeholder = "sk-proj-... / sk-...";
    else if (det === "anthropic") keyIn.placeholder = "sk-ant-...";
    else if (det === "groq") keyIn.placeholder = "gsk_...";
    else keyIn.placeholder = "AIzaSy...";
  }

  setupProv?.addEventListener("change", () => {
    updateSetupPlaceholders();
    if (provSel) provSel.value = setupProv.value;
    updateModelDropdown(setupProv.value, currentModel);
  });

  provSel?.addEventListener("change", () => {
    currentProvider = provSel.value;
    if (setupProv) setupProv.value = currentProvider;
    updateModelDropdown(currentProvider, currentModel);
    try { chrome.storage.local.set({ cxProvider: currentProvider, cxModel: modelSel?.value || "auto" }); } catch {}
    try {
      chrome.runtime.sendMessage({
        type: "SET_CONFIG",
        provider: currentProvider,
        model: modelSel?.value || "auto"
      });
    } catch {}
  });

  modelSel?.addEventListener("change", () => {
    currentModel = modelSel.value;
    try { chrome.storage.local.set({ cxProvider: provSel?.value || "auto", cxModel: currentModel }); } catch {}
    try {
      chrome.runtime.sendMessage({
        type: "SET_CONFIG",
        provider: provSel?.value || "auto",
        model: currentModel
      });
    } catch {}
  });

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
    keyIn.value = "";
    if (setupProv) setupProv.value = currentProvider;
    updateSetupPlaceholders();
  }
  function showSettings() {
    hideAll3(); settingsEl.style.display = "flex";
    if (provSel) provSel.value = currentProvider;
    updateModelDropdown(currentProvider, currentModel);
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function applyLoadedKey(key, prov, model) {
    if (key) {
      apiKey = key;
      currentProvider = prov || "auto";
      currentModel = model || "auto";
      if (provSel) provSel.value = currentProvider;
      if (setupProv) setupProv.value = currentProvider;
      updateModelDropdown(currentProvider, currentModel);
      showMain();
      return true;
    }
    return false;
  }

  // 1) First check local storage directly
  try {
    chrome.storage.local.get(["geminiKey", "cxProvider", "cxModel"], data => {
      if (chrome.runtime.lastError) {}
      if (!applyLoadedKey(data?.geminiKey, data?.cxProvider, data?.cxModel)) {
        // Fallback to GET_KEY message (handles HARDCODED_KEY if set in background)
        try {
          chrome.runtime.sendMessage({ type: "GET_KEY" }, r => {
            if (chrome.runtime.lastError) {}
            if (!applyLoadedKey(r?.apiKey, r?.savedProvider, r?.model)) {
              showSetup();
            }
          });
        } catch {
          showSetup();
        }
      }
    });
  } catch {
    showSetup();
  }

  // ── Key save ────────────────────────────────────────────────────────────
  function saveAndConnect() {
    const k = keyIn.value.trim();
    if (!k) { errEl.textContent = "no key"; return; }
    errEl.textContent = "";
    ksBtn.disabled = true;
    ksBtn.textContent = "...";
    const selectedProv = setupProv?.value || "auto";
    const selectedModel = currentModel || "auto";

    let completed = false;
    function finalizeSuccess() {
      if (completed) return;
      completed = true;
      apiKey = k;
      currentProvider = selectedProv;
      currentModel = selectedModel;
      ksBtn.disabled = false;
      ksBtn.textContent = "Connect";
      if (provSel) provSel.value = currentProvider;
      updateModelDropdown(currentProvider, currentModel);
      showMain();
    }

    function finalizeError(msg) {
      if (completed) return;
      completed = true;
      ksBtn.disabled = false;
      ksBtn.textContent = "Connect";
      errEl.textContent = msg || "failed to save key";
    }

    // Safety timeout: button is NEVER permanently stuck
    const guardTimer = setTimeout(() => {
      if (!completed) finalizeSuccess();
    }, 1500);

    const payload = {
      geminiKey: k,
      cxProvider: selectedProv,
      cxModel: selectedModel
    };

    // 1) Direct storage save (guaranteed & immediate)
    try {
      chrome.storage.local.set(payload, () => {
        clearTimeout(guardTimer);
        if (chrome.runtime.lastError) {
          finalizeError(chrome.runtime.lastError.message);
        } else {
          finalizeSuccess();
        }
      });
    } catch (e) {
      // Fallback
    }

    // 2) Message background service worker
    try {
      chrome.runtime.sendMessage({
        type: "SAVE_KEY",
        apiKey: k,
        provider: selectedProv,
        model: selectedModel
      }, r => {
        clearTimeout(guardTimer);
        if (chrome.runtime.lastError) {}
        if (r?.ok || r) {
          finalizeSuccess();
        }
      });
    } catch {}
  }

  ksBtn.addEventListener("click", saveAndConnect);
  keyIn.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveAndConnect();
    }
  });
  keyIn.addEventListener("input", () => {
    if (setupProv && setupProv.value === "auto") {
      updateSetupPlaceholders();
    }
  });
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
    const next = !visible;
    setVisible(next);
    try { chrome.storage.local.set({ cxVisible: next }); } catch {}
    try { chrome.runtime.sendMessage({ type: "TOGGLE_GLOBAL" }); } catch {}
  }

  closeBtn.addEventListener("click", () => {
    setVisible(false);
    try { chrome.storage.local.set({ cxVisible: false }); } catch {}
    try { chrome.runtime.sendMessage({ type: "SET_GLOBAL_VISIBILITY", visible: false }); } catch {}
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
    tagEl.title = kind === "act" ? "Click to toggle or refresh" : "";
  }
  tagEl.addEventListener("click", () => {
    if (tagEl.classList.contains("cx-act")) {
      if (tagEl.textContent.includes("brief answer") && savedBriefAnswer) {
        expoundBtn.click();
      } else if (tagEl.textContent.includes("explanation") && savedExpoundAnswer) {
        expoundBtn.click();
      } else if (lastAskText) {
        ask(lastAskText, true, null, currentView === "expound" ? "expound" : (currentView === "manual" ? "manual" : "quiz"));
      }
    }
  });

  clrBtn.addEventListener("click", () => {
    cancelRequest();
    lastText = ""; lastAskText = ""; answerPlain = "";
    savedBriefAnswer = null; savedExpoundAnswer = null; currentView = "brief";
    contextDetached = false;
    if (ctxChip) ctxChip.style.display = "none";
    if (promptIn) {
      promptIn.value = "";
      promptIn.placeholder = "Ask or follow up... (Enter)";
    }
    if (expoundBtn) {
      expoundBtn.style.display = "none";
      expoundBtn.textContent = "Expound";
      expoundBtn.title = "Expound on this answer";
    }
    setPreview(""); setTag();
    setStatus(currentMode === "highlight" ? "Highlight text or ask below" : "reading page...");
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

  // (isAnswerControl / countAnswerControls / textLen are defined at the top of the file.)

  function findContainer(node) {
    let el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el || el === document.body || el === document.documentElement) return null;

    // Direct quiz/question containers in Canvas LMS, Moodle, Blackboard, Google Forms, etc.
    const QUESTION_SELECTORS = [
      ".display_question",
      ".question_holder",
      ".quiz_sortable",
      ".take_quiz_question",
      ".question",
      "[data-question-id]",
      "[data-testid*='question']",
      "[id^='question_']",
      ".quiz-item",
      ".quiz-question",
      "fieldset",
      "[role='radiogroup']",
      ".freebirdFormviewerComponentsQuestionBaseRoot"
    ];

    // 1) Check ancestors for standard question wrappers (prefer enclosing wrapper with question controls)
    for (const sel of QUESTION_SELECTORS) {
      const q = el.closest(sel);
      if (q && q !== document.body && q !== document.documentElement) {
        // If q is just an inner text/prompt span or div, check if its parent has the outer question container with controls
        if (countAnswerControls(q) > 0) return q;
        const outer = q.parentElement?.closest(sel);
        if (outer && outer !== document.body && outer !== document.documentElement &&
            textLen(outer) <= MAX_CONTAINER_CHARS) {
          return outer;
        }
        if (textLen(q) <= MAX_CONTAINER_CHARS) return q;
      }
    }

    // 2) Upward climb: stop strictly if multiple questions or huge containers are encountered
    let curr = el;
    let best = null;

    for (let i = 0; i < 8 && curr && curr !== document.body && curr !== document.documentElement; i++) {
      if (textLen(curr) > MAX_CONTAINER_CHARS) break; // grew into page layout, not a question
      const hasControls = countAnswerControls(curr) > 0;
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
      if (pText.length > MAX_CONTAINER_CHARS) break;
      const qHeaders = pText.match(/\bQuestion\s+\d+\b/gi);
      if (qHeaders && qHeaders.length > 1) break;

      curr = parent;
      if (hasControls) best = curr;
    }

    return best;
  }

  // (PLACEHOLDER / SKIP_TAGS are defined at the top so iframe frames can use serialize() too.)

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
      if (n.id === "cx-host") return; // never read our own overlay (works in iframes too)

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
        if (!isAnswerControl(n)) return; // skip search boxes, hidden tokens, etc.
        const type = (n.type || "text").toLowerCase();
        if (type === "radio") out += n.checked ? "(x) " : "( ) ";
        else if (type === "checkbox") out += n.checked ? "[x] " : "[ ] ";
        else if (type === "text" || type === "number") out += "[Blank input] ";
        return;
      }
      if (n.tagName === "TEXTAREA") {
        if (isAnswerControl(n)) out += "[Blank input] ";
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

  function hasRealOptionsOrControls(container, context) {
    if (!context) return false;
    if (countAnswerControls(container) > 0) return true;
    if (/\[Dropdown #|\([x ]\)|\[[x ]\]|\[Blank input\]/i.test(context)) return true;
    const optionMatches = context.match(/^\s*(?:[A-Ea-e][.)]|[1-9][.)]|\([A-Ea-e1-9]\))\s+\S+/gm);
    if (optionMatches && optionMatches.length >= 2) return true;
    return false;
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

      // Enriched context is attached ONLY if the selection sits in a real question block
      let promptContent = t;
      try { promptContent = buildSelectionPayload(t, s.anchorNode); } catch {}

      lastText = t;
      contextDetached = false;
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
      setStatus("Highlight text or ask below");
    }
  };

  // ── Question types & prompts ────────────────────────────────────────────
  const VERBATIM = "Copy the option text VERBATIM from the page.";
  const TASKS = {
    matching: `MATCHING: Output each pair on its own line: <item> → <verbatim option text>. ${VERBATIM}`,
    dropdown: `DROPDOWN: Output ONLY the matching option text. ${VERBATIM}`,
    choice:   `MULTIPLE CHOICE: Output ONLY the exact text of the correct option — no letter, no numbering. ${VERBATIM}`,
    multi:    `SELECT ALL: Output each correct option verbatim on its own line. ${VERBATIM}`,
    truefalse:`TRUE/FALSE: Output ONLY "True" or "False".`,
    fill:     `FILL-IN-THE-BLANK: Output ONLY the exact text/term to enter into the blank. No prefixes, no labels. If multiple blanks, number each on its own line.`,
    question: `QUESTION: Answer it directly. Give the final answer only (a name, term, number with units, or one short sentence). If it lists options, output the correct option verbatim.`,
    term:     `IDENTIFY: The highlight is a term, name, title, or short phrase — NOT a question. In 1-2 sentences, say what it is or what it means (definition / identification). Do not answer with a single number or word.`,
    passage:  `PASSAGE: The highlight is a statement or passage — NOT a question. If it is a checkable factual claim, start with "True" or "False" followed by a short reason. Otherwise state its key point/meaning in 1-2 sentences.`,
    page:     `SCAN: Answer each question on its own numbered line (1. <answer>). ${VERBATIM}`
  };

  // Words that typically open a question or an exam instruction.
  const QUESTION_START = /^(who|whom|whose|what|which|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|name|define|identify|explain|describe|state|list|give|find|solve|calculate|compute|determine|evaluate|simplify|convert|compare|differentiate|distinguish|classify|predict|prove|show|choose|select|match|complete|translate)\b/i;

  // Decide what kind of thing was highlighted when no quiz controls were detected.
  function classifySelection(text) {
    const t = text.trim();
    const words = t.split(/\s+/).length;
    if (/\?\s*$/m.test(t) || QUESTION_START.test(t)) return "question";
    if (/[\d)x]\s*[-+*/^×÷=]\s*[\d(x]/i.test(t) && words <= 30) return "question"; // math expression
    // A short fragment with no sentence punctuation is a name/term/title (e.g. "Amazon Learning Club - UST")
    if (words <= 12 && !/[.!;]\s+\S/.test(t)) return "term";
    return "passage";
  }

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
    // Plain listed options (A. … / B. …) inside the highlight itself
    if ((text.match(/^\s*(?:[A-Ea-e][.)]|\([A-Ea-e]\))\s+\S+/gm) || []).length >= 2) return "choice";
    if (text.startsWith("HIGHLIGHTED:\n")) return "question"; // came from a detected question block
    return classifySelection(text);
  }

  // Light page hint (title + site) — helps disambiguate names/terms; never treated as the question.
  function pageHint() {
    try {
      const title = (document.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const site = location.hostname.replace(/^www\./, "");
      return title || site ? `\n\nPAGE (for disambiguation only — not part of the question): ${title}${site ? ` (${site})` : ""}` : "";
    } catch { return ""; }
  }

  function buildPrompt(text) {
    const type = detectType(text);
    const hint = (type === "term" || type === "passage" || type === "question") ? pageHint() : "";
    return `TASK: ${TASKS[type]}\n\nCONTENT:\n${text}${hint}`;
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

  // Renders streamed text. Routes between quiz option matching and rich text formatting.
  function renderAnswer(raw, meta = { dropdowns: [], choices: [], all: [] }, mode = "quiz") {
    if (mode === "expound" || mode === "manual") {
      return renderRichText(raw);
    }
    return renderQuizAnswer(raw, meta);
  }

  // Pure DOM, zero-XSS, structured renderer for expounded and manual explanations.
  function renderRichText(raw) {
    const wrap = el("div", "cx-exp-wrap");
    answerPlain = raw.trim();

    function appendFormattedInline(parent, text) {
      const parts = text.split(/(\*\*.*?\*\*|`.*?`)/g);
      for (const part of parts) {
        if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
          const strong = document.createElement("strong");
          strong.textContent = part.slice(2, -2);
          parent.appendChild(strong);
        } else if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
          const code = document.createElement("code");
          code.className = "cx-code";
          code.textContent = part.slice(1, -1);
          parent.appendChild(code);
        } else if (part) {
          parent.appendChild(document.createTextNode(part));
        }
      }
    }

    const lines = raw.split("\n");
    let currentList = null;
    let listType = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        currentList = null;
        listType = null;
        continue;
      }

      const headMatch = trimmed.match(/^#{1,4}\s+(.*)$/);
      if (headMatch) {
        currentList = null;
        listType = null;
        const h = el("div", "cx-exp-h");
        appendFormattedInline(h, headMatch[1]);
        wrap.appendChild(h);
        continue;
      }

      const bulletMatch = trimmed.match(/^[-*•]\s+(.*)$/);
      if (bulletMatch) {
        if (!currentList || listType !== "ul") {
          currentList = el("div", "cx-exp-list");
          listType = "ul";
          wrap.appendChild(currentList);
        }
        const li = el("div", "cx-exp-li");
        const dot = el("span", "cx-exp-bullet", "•");
        const content = el("div", "cx-exp-txt");
        appendFormattedInline(content, bulletMatch[1]);
        li.append(dot, content);
        currentList.appendChild(li);
        continue;
      }

      const numMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
      if (numMatch) {
        if (!currentList || listType !== "ol") {
          currentList = el("div", "cx-exp-list");
          listType = "ol";
          wrap.appendChild(currentList);
        }
        const li = el("div", "cx-exp-li");
        const num = el("span", "cx-exp-num", numMatch[1] + ".");
        const content = el("div", "cx-exp-txt");
        appendFormattedInline(content, numMatch[2]);
        li.append(num, content);
        currentList.appendChild(li);
        continue;
      }

      currentList = null;
      listType = null;
      const p = el("div", "cx-exp-p");
      appendFormattedInline(p, trimmed);
      wrap.appendChild(p);
    }

    ansEl.replaceChildren(wrap);
    return false;
  }

  function renderQuizAnswer(raw, meta = { dropdowns: [], choices: [], all: [] }) {
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

  function handleAnswerFinished(text, meta, mode) {
    if (mode === "quiz") {
      savedBriefAnswer = { text, meta, preview: selTxt.textContent, badge: selBadge.textContent, plain: answerPlain, source: lastAskText };
      savedExpoundAnswer = null;
      currentView = "brief";
      expoundBtn.style.display = "";
      expoundBtn.textContent = "Expound";
      expoundBtn.title = "Get detailed explanation and reasoning";
    } else if (mode === "expound") {
      savedExpoundAnswer = { text, preview: selTxt.textContent, plain: answerPlain };
      currentView = "expound";
      expoundBtn.style.display = "";
      expoundBtn.textContent = "Brief";
      expoundBtn.title = "Show concise answer";
      if (savedBriefAnswer) setTag("← View brief answer", "act");
    } else if (mode === "manual") {
      savedBriefAnswer = { text, meta: { dropdowns: [], choices: [], all: [] }, preview: selTxt.textContent, badge: selBadge.textContent, plain: answerPlain };
      savedExpoundAnswer = null;
      currentView = "manual";
      expoundBtn.style.display = "";
      expoundBtn.textContent = "Expound";
      expoundBtn.title = "Expound on this answer";
    }

    if (lastText && answerPlain && mode !== "manual") {
      contextDetached = false;
      if (ctxChip) {
        ctxChip.style.display = "flex";
        const shortQ = lastText.replace(/\s+/g, " ").trim();
        ctxTxt.textContent = "Linked: " + (shortQ.length > 26 ? shortQ.slice(0, 26) + "…" : shortQ);
        ctxChip.title = "Linked to current question. Click ✕ to ask/search independently.";
        promptIn.placeholder = "Ask follow-up or any question... (Enter)";
      }
    }
  }

  // ── Expound on an answer ────────────────────────────────────────────────
  function doExpound() {
    const questionContext = savedBriefAnswer?.source || lastText || (savedBriefAnswer?.preview || "Current question");
    const currentAnswer = answerPlain || (savedBriefAnswer?.plain || "");
    if (!questionContext && !currentAnswer) return;

    const expoundPrompt = `TARGET QUESTION:\n${questionContext}\n\nANSWER:\n${currentAnswer}\n\nProvide the high-density conceptual breakdown and step-by-step logic.`;

    selBadge.textContent = "EXP";
    const previewStr = questionContext.length > 50 ? questionContext.slice(0, 50) + "…" : questionContext;
    selTxt.textContent = "Expounding: " + previewStr;
    selEl.title = questionContext;
    selEl.style.display = "flex";

    expoundBtn.textContent = "Brief";
    expoundBtn.title = "Show concise answer";
    currentView = "expound";

    ask(expoundPrompt, false, null, "expound");
  }

  expoundBtn.addEventListener("click", () => {
    if (currentView === "expound") {
      // Toggle back to brief answer
      if (savedBriefAnswer) {
        showAnswerPane();
        renderAnswer(savedBriefAnswer.text, savedBriefAnswer.meta, "quiz");
        selBadge.textContent = savedBriefAnswer.badge || "Q";
        selTxt.textContent = savedBriefAnswer.preview || "";
        currentView = "brief";
        expoundBtn.textContent = "Expound";
        expoundBtn.title = "Get detailed explanation and reasoning";
        if (savedExpoundAnswer) {
          setTag("→ View explanation", "act");
        }
      }
    } else {
      // User wants to view or generate expounded explanation
      if (savedExpoundAnswer) {
        showAnswerPane();
        renderAnswer(savedExpoundAnswer.text, { dropdowns: [], choices: [], all: [] }, "expound");
        selBadge.textContent = "EXP";
        selTxt.textContent = savedExpoundAnswer.preview || "Detailed Explanation";
        currentView = "expound";
        expoundBtn.textContent = "Brief";
        expoundBtn.title = "Show concise answer";
        setTag("← View brief answer", "act");
      } else {
        doExpound();
      }
    }
  });

  // ── Manual prompt / follow-up handler ───────────────────────────────────
  ctxDel?.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    contextDetached = true;
    ctxChip.style.display = "none";
    promptIn.placeholder = "Ask anything / search directly... (Enter)";
    promptIn.focus();
  });

  function isFollowUp(query, lastQ, lastA) {
    if (!lastQ && !lastA) return false;
    const q = query.toLowerCase().trim();

    const followUpPatterns = [
      /^(why|how so|why not|how come)\b/i,
      /^(explain|elaborate|clarify|expand|break down)\b/i,
      /^(what about|how about|is it|is that|could it be)\b/i,
      /\b(the answer|this answer|the question|above|previous|the option|choice [a-d]|option [a-d]|instead of)\b/i,
      /\b(step \d|step-by-step|formula used|show work)\b/i
    ];
    if (followUpPatterns.some(re => re.test(q))) return true;

    const stopWords = new Set(["the", "is", "at", "which", "on", "a", "an", "and", "or", "to", "in", "for", "of", "what", "how", "who", "when", "where", "can", "you", "tell", "me"]);
    const queryTokens = q.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
    const contextText = ((lastQ || "") + " " + (lastA || "")).toLowerCase();

    let matches = 0;
    for (const t of queryTokens) {
      if (contextText.includes(t)) matches++;
    }
    return matches >= 2 || (matches >= 1 && queryTokens.length <= 3);
  }

  function sendManualPrompt() {
    const q = promptIn.value.trim();
    if (!q) return;
    promptIn.value = "";

    const followUp = !contextDetached && (answerPlain || lastText) && isFollowUp(q, lastText, answerPlain);

    let fullPrompt;
    if (followUp) {
      fullPrompt = `[CONTEXT FROM PAGE]\n${lastText}\n\n[ANSWER]\n${answerPlain}\n\n[FOLLOW-UP QUERY]\n${q}`;
    } else {
      fullPrompt = q;
      contextDetached = true;
      if (ctxChip) ctxChip.style.display = "none";
      promptIn.placeholder = "Ask anything / search directly... (Enter)";
    }

    selBadge.textContent = followUp ? "FOL" : "ASK";
    selTxt.textContent = q;
    selEl.title = q;
    selEl.style.display = "flex";

    currentView = "manual";
    lastText = q;

    ask(fullPrompt, true, null, "manual");
  }

  promptSend.addEventListener("click", sendManualPrompt);
  promptIn.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      sendManualPrompt();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      promptIn.blur();
    }
  });

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
    if (m.status >= 500) return "AI provider is busy — try again shortly";
    if (/timed out/i.test(m.message)) return "request timed out — highlight again";
    if (/failed to fetch|networkerror|load failed/i.test(m.message)) return "offline — check your connection";
    return m.message;
  }

  // ── Ask AI ──────────────────────────────────────────────────────────────
  async function ask(text, fresh = false, image = null, mode = "quiz") {
    if (!apiKey) { showSetup(); return; }
    cancelRequest();
    const id = reqId;
    lastAskText = text;
    applyTheme();

    statusEl.style.display = "none";
    ansWrap.style.display = "none";
    thinkEl.style.display = "flex";
    setTag();

    const prompt = mode === "quiz" ? buildPrompt(text) : text;
    const ckey = hash(mode + "_" + currentProvider + "_" + currentModel + "_" + prompt + (image?.base64 ? "_img" : ""));
    const meta = mode === "quiz" ? parseOptions(text) : { dropdowns: [], choices: [], all: [] };

    if (!fresh) {
      const hit = await cacheGet(ckey);
      if (id !== reqId) return; // superseded while reading the cache
      if (hit) {
        showAnswerPane();
        renderAnswer(hit, meta, mode);
        handleAnswerFinished(hit, meta, mode);
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
          if (m.backup) setTag("answered by " + m.label); // failover model used
        } else if (m.type === "status") {
          setStatus(m.message);
          thinkEl.style.display = "flex";
        } else if (m.type === "chunk") {
          acc += m.text;
          showAnswerPane();
          renderAnswer(acc, meta, mode);
        } else if (m.type === "done") {
          finished = true;
          showAnswerPane();
          const unsure = renderAnswer(m.text, meta, mode);
          if (unsure) setTag("? = low confidence — double-check", "warn");
          else cacheSet(ckey, m.text); // only cache answers the model was sure about
          handleAnswerFinished(m.text, meta, mode);
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

      p.postMessage({
        type: "ASK",
        text: prompt,
        apiKey,
        provider: currentProvider,
        model: currentModel,
        image,
        mode
      });
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
  // ── Drag & Resize ────────────────────────────────────────────────────────
  document.addEventListener("mousemove", e => {
    if (dragging) {
      overlay.style.left = e.clientX - dragOX + "px";
      overlay.style.top = e.clientY - dragOY + "px";
      overlay.style.right = "auto"; overlay.style.bottom = "auto";
      e.stopPropagation();
    }
    if (resizing) {
      overlay.style.width = Math.max(240, resStartW + (e.clientX - resStartX)) + "px";
      overlay.style.height = Math.max(160, resStartH + (e.clientY - resStartY)) + "px";
      overlay.style.maxHeight = "none";
      e.stopPropagation();
    }
  }, true);
  document.addEventListener("mouseup", () => { dragging = false; resizing = false; }, true);
  rzHandle.addEventListener("mousedown", e => {
    resizing = true;
    resStartX = e.clientX; resStartY = e.clientY;
    resStartW = overlay.offsetWidth; resStartH = overlay.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  });
  // ── Event & Focus Isolation ──────────────────────────────────────────────
  // 1) Prevent focus theft: e.preventDefault() on mousedown ensures the browser never shifts
  //    document.activeElement away from the host page (e.g. active form fields or text inputs).
  // 2) Prevent mouse, pointer, clipboard, and keyboard events from bubbling or capturing to host listeners.
  const POINTER_EVENTS = [
    "mousedown", "mouseup", "click", "dblclick", "auxclick",
    "pointerdown", "pointerup", "pointercancel", "contextmenu"
  ];

  // Interactive controls that must process clicks, touch taps, and key input
  const INTERACTIVE_SELECTOR = "input, textarea, select, option, a, button, [role='button'], .cx-mode, .cx-cp, #cx-tag, #cx-sel";

  POINTER_EVENTS.forEach(type => {
    // Capture phase: side effects only (no stopPropagation here so controls receive events).
    overlay.addEventListener(type, e => {
      if (type === "mousedown") {
        const isInteractive = !!e.target?.closest?.(INTERACTIVE_SELECTOR);
        const isTouch = e.pointerType === "touch";
        // Allow focus and interaction on form controls, dropdowns, and buttons inside the overlay.
        // Prevent default only on non-interactive backdrop/drag/read areas to prevent focus theft from host.
        // Never call preventDefault on interactive controls or touch events (preventDefault on touch suppresses click).
        if (!isInteractive && !isTouch) {
          e.preventDefault();
        }
      }
      if (type === "mouseup" || type === "pointerup") {
        dragging = false;
        resizing = false;
      }
    }, true);

    // Bubble phase: stop the event after overlay controls have handled it,
    // so it never escapes the shadow host into the page DOM.
    overlay.addEventListener(type, e => e.stopPropagation(), false);
    host.addEventListener(type, e => e.stopPropagation(), false);
  });

  // Keep typing or editing in the overlay from triggering the host page's keyboard shortcuts or listeners
  const KEY_INPUT_EVENTS = [
    "keydown", "keyup", "keypress", "copy", "cut", "paste",
    "input", "beforeinput", "change", "compositionstart", "compositionend"
  ];

  KEY_INPUT_EVENTS.forEach(type => {
    overlay.addEventListener(type, e => e.stopPropagation(), false);
    host.addEventListener(type, e => e.stopPropagation(), false);
  });
})();
