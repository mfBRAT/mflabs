#!/usr/bin/env python3
# =============================================================================
# Bitcoin Taproot Wallet Monitor — Native Desktop App
# =============================================================================

import asyncio
import json
import threading
import datetime
import os
import tkinter as tk
from tkinter import ttk

import requests
import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException

# =============================================================================
# CONFIG
# =============================================================================

CONFIG_FILE = os.path.expanduser("~/.btc_monitor_config.json")

DEFAULT_CONFIG = {
    "watch_address":       "",
    "discord_webhook_url": "",
    "auto_start":          False,
}

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            for k, v in DEFAULT_CONFIG.items():
                cfg.setdefault(k, v)
            return cfg
        except Exception:
            pass
    return dict(DEFAULT_CONFIG)

def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        print("Could not save config:", e)

# =============================================================================
# COLORS
# =============================================================================

BG      = "#0e0e1a"
BG2     = "#1a1a2e"
BG3     = "#13131e"
BORDER  = "#2a2a45"
FG      = "#ccd6e0"
FG_DIM  = "#556677"
FG_MID  = "#8899aa"
ORANGE  = "#f7931a"
GREEN   = "#00e676"
RED     = "#ef5350"
YELLOW  = "#ffa726"
BLUE    = "#2255bb"

# =============================================================================
# MONITOR LOGIC
# =============================================================================

MEMPOOL_WS_URL    = "wss://mempool.space/api/v1/ws"
MEMPOOL_PRICE_URL = "https://mempool.space/api/v1/prices"
MEMPOOL_TX_URL    = "https://mempool.space/tx/{txid}"
BACKOFF_MIN, BACKOFF_MAX, BACKOFF_FACTOR = 2, 120, 2

def fetch_usd_price():
    try:
        r = requests.get(MEMPOOL_PRICE_URL, timeout=10)
        r.raise_for_status()
        return float(r.json().get("USD", 0)) or None
    except Exception:
        return None

def sats_to_btc(sats):
    return sats / 100_000_000

def analyze_tx(tx, address):
    txid = tx.get("txid", tx.get("tx_hash", "unknown"))
    sent, recv = 0, 0
    for inp in tx.get("vin", []):
        pv = inp.get("prevout", {})
        if pv.get("scriptpubkey_address") == address:
            sent += pv.get("value", 0)
    for out in tx.get("vout", []):
        if out.get("scriptpubkey_address") == address:
            recv += out.get("value", 0)
    fee = tx.get("fee", 0)
    if sent > 0:
        return {"direction": "outgoing", "amount_sats": max(sent - recv, 0), "fee_sats": fee, "txid": txid}
    return {"direction": "incoming", "amount_sats": recv, "fee_sats": fee, "txid": txid}

def send_discord(webhook_url, info, usd_price):
    if not webhook_url:
        return
    d, amt, fee, txid = info["direction"], info["amount_sats"], info["fee_sats"], info["txid"]
    btc   = sats_to_btc(amt)
    usd_s = "${:,.2f} USD".format(btc * usd_price) if usd_price else "N/A"
    short = "{}...{}".format(txid[:10], txid[-6:]) if len(txid) > 18 else txid
    color = 0x00C853 if d == "incoming" else 0xFF1744
    label = "Received" if d == "incoming" else "Sent"
    title = "{} Bitcoin Transaction".format("Incoming" if d == "incoming" else "Outgoing")
    payload = {
        "username": "BTC Mempool Monitor",
        "embeds": [{
            "title": title, "color": color,
            "fields": [
                {"name": "Direction",      "value": d.capitalize(),                                         "inline": True},
                {"name": label,            "value": "{:.8f} BTC\n{}".format(btc, usd_s),                   "inline": True},
                {"name": "Fee",            "value": "{:,} sats".format(fee),                               "inline": True},
                {"name": "Transaction ID", "value": "[{}]({})".format(short, MEMPOOL_TX_URL.format(txid=txid)), "inline": False},
            ],
            "footer":    {"text": "mempool.space · Taproot Wallet Monitor"},
            "timestamp": datetime.datetime.utcnow().isoformat(),
        }]
    }
    try:
        requests.post(webhook_url, json=payload, timeout=10)
    except Exception:
        pass

