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
// ── Storage and visibility message handlers ─────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAVE_KEY") {
    const data = { geminiKey: msg.apiKey };
    if (msg.provider !== undefined) data.cxProvider = msg.provider;
    if (msg.model !== undefined) data.cxModel = msg.model;
    chrome.storage.local.set(data, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "GET_KEY") {
    if (HARDCODED_KEY) {
      sendResponse({
        apiKey: HARDCODED_KEY,
        provider: detectProvider(HARDCODED_KEY),
        model: "auto"
      });
      return true;
    }
    chrome.storage.local.get(["geminiKey", "cxProvider", "cxModel"], data => {
      const key = data.geminiKey || null;
      const detected = detectProvider(key);
      const provider = (data.cxProvider && data.cxProvider !== "auto") ? data.cxProvider : detected;
      sendResponse({
        apiKey: key,
        provider: provider || "gemini",
        savedProvider: data.cxProvider || "auto",
        model: data.cxModel || "auto",
        detectedProvider: detected
      });
    });
    return true;
  }

  if (msg.type === "SET_CONFIG") {
    const updates = {};
    if (msg.provider !== undefined) updates.cxProvider = msg.provider;
    if (msg.model !== undefined) updates.cxModel = msg.model;
    chrome.storage.local.set(updates, () => {
      sendResponse({ ok: true });
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

  // Visual capture fallback: when text is hidden inside Canvas, SVG, or scrambled fonts
  if (msg.type === "CAPTURE_SCREEN") {
    chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 80 }, dataUrl => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "capture failed" });
      } else {
        // Strip data:image/jpeg;base64,
        const base64 = dataUrl.split(",")[1];
        sendResponse({ ok: true, base64: base64, mimeType: "image/jpeg" });
      }
    });
    return true;
  }
});

// ── Provider Auto-Detection ─────────────────────────────────────────────
function detectProvider(key) {
  if (!key || typeof key !== "string") return "gemini";
  const k = key.trim();
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-proj-") || (k.startsWith("sk-") && !k.startsWith("sk-ant-"))) return "openai";
  if (k.startsWith("AIzaSy")) return "gemini";
  return "gemini";
}

// ── Streaming port ──────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "gemini-stream") return;

  const ctrl = new AbortController();
  let gone = false;
  const post = m => { if (!gone) { try { port.postMessage(m); } catch { } } };

  port.onDisconnect.addListener(() => { gone = true; ctrl.abort(); });
  port.onMessage.addListener(async msg => {
    if (msg.type !== "ASK") return;
    const key = HARDCODED_KEY || msg.apiKey;
    const provider = (msg.provider && msg.provider !== "auto") ? msg.provider : detectProvider(key);
    const model = msg.model || "auto";

    streamAI({
      userText: msg.text,
      apiKey: key,
      provider,
      selectedModel: model,
      signal: ctrl.signal,
      post,
      image: msg.image,
      mode: msg.mode || "quiz"
    }).catch(err => post({ type: "error", message: err?.message || "unknown error" }));
  });
});

// ── Models & Labels per Provider ─────────────────────────────────────────
const PROVIDER_MODELS = {
  gemini: ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
  openai: ["gpt-4o-mini", "gpt-4o", "chatgpt-4o-latest"],
  anthropic: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
};

const LABELS = {
  "gemini-3-flash-preview": "3 flash",
  "gemini-3.1-flash-lite": "3.1 flash lite",
  "gemini-3.5-flash-lite": "3.5 flash lite",
  "gpt-4o-mini": "gpt-4o-mini",
  "gpt-4o": "gpt-4o",
  "chatgpt-4o-latest": "gpt-4o-latest",
  "claude-3-5-haiku-latest": "haiku 3.5",
  "claude-3-5-sonnet-latest": "sonnet 3.5",
  "llama-3.3-70b-versatile": "llama 3.3 70b",
  "llama-3.1-8b-instant": "llama 3.1 8b"
};

