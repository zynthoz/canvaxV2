// ── Hardcoded API key for testing (set your key here to bypass the setup screen) ──
const HARDCODED_KEY = "";

// ── Global overlay visibility across all tabs ────────────────────────────
async function setGlobalVisibility(visible) {
  await chrome.storage.local.set({ cxVisible: visible });
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "SET_VISIBILITY", visible }).catch(() => { });
      }
    }
  });
}

async function toggleGlobalVisibility() {
  const data = await chrome.storage.local.get("cxVisible");
  const current = data.cxVisible !== undefined ? data.cxVisible : true;
  await setGlobalVisibility(!current);
}

// ── Toggle overlay via toolbar click or keyboard shortcut (all tabs) ──────
chrome.action.onClicked.addListener(() => {
  toggleGlobalVisibility();
});

chrome.commands.onCommand.addListener(command => {
  if (command === "toggle-overlay") {
    toggleGlobalVisibility();
  }
});

// ── Storage and visibility message handlers ─────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAVE_KEY") {
    chrome.storage.local.set({ geminiKey: msg.apiKey }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "GET_KEY") {
    if (HARDCODED_KEY) {
      sendResponse({ apiKey: HARDCODED_KEY });
      return true;
    }
    chrome.storage.local.get("geminiKey", data => {
      sendResponse({ apiKey: data.geminiKey || null });
    });
    return true;
  }

  if (msg.type === "SET_GLOBAL_VISIBILITY") {
    setGlobalVisibility(msg.visible);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "TOGGLE_GLOBAL") {
    toggleGlobalVisibility();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "FRAME_SELECTION") {
    if (sender.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, {
        type: "QUERY_FROM_FRAME",
        text: msg.text,
        enriched: msg.enriched,
        preview: msg.preview
      }, { frameId: 0 }).catch(() => { });
    }
    return true;
  }
});

// ── Streaming port ──────────────────────────────────────────────────────
// The overlay opens a port per question. Messages sent back:
//   { type: "model",  model, label, backup } – which model is answering
//   { type: "status", message }              – e.g. everything busy, retrying
//   { type: "chunk",  text }                 – next piece of the answer
//   { type: "done",   text }                 – full answer
//   { type: "error",  message, status }      – final failure
// Disconnecting the port (new highlight, clear, hide) aborts the request.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "gemini-stream") return;

  const ctrl = new AbortController();
  let gone = false;
  const post = m => { if (!gone) { try { port.postMessage(m); } catch { } } };

  port.onDisconnect.addListener(() => { gone = true; ctrl.abort(); });
  port.onMessage.addListener(msg => {
    if (msg.type !== "ASK") return;
    streamGemini(msg.text, HARDCODED_KEY || msg.apiKey, ctrl.signal, post)
      .catch(err => post({ type: "error", message: err?.message || "unknown error" }));
  });
});

// ── Model routing ───────────────────────────────────────────────────────
// Goal: never make the user wait on a model that is down, throttled or slow.
//
//  1. HEALTH MEMORY   A model that fails gets a cooldown (429 → its retry delay, 5xx → 20s,
//                     404/400 → 10 min, timeout → 20s). Cooling models are skipped, so the
//                     next question goes straight to a healthy one: zero wasted time.
//  2. INSTANT FAILOVER If an attempt errors before producing text, the next model starts
//                     in that same moment (no timers, no waiting).
//  3. HEDGING         If the leading model is merely SLOW (no text after HEDGE_MS), the next
//                     model is started in parallel. The first to stream text wins; the
//                     others are aborted. Worst-case added delay ≈ HEDGE_MS.
//  4. LAST RESORT     If every model failed, wait only as long as the soonest cooldown
//                     (1–4s) and make one more pass.
//
// Listed in order of preference (quality first, then speed/availability).
const MODELS = ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
const LABELS = {
  "gemini-3-flash-preview": "3 flash",
  "gemini-3.1-flash-lite": "3.1 flash lite",
  "gemini-3.5-flash-lite": "3.5 flash lite"
};
const HEDGE_MS = 4000;           // start the next model in parallel if no text by then
const ROUNDS = 2;                // full passes over MODELS when everything failed
const IDLE_TIMEOUT_MS = 20000;   // abort an attempt if no bytes arrive for this long