# =============================================================================
# MONITOR THREAD
# =============================================================================

class MonitorThread(threading.Thread):
    def __init__(self, address, webhook_url, on_log, on_status, on_price, on_block, on_tx):
        super().__init__(daemon=True)
        self.address     = address
        self.webhook_url = webhook_url
        self.on_log      = on_log
        self.on_status   = on_status
        self.on_price    = on_price
        self.on_block    = on_block
        self.on_tx       = on_tx
        self._stop       = threading.Event()
        self._loop       = None

    def stop(self):
        self._stop.set()
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)

    def log(self, msg, level="info"):
        ts = datetime.datetime.now().strftime("%H:%M:%S")
        self.on_log(ts, msg, level)

    def run(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._reconnect_loop())
        except Exception:
            pass
        finally:
            self._loop.close()
        self.on_status("stopped")

    async def _reconnect_loop(self):
        backoff = BACKOFF_MIN
        while not self._stop.is_set():
            try:
                await self._monitor()
                if self._stop.is_set():
                    break
                self.log("Connection closed — reconnecting ...", "warn")
            except (ConnectionClosed, WebSocketException) as e:
                if self._stop.is_set():
                    break
                self.log("WebSocket error: {}".format(e), "warn")
            except Exception as e:
                if self._stop.is_set():
                    break
                self.log("Error: {}".format(e), "error")
            if self._stop.is_set():
                break
            self.on_status("reconnecting")
            self.log("Reconnecting in {}s ...".format(backoff), "warn")
            await asyncio.sleep(backoff)
            backoff = min(backoff * BACKOFF_FACTOR, BACKOFF_MAX)

    async def _monitor(self):
        self.log("Connecting to mempool.space ...")
        self.on_status("connecting")
        async with websockets.connect(
            MEMPOOL_WS_URL, ping_interval=30, ping_timeout=20, close_timeout=10
        ) as ws:
            self.log("Connected ✓", "success")
            self.on_status("connected")
            await ws.send(json.dumps({"action": "init"}))
            await ws.send(json.dumps({"action": "track-address", "data": self.address}))
            self.log("Watching: {}...{}".format(self.address[:16], self.address[-8:]))
            async for raw in ws:
                if self._stop.is_set():
                    break
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("block"):
                    height = msg["block"].get("height", "?")
                    self.on_block(height)
                    self.log("New block: #{}".format(height))
                txs = msg.get("address-transactions") or msg.get("address-mempool") or []
                if not txs:
                    continue
                usd = fetch_usd_price()
                if usd:
                    self.on_price(usd)
                for tx in txs:
                    try:
                        info  = analyze_tx(tx, self.address)
                        d, amt, fee = info["direction"], info["amount_sats"], info["fee_sats"]
                        btc   = sats_to_btc(amt)
                        usd_s = "${:,.2f}".format(btc * usd) if usd else ""
                        arrow = "⬇" if d == "incoming" else "⬆"
                        self.log("{} {}  {:.8f} BTC  {}  fee={:,} sats".format(
                            arrow, d.upper(), btc, usd_s, fee), d)
                        self.on_tx(info, btc, usd, usd_s)
                        send_discord(self.webhook_url, info, usd)
                    except Exception as e:
                        self.log("TX error: {}".format(e), "error")

# =============================================================================
# BUTTON HELPER — bypasses macOS tk.Button background override
# =============================================================================

def styled_btn(parent, text, bg, fg, hover_bg, command, font_size=12, pady=6, padx=14):
    btn = tk.Label(parent, text=text, bg=bg, fg=fg,
                   font=("Helvetica", font_size), cursor="hand2",
                   padx=padx, pady=pady)
    btn.bind("<Button-1>",        lambda e: command())
    btn.bind("<Enter>",           lambda e: btn.config(bg=hover_bg))
    btn.bind("<Leave>",           lambda e: btn.config(bg=bg))
    btn.bind("<ButtonRelease-1>", lambda e: btn.config(bg=bg))
    return btn

# =============================================================================
# DOCK ICON
# =============================================================================

