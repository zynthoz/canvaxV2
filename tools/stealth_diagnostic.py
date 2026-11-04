#!/usr/bin/env python3
"""
Canvax Stealth & Adversary Web Daemon / Server
==============================================
Serves the web-based diagnostic bench on http://localhost:8765
while simultaneously streaming OS-level Windows foreground window forensics
and clipboard surveillance directly into the webpage via JSON API.

Usage:
  python tools/stealth_diagnostic.py        # Opens web bench in default browser
  python tools/stealth_diagnostic.py --cli  # Console mode
"""

import sys
import os
import time
import json
import platform
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime

IS_WINDOWS = platform.system() == "Windows"

# Win32 API bindings via ctypes (Windows native)
if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    try:
        psapi = ctypes.windll.psapi
    except Exception:
        psapi = None

    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD

    try:
        user32.GetClipboardSequenceNumber.restype = wintypes.DWORD
        has_clipboard_seq = True
    except AttributeError:
        has_clipboard_seq = False


def get_foreground_info():
    """Returns (hwnd, window_title, process_name, pid) for active foreground window."""
    if not IS_WINDOWS:
        return 0, "Test Browser (Cross-Platform Mock)", "chrome", os.getpid()

    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return 0, "[No Active Window]", "unknown", 0

    length = user32.GetWindowTextLengthW(hwnd)
    buff = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buff, length + 1)
    title = buff.value

    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    proc_name = f"PID:{pid.value}"

    if psapi:
        PROCESS_QUERY_INFORMATION = 0x0400
        PROCESS_VM_READ = 0x0010
        h_proc = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid.value)
        if h_proc:
            name_buff = ctypes.create_unicode_buffer(260)
            if psapi.GetModuleBaseNameW(h_proc, None, name_buff, 260):
                proc_name = name_buff.value
            kernel32.CloseHandle(h_proc)

    return hwnd, title, proc_name, pid.value


def get_clipboard_seq():
    """Returns current clipboard sequence number on Windows."""
    if IS_WINDOWS and has_clipboard_seq:
        return user32.GetClipboardSequenceNumber()
    return 0


BROWSER_HINTS = ["chrome", "msedge", "edge", "firefox", "brave", "opera", "vivaldi", "arc"]


class DiagnosticEngine:
    """Core telemetry collector simulating exam proctor OS surveillance."""

    def __init__(self):
        self.running = False
        self.thread = None
        self.start_time = None
        self.last_window_title = None
        self.last_proc = None
        self.switch_count = 0
        self.browser_focus_seconds = 0.0
        self.other_focus_seconds = 0.0
        self.last_clipboard_seq = get_clipboard_seq()
        self.clipboard_changes = 0
        self.current_title = ""
        self.current_proc = ""
        self.current_pid = 0
        self.events_log = []

    def start(self):
        if self.running:
            return
        self.running = True
        self.start_time = time.time()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=1.0)

    def _loop(self):
        last_check = time.time()
        while self.running:
            time.sleep(0.1)
            now = time.time()
            dt = now - last_check
            last_check = now

            hwnd, title, proc, pid = get_foreground_info()
            self.current_title = title
            self.current_proc = proc
            self.current_pid = pid

            is_browser = any(b in proc.lower() or b in title.lower() for b in BROWSER_HINTS)

            if is_browser:
                self.browser_focus_seconds += dt
            else:
                self.other_focus_seconds += dt

            if title != self.last_window_title or proc != self.last_proc:
                if self.last_window_title is not None:
                    self.switch_count += 1
                self.last_window_title = title
                self.last_proc = proc

            curr_clip = get_clipboard_seq()
            if curr_clip != self.last_clipboard_seq and self.last_clipboard_seq != 0:
                self.clipboard_changes += 1
                self.last_clipboard_seq = curr_clip

    def get_status(self):
        total_time = max(1.0, self.browser_focus_seconds + self.other_focus_seconds)
        return {
            "switches": self.switch_count,
            "browser_focus_pct": round((self.browser_focus_seconds / total_time) * 100.0, 1),
            "clipboard_changes": self.clipboard_changes,
            "current_title": self.current_title,
            "current_proc": self.current_proc,
            "pid": self.current_pid,
            "is_windows": IS_WINDOWS
        }


engine = DiagnosticEngine()
engine.start()


class DiagnosticHTTPHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve from test directory
        root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test"))
        super().__init__(*args, directory=root_dir, **kwargs)

    def do_GET(self):
        # Enable CORS for local testing
        if self.path == "/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(json.dumps(engine.get_status()).encode("utf-8"))
            return

        if self.path == "/" or self.path == "":
            self.path = "/stealth-diagnostics.html"

        super().do_GET()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, format, *args):
        # Suppress noisy standard HTTP access logs in console
        pass


def run_web_bench(port=8765):
    server_address = ("127.0.0.1", port)
    try:
        httpd = ThreadingHTTPServer(server_address, DiagnosticHTTPHandler)
    except OSError:
        port = 8766
        server_address = ("127.0.0.1", port)
        httpd = ThreadingHTTPServer(server_address, DiagnosticHTTPHandler)

    url = f"http://127.0.0.1:{port}/stealth-diagnostics.html"
    print("=" * 65)
    print("  Canvax Stealth & Adversary Web Diagnostic Bench Active")
    print("=" * 65)
    print(f"URL: {url}")
    print("Real-time telemetry, window switches, focus, and DOM probes are live.")
    print("Press Ctrl+C to terminate.")
    print("=" * 65)

    try:
        webbrowser.open(url)
    except Exception:
        pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping web bench...")
        engine.stop()
        httpd.server_close()


if __name__ == "__main__":
    if "--cli" in sys.argv:
        print("Running in CLI mode...")
        while True:
            try:
                time.sleep(1)
                st = engine.get_status()
                print(f"[OS Monitor] Switches: {st['switches']} | Foreground: {st['current_title'][:35]} ({st['current_proc']})")
            except KeyboardInterrupt:
                break
    else:
        run_web_bench()
