<div align="center">

<img src="extension/icons/icon128.png" width="96" alt="Canvax logo" />

# Canvax

Instant AI answers directly on your screen. Highlight text on any page to stream answers in a clean, discrete floating window.

[**Download for Chrome / Edge / Brave**](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-chrome.zip) &nbsp;&bull;&nbsp; [**Download for Firefox**](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-firefox.zip)

</div>

<br />

## Quick Install

1. Download **canvax-chrome.zip** above and unzip it to a folder.
2. Open `chrome://extensions` (or `edge://extensions` in Edge).
3. Toggle on **Developer mode** in the top right.
4. Click **Load unpacked** and choose your unzipped folder.
5. Press **Alt + Q** on any page to open Canvax, paste your free [Google Gemini API Key](https://aistudio.google.com/app/apikey), and you're set.

> **Firefox users:** Download `canvax-firefox.zip`, visit `about:debugging#/runtime/this-firefox`, and click **Load Temporary Add-on**.

<br />

## How to Use

- **Highlight Mode (Default):** Highlight any text or question on the page. Canvax automatically detects if real quiz options/controls exist—only attaching options when present, and directly answering open-ended or reading questions from global knowledge without surrounding page clutter.
- **Manual Prompting & Direct Search:** Type any custom question, math problem, or follow-up in the prompt bar and press `Enter`. Canvax automatically distinguishes between follow-up queries (`[FOL]`) and standalone general knowledge lookups (`[ASK]`). Click the `Linked to current Q [✕]` chip at any time to instantly detach page context and search freely.
- **Expound on Answers:** Click **Expound** next to Copy to receive an in-depth, step-by-step conceptual explanation and proof. Click **Brief** (or the footer tag) to seamlessly switch back to the concise verbatim answer without consuming extra quota.
- **Screen Mode:** Open settings (`⚙`), select **Screen**, and click **Done** to scan and solve all visible questions on the page at once.
- **Toggle Visibility:** Press `Alt + Q` or click the toolbar icon.
- **Copy:** Click `Copy` next to any specific answer line or copy the whole result with one click.
- **Controls:** Drag by the top bar to move it anywhere; drag the bottom right corner to resize.

<br />

## Discrete & Anti-Detection Architecture

Canvax is engineered specifically for privacy, accessibility, and zero-footprint operation:

- **Never Counts as Alt+Tab:** Runs natively inside the active browser tab as an in-page element. You never switch windows, click to another app, or lose active focus.
- **Zero Focus Theft (`blur` / `focusout` proof):** Interacting with the overlay (clicking Expound, Clear, Copy, Settings, or dragging) prevents browser focus shifting. Your active cursor position on the host page is never disrupted.
- **Keystroke & Input Scoping:** All typing and follow-up prompting in the manual prompt bar is isolated inside the closed shadow root with stopped propagation. Page keyloggers, shortcut listeners, and analytics cannot intercept your keystrokes.
- **No Native Prototype Tampering:** Proctors and anti-cheat scripts probe browser prototypes for monkey-patching. Canvax performs zero prototype modification, keeping native browser APIs 100% clean and pristine.
- **Closed Shadow DOM Sandbox:** The entire interface is isolated inside a closed shadow root. Host page scripts and DOM queries cannot inspect, read, or detect the overlay.
- **Background Worker Network Isolation:** Gemini API requests are executed entirely within the extension service worker / background thread, leaving the host page's network inspection and Fetch/XHR log completely untouched.
- **Event Boundary Isolation:** Mouse events, keystrokes, and copy operations inside Canvax are scoped to the overlay, preventing page analytics or listeners from intercepting them.
- **Unlocks Artificial Selection Blocks:** Bypasses CSS properties like `user-select: none` so text remains readable and selectable even on restricted pages.
- **Visual OCR Fallback:** On pages that hide questions behind HTML5 `<canvas>`, SVG outlines, or obfuscated web fonts, Screen Mode automatically falls back to visual extraction.

<br />

## Features

- **Instant Streaming:** Answers stream directly as they are generated.
- **One-Click Expound:** Get instant step-by-step conceptual breakdowns and logic behind any answer.
- **Manual Prompt & Follow-Up:** Type custom prompts or ask clarifying questions on ongoing quiz items.
- **Form & Quiz Aware:** Recognizes dropdown menus, multiple choice selections, and fill-in-the-blank inputs.
- **Direct Matching:** Automatically aligns answers with the verbatim options presented on the page.
- **Dual-View Memory Cache:** Toggle between brief verbatim options and full explanations with zero extra API requests.
- **Fast Local Cache:** Previous queries are saved locally for instant recall without extra API requests.
- **Private:** Runs entirely client-side in your browser. No middleman servers, analytics, or external logging.

<br />

## Troubleshooting

- **Overlay won't open:** Reload the webpage after installing or toggling the extension. Chrome blocks extensions on system URLs (`chrome://`).
- **Invalid Key:** Make sure you created a valid API key in [Google AI Studio](https://aistudio.google.com/app/apikey). Click `⚙` to re-enter your key.
- **Rate Limits:** If the free tier limit is reached, Canvax will automatically cycle to available fallback models. Wait a few seconds and try again.