// Per-model cooldowns survive service-worker restarts (storage.session is in-memory only).
let health = {};                 // { [model]: { until: epoch ms } }
const healthReady = (async () => {
  try { health = (await chrome.storage.session.get("cxHealth")).cxHealth || {}; } catch { }
})();
const saveHealth = () => { try { chrome.storage.session.set({ cxHealth: health }); } catch { } };

function cooldownFor(e) {
  if (e.slow) return 10000;
  if (e.status === 429) return Math.min(e.retryAfterMs ?? 45000, 120000);
  if (e.status === 404 || e.status === 400) return 10 * 60000;
  if (e.status >= 500) return 20000;
  if (/timed out/i.test(e.message || "")) return 20000;
  return 8000;
}
function penalize(model, e) { health[model] = { until: Date.now() + cooldownFor(e) }; saveHealth(); }
function reward(model) { if (health[model]) { delete health[model]; saveHealth(); } }

// Healthy models first (in preference order), then cooling ones, soonest-recovering first.
function rankModels() {
  const now = Date.now();
  const until = m => health[m]?.until || 0;
  return [
    ...MODELS.filter(m => until(m) <= now),
    ...MODELS.filter(m => until(m) > now).sort((a, b) => until(a) - until(b))
  ];
}

const SYSTEM_PROMPT = `You are a precise, concise AI assistant inside a browser extension.

The user message starts with a TASK instruction, followed by CONTENT taken from a webpage. Form controls in the content are serialized in brackets: dropdowns as [Dropdown #n for item "…" — choose exactly one of: 1. … 2. …], radio buttons as ( ) / (x), checkboxes as [ ] / [x], inputs as [Input: …] / [Blank input].

Rules:
- Follow the TASK instruction and its output format exactly.
- Whenever answer options are listed, the answer MUST be the option text copied VERBATIM, character for character. Never paraphrase, shorten, or reword it.
- Be as SHORT as possible, but never omit critical information.
- No filler, no preamble, no restating the question.
- If you are not confident in an answer, append " [?]" to that line.`;

function sleep(ms, signal) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Gemini puts its suggested wait in error.details[].retryDelay, e.g. "43s".
function retryDelayMs(errBody, retryAfterHeader) {
  const fromHeader = parseFloat(retryAfterHeader);
  if (fromHeader > 0) return fromHeader * 1000;
  for (const d of errBody?.error?.details || []) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d?.retryDelay || "");
    if (m) return parseFloat(m[1]) * 1000;
  }
  return undefined;
}

function httpError(status, message, retryAfterMs) {
  const err = new Error(message || `HTTP ${status}`);
  err.status = status;
  err.retryable = status === 429 || status >= 500;
  // Bad key / no access: a different model won't help, so don't try.
  err.fatal = status === 401 || status === 403 || (status === 400 && /API[ _]key/i.test(message || ""));
  if (retryAfterMs) err.retryAfterMs = Math.min(retryAfterMs, 120000);
  return err;
}

// One streaming attempt against one model. Calls `emit(text)` for each piece; resolves when
// the stream ends cleanly, throws on failure. `signal` aborts it (user cancel / lost race).
async function runModel(model, apiKey, body, signal, emit) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  // Own controller so the idle timeout can abort this attempt and be told apart from `signal`.
  const attemptCtrl = new AbortController();
  const onAbort = () => attemptCtrl.abort();
  signal.addEventListener("abort", onAbort);

  let timedOut = false, idle, got = false;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { timedOut = true; attemptCtrl.abort(); }, IDLE_TIMEOUT_MS);
  };

  try {
    arm();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: attemptCtrl.signal
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw httpError(res.status, errBody?.error?.message, retryDelayMs(errBody, res.headers.get("retry-after")));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", blockReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += decoder.decode(value, { stream: true });

      let nlIdx;
      while ((nlIdx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nlIdx).trim();
        buf = buf.slice(nlIdx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.error) throw httpError(json.error.code || 500, json.error.message, retryDelayMs(json));

        blockReason = json.promptFeedback?.blockReason || blockReason;
        for (const p of json.candidates?.[0]?.content?.parts || []) {
          if (p.text && !p.thought) { got = true; emit(p.text); }
        }
      }
    }

    if (!got) {
      const err = new Error(blockReason ? `blocked by Gemini (${blockReason})` : "empty response from Gemini");
      err.retryable = !blockReason;
      err.fatal = !!blockReason;
      throw err;
    }
  } catch (e) {
    if (timedOut) { const t = new Error("request timed out"); t.retryable = true; throw t; }
    if (e instanceof TypeError) e.retryable = true; // network failure
    throw e;
  } finally {
    clearTimeout(idle);
    signal.removeEventListener("abort", onAbort);
  }
}