def make_icon(size=64):
    img = tk.PhotoImage(width=size, height=size)
    cx = cy = size // 2
    r  = size // 2 - 2
    for y in range(size):
        for x in range(size):
            dx, dy = x - cx, y - cy
            if dx*dx + dy*dy <= r*r:
                img.put("#f7931a", (x, y))
    for y in range(14, 50):
        for x in range(28, 32):
            img.put("#ffffff", (x, y))
    for y in range(16, 28):
        for x in range(28, 40):
            img.put("#ffffff", (x, y))
    for y in range(19, 25):
        for x in range(38, 43):
            img.put("#f7931a", (x, y))
    for y in range(28, 40):
        for x in range(28, 42):
            img.put("#ffffff", (x, y))
    for y in range(31, 37):
        for x in range(40, 45):
            img.put("#f7931a", (x, y))
    for y in range(40, 48):
        for x in range(28, 40):
            img.put("#ffffff", (x, y))
    for y in range(12, 16):
        for x in range(25, 35):
            img.put("#ffffff", (x, y))
    for y in range(48, 52):
        for x in range(25, 35):
            img.put("#ffffff", (x, y))
    return img

# =============================================================================
# GUI
# =============================================================================

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("₿  BTC Wallet Monitor")
        self.configure(bg=BG)
        self.resizable(True, True)
        self.minsize(700, 580)

        self.config_data = load_config()
        self.monitor_ref = None
        self.running     = False

        try:
            self._icon = make_icon(64)
            self.iconphoto(True, self._icon)
        except Exception:
            pass

        self._build_ui()
        self._load_config_into_ui()

        if self.config_data.get("auto_start"):
            self.after(500, self._start)

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build_ui(self):
        hdr = tk.Frame(self, bg="#111118", pady=10, padx=16)
        hdr.pack(fill="x")
        tk.Label(hdr, text="₿  BTC Wallet Monitor", bg="#111118",
                 fg=ORANGE, font=("Helvetica", 16, "bold")).pack(side="left")
        right = tk.Frame(hdr, bg="#111118")
        right.pack(side="right")
        self.price_lbl = tk.Label(right, text="BTC: —", bg="#111118",
                                  fg=FG_MID, font=("Helvetica", 12))
        self.price_lbl.pack(side="left", padx=(0, 16))
        self.status_dot = tk.Label(right, text="●", bg="#111118",
                                   fg=FG_DIM, font=("Helvetica", 14))
        self.status_dot.pack(side="left")
        self.status_lbl = tk.Label(right, text="Stopped", bg="#111118",
                                   fg=FG_DIM, font=("Helvetica", 12))
        self.status_lbl.pack(side="left", padx=(4, 0))

        tk.Frame(self, bg=BORDER, height=1).pack(fill="x")

        body = tk.Frame(self, bg=BG, padx=16, pady=12)
        body.pack(fill="both", expand=True)

        self._build_settings(body)
        self._build_stats(body)
        self._build_log(body)
        self._build_toggle(body)

    def _build_settings(self, parent):
        card = tk.Frame(parent, bg=BG2, padx=16, pady=14)
        card.pack(fill="x", pady=(0, 10))
        tk.Label(card, text="SETTINGS", bg=BG2, fg=FG_DIM,
                 font=("Helvetica", 10, "bold")).grid(
                     row=0, column=0, columnspan=2, sticky="w", pady=(0, 10))

        tk.Label(card, text="Wallet Address", bg=BG2, fg=FG,
                 font=("Helvetica", 12)).grid(row=1, column=0, sticky="w", padx=(0, 12), pady=4)
        self.addr_var = tk.StringVar()
        tk.Entry(card, textvariable=self.addr_var, bg="#1f1f35", fg=FG,
                 insertbackground=FG, relief="flat", font=("Courier New", 11),
                 bd=6).grid(row=1, column=1, sticky="ew", pady=4)

        tk.Label(card, text="Discord Webhook", bg=BG2, fg=FG,
                 font=("Helvetica", 12)).grid(row=2, column=0, sticky="w", padx=(0, 12), pady=4)
        self.webhook_var = tk.StringVar()
        tk.Entry(card, textvariable=self.webhook_var, bg="#1f1f35", fg=FG,
                 insertbackground=FG, relief="flat", font=("Courier New", 11),
                 bd=6).grid(row=2, column=1, sticky="ew", pady=4)

        self.autostart_var = tk.BooleanVar()
        tk.Checkbutton(card, text="Auto-start on launch",
                       variable=self.autostart_var,
                       bg=BG2, fg=FG, selectcolor=BG3,
                       activebackground=BG2, activeforeground=FG,
                       font=("Helvetica", 12)).grid(
                           row=3, column=1, sticky="w", pady=(6, 2))

        btn_row = tk.Frame(card, bg=BG2)
        btn_row.grid(row=4, column=1, sticky="w", pady=(10, 0))
        styled_btn(btn_row, "Save Settings", bg=BLUE, fg="white",
                   hover_bg="#3366dd", command=self._save_settings,
                   font_size=12, pady=7, padx=16).pack(side="left")
        self.saved_lbl = tk.Label(btn_row, text="  Saved ✓", bg=BG2, fg=GREEN,
                                  font=("Helvetica", 11))
        self.saved_lbl.pack(side="left")
        self.saved_lbl.pack_forget()
        card.columnconfigure(1, weight=1)

    def _build_stats(self, parent):
        row = tk.Frame(parent, bg=BG)
        row.pack(fill="x", pady=(0, 10))
        for i, (label, attr) in enumerate([
            ("Last Block", "stat_block"),
            ("Last TX",    "stat_dir"),
            ("Amount",     "stat_amount"),
            ("Fee",        "stat_fee"),
        ]):
            cell = tk.Frame(row, bg=BG3, padx=10, pady=10)
            cell.grid(row=0, column=i, sticky="nsew", padx=(0, 8) if i < 3 else 0)
            tk.Label(cell, text=label, bg=BG3, fg=FG_DIM,
                     font=("Helvetica", 10)).pack()
            lbl = tk.Label(cell, text="—", bg=BG3, fg=FG,
                           font=("Helvetica", 13, "bold"))
            lbl.pack()
            setattr(self, attr, lbl)
            row.columnconfigure(i, weight=1)

    def _build_log(self, parent):
        card = tk.Frame(parent, bg=BG2, padx=16, pady=12)
        card.pack(fill="both", expand=True)
        hdr = tk.Frame(card, bg=BG2)
        hdr.pack(fill="x", pady=(0, 8))
        tk.Label(hdr, text="ACTIVITY LOG", bg=BG2, fg=FG_DIM,
                 font=("Helvetica", 10, "bold")).pack(side="left")
        styled_btn(hdr, "Clear", bg=BORDER, fg=FG_MID, hover_bg="#3a3a55",
                   command=self._clear_log, font_size=10,
                   pady=3, padx=10).pack(side="right")
        self.log_box = tk.Text(card, bg=BG3, fg=FG, font=("Courier New", 11),
                               relief="flat", bd=0, wrap="word",
                               state="disabled", height=12)
        self.log_box.pack(fill="both", expand=True)
        self.log_box.tag_config("ts",       foreground=FG_DIM)
        self.log_box.tag_config("info",     foreground=FG_MID)
        self.log_box.tag_config("success",  foreground=GREEN)
        self.log_box.tag_config("warn",     foreground=YELLOW)
        self.log_box.tag_config("error",    foreground=RED)
        self.log_box.tag_config("incoming", foreground=GREEN)
        self.log_box.tag_config("outgoing", foreground=RED)

    def _build_toggle(self, parent):
        self.toggle_frame = tk.Frame(parent, bg="#1a5c1a")
        self.toggle_frame.pack(fill="x", pady=(10, 0))
        self.toggle_lbl = tk.Label(self.toggle_frame, text="▶   Start Monitoring",
                                   bg="#1a5c1a", fg="white",
                                   font=("Helvetica", 14, "bold"),
                                   pady=14, cursor="hand2")
        self.toggle_lbl.pack(fill="x")
        self.toggle_lbl.bind("<Button-1>",  lambda e: self._toggle())
        self.toggle_frame.bind("<Button-1>", lambda e: self._toggle())
        self.toggle_lbl.bind("<Enter>",  lambda e: self._hover_toggle(True))
        self.toggle_lbl.bind("<Leave>",  lambda e: self._hover_toggle(False))

    def _hover_toggle(self, entering):
        c = ("702323" if entering else "5c1a1a") if self.running else ("237023" if entering else "1a5c1a")
        self.toggle_frame.config(bg="#" + c)
        self.toggle_lbl.config(bg="#" + c)

    def _set_toggle_state(self, running):
        if running:
            bg = "#5c1a1a"
            self.toggle_lbl.config(text="■   Stop Monitoring", bg=bg)
        else:
            bg = "#1a5c1a"
            self.toggle_lbl.config(text="▶   Start Monitoring", bg=bg)
        self.toggle_frame.config(bg=bg)

    def _load_config_into_ui(self):
        self.addr_var.set(self.config_data.get("watch_address", ""))
        self.webhook_var.set(self.config_data.get("discord_webhook_url", ""))
        self.autostart_var.set(self.config_data.get("auto_start", False))

    def _save_settings(self):
        self.config_data["watch_address"]       = self.addr_var.get().strip()
        self.config_data["discord_webhook_url"] = self.webhook_var.get().strip()
        self.config_data["auto_start"]          = self.autostart_var.get()
        save_config(self.config_data)
        self.saved_lbl.pack(side="left")
        self.after(2000, self.saved_lbl.pack_forget)

    def _toggle(self):
        if self.running:
            self._stop()
        else:
            self._start()

    def _start(self):
        address = self.addr_var.get().strip()
        if not address:
            self._append_log("??:??:??", "No wallet address set.", "error")
            return
        t = MonitorThread(
            address, self.webhook_var.get().strip(),
            on_log=self._on_log, on_status=self._on_status,
            on_price=self._on_price, on_block=self._on_block, on_tx=self._on_tx,
        )
        self.monitor_ref = t
        self.running = True
        self._set_toggle_state(True)
        t.start()

    def _stop(self):
        if self.monitor_ref:
            self.monitor_ref.stop()
            self.monitor_ref = None
        self.running = False
        self._set_toggle_state(False)

    def _on_close(self):
        self._stop()
        self.destroy()

    def _on_log(self, ts, msg, level):
        self.after(0, self._append_log, ts, msg, level)

    def _on_status(self, status):
        self.after(0, self._set_status, status)

    def _on_price(self, usd):
        self.after(0, self._update_price, usd)

    def _on_block(self, height):
        self.after(0, lambda: self.stat_block.config(text="#{}".format(height)))

    def _on_tx(self, info, btc, usd, usd_s):
        self.after(0, self._update_tx_stats, info, btc, usd, usd_s)

    def _append_log(self, ts, msg, level):
        self.log_box.config(state="normal")
        self.log_box.insert("end", "[{}]  ".format(ts), "ts")
        self.log_box.insert("end", msg + "\n", level)
        self.log_box.see("end")
        self.log_box.config(state="disabled")

    def _clear_log(self):
        self.log_box.config(state="normal")
        self.log_box.delete("1.0", "end")
        self.log_box.config(state="disabled")

    def _set_status(self, status):
        colors = {"stopped": FG_DIM, "connecting": YELLOW, "connected": GREEN,
                  "reconnecting": YELLOW, "error": RED}
        labels = {"stopped": "Stopped", "connecting": "Connecting...",
                  "connected": "Connected", "reconnecting": "Reconnecting...", "error": "Error"}
        c = colors.get(status, FG_DIM)
        self.status_dot.config(fg=c)
        self.status_lbl.config(text=labels.get(status, status), fg=c)
        if status == "stopped" and self.running:
            self.running = False
            self._set_toggle_state(False)

    def _update_price(self, usd):
        self.price_lbl.config(text="BTC: ${:,.0f}".format(usd))

    def _update_tx_stats(self, info, btc, usd, usd_s):
        d, fee = info["direction"], info["fee_sats"]
        color  = GREEN if d == "incoming" else RED
        self.stat_dir.config(text="⬇ Incoming" if d == "incoming" else "⬆ Outgoing", fg=color)
        self.stat_amount.config(text="{:.8f} BTC{}".format(btc, "\n" + usd_s if usd_s else ""), fg=color)
        self.stat_fee.config(text="{:,} sats".format(fee))

if __name__ == "__main__":
    app = App()
    app.mainloop()
