<div align="center">

<img src="extension/icons/icon128.png" width="88" height="88" alt="Canvax Logo" />

# Canvax

**Zero-friction, in-page AI assistance for web-based assessments and reading.**

Canvax streams contextual answers and in-depth conceptual breakdowns directly onto your screen through a non-intrusive floating overlay, eliminating tab switching and window toggling entirely.

[**Download for Chromium** (Chrome, Edge, Brave)](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-chrome.zip) &nbsp;&bull;&nbsp; [**Download for Firefox**](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-firefox.zip)

</div>

---

## Why Canvax

Most AI tools force disruptive workflows: copy text, switch tabs, prompt an LLM, switch back, and refocus. On proctored platforms and timed assessments, switching windows triggers blur detection, flag counters, and loss of focus.

Canvax is engineered from the ground up to solve this:

- **Zero window switches:** Runs natively within the active document. You never Alt+Tab or leave the viewport.
- **Zero focus theft:** Clicking buttons, copying text, or dragging the interface never steals page focus (`blur` / `focusout` proof).
- **Proctor-resilient design:** Encapsulated in a closed Shadow DOM root with background-thread networking and zero prototype modifications.
- **Verbatim quiz intelligence:** Intelligently maps questions against live page options, dropdowns, and form elements, while directly answering open-ended items.

---

## Key Capabilities

### Highlighting and Instant Answers
Highlight any question or passage on any webpage. Canvax automatically detects surrounding context, identifies relevant multiple-choice choices or form inputs, and streams the concise answer into the floating interface.

### Dual-View Answer Engine (Brief vs. Expound)
- **Brief:** Delivers immediate, high-confidence verbatim answers matching page options.
- **Expound:** Click **Expound** to view a comprehensive, step-by-step conceptual walkthrough and rationale.
- **Zero-Token Switching:** Toggling between Brief and Expound views utilizes an in-memory client cache, saving API quota.

### Context-Aware Follow-Up & Standalone Prompts
Use the prompt bar for ad-hoc math equations, clarifying queries, or quick lookups:
- **Linked Context:** Ask follow-ups against the highlighted question.
- **Detached Search:** Click the context badge (`Linked to current Q [x]`) to query Gemini globally without residual page context.

### Multi-Model Hedging and Resilient Streaming
Canvax coordinates Gemini models (`gemini-3-flash-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`) via a background service worker:
- **Health memory:** Temporarily deprioritizes rate-limited endpoints.
- **Hedging:** Dispatches parallel requests if the primary model exhibits latency spikes.
- **Instant failover:** Guarantees uninterrupted response delivery without manual intervention.

### Full-Screen Vision Capture
When content is protected by HTML5 `<canvas>`, SVG paths, or scrambled font glyphs, switch Canvax to **Screen Mode** to visually capture and interpret rendered items directly via Gemini Vision.

---

## Undetectable Architecture

Canvax is built specifically to operate cleanly without leaving detectable footprints on host pages:

| Layer | Implementation & Mechanism |
| :--- | :--- |
| **DOM Isolation** | Encapsulated inside a closed Shadow DOM (`attachShadow({ mode: "closed" })`). Host scripts and standard DOM queries cannot inspect or locate the overlay. |
| **Prototype Integrity** | Strictly zero monkey-patching or overrides of native JavaScript prototypes (`Event`, `Node`, `Element`, `Window`). Proctors querying prototype integrity detect no anomalies. |
| **Focus Retention** | Overlay interactions suppress synthetic focus shifts, preserving host cursor and input states without dispatching `blur` or `focusout` events. |
| **Keystroke Scoping** | Input events in the manual prompt field terminate propagation inside the shadow root, preventing page keyloggers and telemetry listeners from reading inputs. |
| **Network Isolation** | Model API calls route exclusively through the extension background service worker. The host page's Fetch, XMLHttpRequest, and DevTools network logs remain entirely clean. |
| **Restriction Bypass** | Counteracts aggressive CSS rules such as `user-select: none` using constructable stylesheets (`adoptedStyleSheets`), keeping text readable and selectable. |
| **Cross-Frame Support** | Child iframes relay selected questions securely to the top-level frame without spawning redundant DOM nodes in embedded frames. |

---

## Installation

### Chromium-Based Browsers (Chrome, Edge, Brave, Opera)

1. Download [`canvax-chrome.zip`](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-chrome.zip) from the latest release and extract the archive.
2. Navigate to your browser's extensions page (`chrome://extensions` or `edge://extensions`).
3. Enable **Developer mode** via the toggle in the upper-right corner.
4. Click **Load unpacked** and select the unzipped directory.
5. Press **Alt + Q** on any page to open Canvax.
6. Enter a free API key from [Google AI Studio](https://aistudio.google.com/app/apikey) and click **Connect**.

### Mozilla Firefox

1. Download [`canvax-firefox.zip`](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-firefox.zip) from the latest release.
2. Navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select the downloaded ZIP file.
4. Press **Alt + Q** to activate the overlay and provide your API key.

---

## Usage Reference

- **Toggle Visibility:** Press `Alt + Q` or click the Canvax icon in the browser toolbar.
- **Reposition & Resize:** Drag using the header bar; resize via the handle in the bottom-right corner.
- **Copy Results:** Click `Copy` adjacent to any specific answer line or copy the entire output with one click.
- **Switch Modes:** Open Settings (`Settings / ⚙`) to toggle between **Highlight** and **Screen** modes, adjust color themes (Auto / Dark / Light), or update API keys.

---

## Diagnostics & Troubleshooting

- **Overlay does not appear:** Browser security prevents extensions from running on system pages (`chrome://`, `about:`, Webstore). Ensure you are testing on standard web domains (`https://`). Refresh previously opened tabs after a fresh install.
- **Invalid API Key:** Verify that the key is generated within [Google AI Studio](https://aistudio.google.com/app/apikey). Click the Settings icon to update the key.
- **Quota & Rate Limits:** Canvax automatically rotates to healthy fallback models during quota throttling. If rate limits persist, allow a few moments before retrying.

---

## License

Distributed under the MIT License. See [LICENSE](file:///home/aaronlime/code/canvaxV2/LICENSE) for details.