const HEDGE_MS = 4000;           // start the next model in parallel if no text by then
const ROUNDS = 2;                // passes when everything failed
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

function rankModels(models) {
  const now = Date.now();
  const until = m => health[m]?.until || 0;
  return [
    ...models.filter(m => until(m) <= now),
    ...models.filter(m => until(m) > now).sort((a, b) => until(a) - until(b))
  ];
}

const SYSTEM_PROMPT = `You are a high-speed, high-accuracy quiz and academic AI.
Form serialization: dropdowns=[Dropdown #n for item "…" — choices: 1.…], radios=( )/(x), checkboxes=[ ]/[x], blanks=[Blank input].

CONTEXT USAGE & RESOLUTION:
1. WHEN PAGE OPTIONS ARE PROVIDED (multiple-choice / dropdown / matching in CONTENT):
   - Answer MUST be the correct option copied VERBATIM from the provided choices. Never rephrase, summarize, or alter characters.
2. WHEN NO PAGE OPTIONS ARE PROVIDED (factual question, concept, open question, or general search):
   - Directly answer from authoritative factual/world knowledge with extreme precision.
   - For identification/factual questions, output the exact answer directly.
   - For general queries, answer concisely in 1-2 clear sentences.
3. STRICT CONTEXT ISOLATION:
   - Do not use surrounding unrelated page context or navigation text if it does not belong to the highlighted question.
4. OUTPUT FORMAT:
   - Begin immediately with the answer on token 1.
   - Zero preamble, zero prefixes ("Answer:", "Result:"), and no question restatement.
   - If not confident, append " [?]" to that answer line.`;

const EXPOUND_SYSTEM_PROMPT = `You are an expert academic tutor providing fast, high-density explanations.
Break down why the answer is correct with maximal clarity and minimal fluff.

FORMAT:
• Core Concept: 1-2 clear sentences explaining why this answer is correct.
• Step-by-Step Logic: Concise reasoning, formulas, or derivations.
• Key Distractor (if multiple choice): Briefly why common alternatives are incorrect.

Start immediately with the explanation. Do not use filler introductions.`;

const MANUAL_SYSTEM_PROMPT = `You are a high-speed, authoritative academic AI assistant with comprehensive real-time and factual knowledge.

DECISION PROTOCOL (WHEN TO USE CONTEXT VS. DIRECT SEARCH):
1. IF [CONTEXT FROM PAGE] IS PROVIDED:
   - Determine if [FOLLOW-UP QUERY] is actually referring to that context (e.g. asking why, comparing options, asking for steps, or continuing the problem).
   - If it is a genuine follow-up, use the context to provide a precise, context-aware answer.
   - If the user's query is on a different topic, a standalone factual question, math problem, code request, or independent search query: COMPLETELY DISREGARD the page context and answer directly from factual world knowledge.
2. IF NO CONTEXT IS PROVIDED:
   - Answer the query directly, factually, and accurately as a direct lookup/search.
3. OUTPUT:
   - Start immediately on token 1 with the direct solution.
   - No preamble, no "Based on the context", no conversational fluff.`;

function sleep(ms, signal) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

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
  err.fatal = status === 401 || status === 403 || (status === 400 && /API[ _]key/i.test(message || ""));
  if (retryAfterMs) err.retryAfterMs = Math.min(retryAfterMs, 120000);
  return err;
}

// ── SSE Stream Parsers for different API formats ───────────────────────────
async function runGeminiModel(model, apiKey, payload, signal, emit) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

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
      body: JSON.stringify(payload.geminiBody),
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
        const p = line.slice(5).trim();
        if (!p || p === "[DONE]") continue;

        let json;
        try { json = JSON.parse(p); } catch { continue; }
        if (json.error) throw httpError(json.error.code || 500, json.error.message, retryDelayMs(json));

        blockReason = json.promptFeedback?.blockReason || blockReason;
        for (const candidatePart of json.candidates?.[0]?.content?.parts || []) {
          if (candidatePart.text && !candidatePart.thought) { got = true; emit(candidatePart.text); }
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
    if (e instanceof TypeError) e.retryable = true;
    throw e;
  } finally {
    clearTimeout(idle);
    signal.removeEventListener("abort", onAbort);
  }
}

