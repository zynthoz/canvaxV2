<div align="center">

<img src="extension/icons/icon128.png" width="80" height="80" alt="Canvax Logo" />

# Canvax

**Instant AI answers without switching tabs, losing focus, or leaving your page.**

Canvax streams direct answers and step-by-step explanations into a discrete in-page overlay the moment you highlight text.

[**Download for Chromium** (Chrome, Edge, Brave)](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-chrome.zip) &nbsp;&bull;&nbsp; [**Download for Firefox**](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-firefox.zip)

</div>

---

## Why It Matters

Most AI assistants make you copy text, switch windows, prompt a chatbot, and switch back. On proctored exams, quizzes, or timed readings, that triggers tab-switch warnings and breaks your workflow.

| Traditional AI Tools | Canvax |
| :--- | :--- |
| Triggers window blur and tab-switch alerts | **Zero tab switches** — lives inside the current page |
| Steals cursor focus when clicked | **Zero focus loss** — keeps your page cursor undisturbed |
| Generates generic essay-style responses | **Verbatim option matching** — picks the exact correct choice |
| Sends requests from the active webpage | **Background routing** — invisible to host network logs |

---

## What It Does

- **Highlight to Answer:** Select any question on the screen. Canvax reads the question, identifies multiple-choice choices or form inputs, and streams the answer instantly.
- **Brief or In-Depth:** Get the concise answer right away. Need the proof? Click **Expound** for a full step-by-step breakdown without consuming extra API quota.
- **Follow-Up Prompting:** Type clarifying questions or solve quick math in the built-in prompt bar. Keep it linked to the current question or detach to search freely.
- **Screen Mode (Vision):** For questions locked inside canvas graphics, images, or protected text, scan the visible screen directly with vision AI.
- **Always Available:** Press `Alt + Q` to show or hide the overlay anytime. Drag to reposition, resize to fit your view.

---

## How It Stays Discrete

Built for total privacy and zero-footprint operation:

- **No Alt+Tab:** Operates inside your existing tab so you never leave the window.
- **Focus-Safe:** Interacting with the overlay will not fire browser `blur` or `focusout` events on the host page.
- **Isolated Sandbox:** Encapsulated in a closed Shadow DOM. Webpage scripts cannot inspect, read, or detect the overlay.
- **Clean Network Log:** API requests run through background workers, keeping the webpage's network inspection panel completely clean.
- **Zero Prototype Changes:** Never tampers with native browser JavaScript objects, leaving no fingerprint for anti-cheat scripts.
- **Select Anything:** Automatically bypasses `user-select: none` restrictions so you can highlight text on locked pages.

---

## Quick Setup

### Chrome, Edge, Brave
1. Download [`canvax-chrome.zip`](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-chrome.zip) and unzip it.
2. Go to `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. Press **Alt + Q** on any page, paste your free [Google Gemini API Key](https://aistudio.google.com/app/apikey), and click **Connect**.

### Firefox
1. Download [`canvax-firefox.zip`](https://github.com/zynthoz/canvaxV2/releases/latest/download/canvax-firefox.zip).
2. Go to `about:debugging#/runtime/this-firefox` and click **Load Temporary Add-on**.
3. Select the zip file, press **Alt + Q**, and add your API key.

---

## Shortcuts & Controls

- `Alt + Q` — Toggle overlay visibility
- `Enter` — Send question or follow-up prompt
- `Expound / Brief` — Switch between in-depth explanations and verbatim answers
- `Settings (⚙)` — Switch between Highlight and Screen modes, choose themes (Dark / Light / Auto), or update your key

---

## License

MIT License. See [LICENSE](file:///home/aaronlime/code/canvaxV2/LICENSE) for details.