// One pass over `order`: launch the first model now, then fail over instantly on errors and
// hedge in parallel when the leader is slow. Resolves with { ok } | { stop } | { err }.
function race(order, body, apiKey, signal, post) {
  return new Promise(resolve => {
    const attempts = [];
    let next = 0, winner = null, settled = false, hedgeTimer = null, lastErr = null, full = "";

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      signal.removeEventListener("abort", onUserAbort);
      attempts.forEach(a => a.ctrl.abort());
      resolve(result);
    };
    const onUserAbort = () => finish({ stop: true });
    signal.addEventListener("abort", onUserAbort, { once: true });
    if (signal.aborted) return finish({ stop: true });

    const armHedge = () => {
      clearTimeout(hedgeTimer);
      if (winner || settled || next >= order.length) return;
      hedgeTimer = setTimeout(() => { if (!winner && !settled) launch(); }, HEDGE_MS);
    };

    function launch() {
      if (settled || next >= order.length) return false;
      const model = order[next++];
      const a = { model, ctrl: new AbortController(), failed: false, lost: false };
      attempts.push(a);

      const emit = text => {
        if (settled) return;
        if (!winner) { // first model to produce text wins the race
          winner = a;
          clearTimeout(hedgeTimer);
          attempts.forEach(o => {
            if (o === a || o.failed) return;
            o.lost = true;            // too slow: abort it and steer the next questions away briefly
            penalize(o.model, { slow: true });
            o.ctrl.abort();
          });
          post({ type: "model", model, label: LABELS[model] || model, backup: model !== MODELS[0] });
        }
        if (winner === a) { full += text; post({ type: "chunk", text }); }
      };

      runModel(model, apiKey, body, a.ctrl.signal, emit)
        .then(() => {
          if (winner === a && !settled) {
            reward(model);
            post({ type: "done", text: full.trim() });
            finish({ ok: true });
          }
        })
        .catch(e => {
          if (settled || a.lost) return;
          a.failed = true; lastErr = e;
          penalize(model, e);
          console.warn(`[canvax] ${model} failed:`, e.status ?? "", e.message);

          // Auth/blocked, or it died after streaming started (retrying would duplicate text).
          if (e.fatal || winner === a) {
            post({ type: "error", message: e.message, status: e.status });
            return finish({ stop: true });
          }
          if (winner) return; // another model already won; nothing to do

          // Failed before producing text → start the next model right now.
          if (!launch() && attempts.every(x => x.failed || x.lost)) finish({ err: lastErr });
        });

      armHedge();
      return true;
    }

    launch();
  });
}

// ── Call Google Gemini (streaming, routed across MODELS) ────────────────
async function streamGemini(userText, apiKey, signal, post) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
  });
  const why = e =>
    e.status === 429 ? "rate limited" :
      e.status >= 500 ? "Gemini busy" :
        /timed out/i.test(e.message) ? "timed out" : "hiccup";

  await healthReady;
  let lastErr = null;

  for (let round = 1; round <= ROUNDS; round++) {
    const res = await race(rankModels(), body, apiKey, signal, post);
    if (res.ok || res.stop || signal.aborted) return;
    lastErr = res.err;

    // Every model failed. If it looks transient, wait only until the soonest one recovers.
    if (round < ROUNDS && lastErr?.retryable) {
      const soonest = Math.min(...MODELS.map(m => health[m]?.until || 0)) - Date.now();
      const wait = Math.min(4000, Math.max(1000, soonest));
      post({ type: "status", message: `${why(lastErr)} on every model — retrying in ${Math.ceil(wait / 1000)}s…` });
      await sleep(wait, signal);
      if (signal.aborted) return;
    } else {
      break;
    }
  }

  post({ type: "error", message: lastErr?.message || "request failed", status: lastErr?.status });
}