async function runOpenAICompatibleModel(endpoint, model, apiKey, payload, signal, emit, providerName) {
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
    const messages = [
      { role: "system", content: payload.sysPrompt }
    ];

    const userContent = [];
    if (payload.image && payload.image.base64) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${payload.image.mimeType || "image/jpeg"};base64,${payload.image.base64}`
        }
      });
    }
    userContent.push({ type: "text", text: payload.userText });
    messages.push({ role: "user", content: userContent });

    const body = {
      model,
      stream: true,
      temperature: payload.mode === "quiz" ? 0.0 : (payload.mode === "manual" ? 0.1 : 0.2),
      max_tokens: payload.mode === "quiz" ? 1024 : 2048,
      messages
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: attemptCtrl.signal
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw httpError(res.status, errBody?.error?.message, retryDelayMs(errBody, res.headers.get("retry-after")));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

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
        const p = line.slice(5).trim();
        if (!p || p === "[DONE]") continue;

        let json;
        try { json = JSON.parse(p); } catch { continue; }
        if (json.error) throw httpError(json.error.code || 500, json.error.message);

        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { got = true; emit(delta); }
      }
    }

    if (!got) {
      const err = new Error(`empty response from ${providerName}`);
      err.retryable = true;
      throw err;
    }
  } catch (e) {
    if (timedOut) { const t = new Error("request timed out"); t.retryable = true; throw t; }
    if (e instanceof TypeError) e.retryable = true;
    throw e;
  } finally {
    clearTimeout(idle);
    signal.removeEventListener("abort", onAbort);
  }
}

async function runAnthropicModel(model, apiKey, payload, signal, emit) {
  const endpoint = "https://api.anthropic.com/v1/messages";

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
    const userContent = [];
    if (payload.image && payload.image.base64) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: payload.image.mimeType || "image/jpeg",
          data: payload.image.base64
        }
      });
    }
    userContent.push({ type: "text", text: payload.userText });

    const body = {
      model,
      stream: true,
      max_tokens: payload.mode === "quiz" ? 1024 : 2048,
      temperature: payload.mode === "quiz" ? 0.0 : (payload.mode === "manual" ? 0.1 : 0.2),
      system: payload.sysPrompt,
      messages: [{ role: "user", content: userContent }]
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body),
      signal: attemptCtrl.signal
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw httpError(res.status, errBody?.error?.message, retryDelayMs(errBody, res.headers.get("retry-after")));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

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
        const p = line.slice(5).trim();
        if (!p || p === "[DONE]") continue;

        let json;
        try { json = JSON.parse(p); } catch { continue; }
        if (json.type === "error") {
          throw httpError(json.error?.type || 500, json.error?.message);
        }
        if (json.type === "content_block_delta" && json.delta?.text) {
          got = true;
          emit(json.delta.text);
        }
      }
    }

    if (!got) {
      const err = new Error("empty response from Anthropic");
      err.retryable = true;
      throw err;
    }
  } catch (e) {
    if (timedOut) { const t = new Error("request timed out"); t.retryable = true; throw t; }
    if (e instanceof TypeError) e.retryable = true;
    throw e;
  } finally {
    clearTimeout(idle);
    signal.removeEventListener("abort", onAbort);
  }
}

// ── Dispatcher for a single model attempt ──────────────────────────────────
function executeModel(provider, model, apiKey, payload, signal, emit) {
  if (provider === "gemini") {
    return runGeminiModel(model, apiKey, payload, signal, emit);
  }
  if (provider === "openai") {
    return runOpenAICompatibleModel("https://api.openai.com/v1/chat/completions", model, apiKey, payload, signal, emit, "OpenAI");
  }
  if (provider === "groq") {
    return runOpenAICompatibleModel("https://api.groq.com/openai/v1/chat/completions", model, apiKey, payload, signal, emit, "Groq");
  }
  if (provider === "anthropic") {
    return runAnthropicModel(model, apiKey, payload, signal, emit);
  }
  return runGeminiModel(model, apiKey, payload, signal, emit);
}

// ── Multi-model race / failover / hedging ──────────────────────────────────
function race(provider, order, payload, apiKey, signal, post) {
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
        if (!winner) {
          winner = a;
          clearTimeout(hedgeTimer);
          attempts.forEach(o => {
            if (o === a || o.failed) return;
            o.lost = true;
            penalize(o.model, { slow: true });
            o.ctrl.abort();
          });
          const label = LABELS[model] || model;
          post({ type: "model", model, label, backup: model !== order[0], provider });
        }
        if (winner === a) { full += text; post({ type: "chunk", text }); }
      };

      executeModel(provider, model, apiKey, payload, a.ctrl.signal, emit)
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
          console.warn(`[canvax] ${provider}:${model} failed:`, e.status ?? "", e.message);

          if (e.fatal || winner === a) {
            post({ type: "error", message: e.message, status: e.status });
            return finish({ stop: true });
          }
          if (winner) return;

          if (!launch() && attempts.every(x => x.failed || x.lost)) finish({ err: lastErr });
        });

      armHedge();
      return true;
    }

    launch();
  });
}

// ── Unified AI Streaming ──────────────────────────────────────────────────
async function streamAI({ userText, apiKey, provider, selectedModel, signal, post, image = null, mode = "quiz" }) {
  let sysPrompt = SYSTEM_PROMPT;
  if (mode === "expound") {
    sysPrompt = EXPOUND_SYSTEM_PROMPT;
  } else if (mode === "manual") {
    sysPrompt = MANUAL_SYSTEM_PROMPT;
  }

  const parts = [];
  if (image && image.base64) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType || "image/jpeg",
        data: image.base64
      }
    });
  }
  parts.push({ text: userText });

  const geminiBody = {
    systemInstruction: { parts: [{ text: sysPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: mode === "quiz" ? 0.0 : (mode === "manual" ? 0.1 : 0.2),
      maxOutputTokens: mode === "quiz" ? 1024 : 2048
    }
  };

  const payload = {
    userText,
    sysPrompt,
    image,
    mode,
    geminiBody
  };

  const availableModels = PROVIDER_MODELS[provider] || PROVIDER_MODELS.gemini;
  let order;
  if (provider === "gemini") {
    // Fallback and hedging race across healthy models is active for the default config (Gemini)
    if (selectedModel && selectedModel !== "auto" && selectedModel !== "fastest") {
      order = [selectedModel];
    } else {
      order = rankModels(availableModels);
    }
  } else {
    // For non-Gemini providers, do not fallback across different models: use the specified model (or primary default)
    const modelToUse = (selectedModel && selectedModel !== "auto" && selectedModel !== "fastest")
      ? selectedModel
      : availableModels[0];
    order = [modelToUse];
  }

  const why = e =>
    e.status === 429 ? "rate limited" :
      e.status >= 500 ? `${provider} busy` :
        /timed out/i.test(e.message) ? "timed out" : "hiccup";

  await healthReady;
  let lastErr = null;

  for (let round = 1; round <= ROUNDS; round++) {
    const res = await race(provider, order, payload, apiKey, signal, post);
    if (res.ok || res.stop || signal.aborted) return;
    lastErr = res.err;

    if (round < ROUNDS && lastErr?.retryable) {
      const soonest = Math.min(...order.map(m => health[m]?.until || 0)) - Date.now();
      const wait = Math.min(4000, Math.max(1000, soonest));
      post({ type: "status", message: `${why(lastErr)} on ${provider} — retrying in ${Math.ceil(wait / 1000)}s…` });
      await sleep(wait, signal);
      if (signal.aborted) return;
    } else {
      break;
    }
  }

  post({ type: "error", message: lastErr?.message || "request failed", status: lastErr?.status });
}

