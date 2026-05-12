#!/usr/bin/env python3
"""Claude Pro usage monitor — Mac menu bar popover (pure PyObjC + WKWebView)."""

import io
import json
import math
import threading
import webbrowser
from datetime import datetime, timezone

import objc
import AppKit
import WebKit
from Foundation import NSObject, NSOperationQueue

import config
from claude_api import ClaudeAPI

REFRESH_INTERVAL = 60.0
POPOVER_W = 280
POPOVER_H = 274

# ─── icon ─────────────────────────────────────────────────────────────────────

def _asterisk_ns(r, g, b, size=18):
    from PIL import Image, ImageDraw
    s = size * 4
    cx = cy = s / 2
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    col = (r, g, b, 255)
    arm_len = s * 0.42
    arm_w   = s * 0.14
    for i in range(6):
        a  = math.radians(i * 60)
        ex = cx + math.cos(a) * arm_len
        ey = cy + math.sin(a) * arm_len
        px = math.sin(a) * arm_w / 2
        py = -math.cos(a) * arm_w / 2
        d.polygon([(cx+px,cy+py),(cx-px,cy-py),(ex-px,ey-py),(ex+px,ey+py)], fill=col)
        d.ellipse([ex-arm_w/2, ey-arm_w/2, ex+arm_w/2, ey+arm_w/2], fill=col)
    img = img.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO(); img.save(buf, "PNG")
    raw = buf.getvalue()
    data = AppKit.NSData.dataWithBytes_length_(raw, len(raw))
    ns = AppKit.NSImage.alloc().initWithData_(data)
    ns.setSize_(AppKit.NSMakeSize(size, size))
    return ns

_ICONS = {}

def _init_icons():
    _ICONS['normal'] = _asterisk_ns(212, 69,  122)  # pink  — healthy
    _ICONS['warn']   = _asterisk_ns(232, 197, 32)   # yellow — 60–80 %
    _ICONS['crit']   = _asterisk_ns(224, 32,  32)   # red    — 80 %+

def _icon_for(fh, sd):
    pct = fh if fh is not None else sd
    if pct is None:  return _ICONS['normal']
    if pct >= 80:    return _ICONS['crit']
    if pct >= 60:    return _ICONS['warn']
    return _ICONS['normal']

# ─── HTML ─────────────────────────────────────────────────────────────────────

HTML = r"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:280px;overflow:hidden}
body{
  background:#1c1523;color:#f0eaf6;
  font-family:-apple-system,'SF Pro Text',sans-serif;
  font-size:13px;padding:16px 16px 12px;
  -webkit-user-select:none;cursor:default;
}
.hdr{
  display:flex;align-items:center;gap:10px;
  padding-bottom:11px;border-bottom:1px solid #2a1f30;margin-bottom:11px;
}
.logo{font-size:20px;color:#d4457a;line-height:1;flex-shrink:0}
.ht{font-size:14px;font-weight:600;letter-spacing:-.2px}
.hs{font-size:10px;color:#6b5f7a;margin-top:1px}
.sec{margin-bottom:11px}
.row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px}
.lbl{font-size:10px;font-weight:700;letter-spacing:.9px;text-transform:uppercase}
.pct{font-size:21px;font-weight:700;letter-spacing:-1px;line-height:1}
.track{height:5px;background:#241d2b;border-radius:3px;overflow:hidden;margin-bottom:3px}
.fill{height:100%;border-radius:3px;transition:width .6s cubic-bezier(.4,0,.2,1),background .4s}
.rst{font-size:10px;color:#6b5f7a}
.div{height:1px;background:#2a1f30;margin:9px 0}
.xtra{font-size:11px;color:#a896b8;margin-bottom:9px}
.ftr{
  display:flex;justify-content:space-between;align-items:center;
  padding-top:9px;border-top:1px solid #2a1f30;
}
.upd{font-size:10px;color:#6b5f7a}
.btns{display:flex;gap:5px}
.btn{
  font-size:10px;color:#6b5f7a;cursor:pointer;
  border:1px solid #2a1f30;border-radius:3px;padding:2px 7px;
  background:none;display:inline-block;
}
.btn:hover{background:#2a1f30;color:#d4457a;border-color:#d4457a}
.err{font-size:11px;color:#c41a1a;padding:5px 0}
#sk-wrap{
  display:none;background:#241d2b;border-radius:6px;
  padding:10px;margin-bottom:9px;
}
#sk-in{
  width:100%;background:#1c1523;border:1px solid #2a1f30;color:#f0eaf6;
  font-size:11px;padding:5px 8px;border-radius:4px;outline:none;margin-bottom:7px;
  font-family:-apple-system,sans-serif;
}
#sk-in:focus{border-color:#d4457a}
#sk-in::placeholder{color:#6b5f7a}
.sk-row{display:flex;gap:6px}
.sk-save{
  flex:1;background:#d4457a;border:none;color:#fff;
  font-size:11px;font-weight:600;padding:4px 10px;border-radius:4px;cursor:pointer;
}
.sk-save:hover{background:#b03068}
.sk-quit{
  background:none;border:1px solid #2a1f30;color:#6b5f7a;
  font-size:11px;padding:4px 10px;border-radius:4px;cursor:pointer;
}
.sk-quit:hover{color:#c41a1a;border-color:#c41a1a}
#fh-lbl,#fh-pct{color:#d4457a}
#sd-lbl,#sd-pct{color:#2abfbf}
</style></head><body>

<div class="hdr">
  <div class="logo">✳</div>
  <div><div class="ht">Claude Usage</div><div class="hs">Pro</div></div>
</div>

<div id="sk-wrap">
  <input id="sk-in" type="text" placeholder="Paste sessionKey (sk-ant-sid02-…)" />
  <div class="sk-row">
    <button class="sk-save" onclick="saveKey()">Save Key</button>
    <button class="sk-quit" onclick="bridge('quit')">Quit</button>
  </div>
</div>

<div class="sec">
  <div class="row">
    <span class="lbl" id="fh-lbl">5-Hour</span>
    <span class="pct" id="fh-pct">—</span>
  </div>
  <div class="track"><div class="fill" id="fh-fill" style="width:0%;background:#d4457a"></div></div>
  <div class="rst"  id="fh-rst"></div>
</div>

<div class="sec">
  <div class="row">
    <span class="lbl" id="sd-lbl">7-Day</span>
    <span class="pct" id="sd-pct">—</span>
  </div>
  <div class="track"><div class="fill" id="sd-fill" style="width:0%;background:#2abfbf"></div></div>
  <div class="rst"  id="sd-rst"></div>
</div>

<div id="xtra-div" style="display:none">
  <div class="div"></div>
  <div class="xtra" id="xtra"></div>
</div>

<div id="err" class="err" style="display:none"></div>

<div class="ftr">
  <span class="upd" id="upd">Loading…</span>
  <div class="btns">
    <a class="btn" onclick="toggleSK()">⚙</a>
    <a class="btn" onclick="bridge('refresh')">↺</a>
    <a class="btn" onclick="bridge('open')">claude.ai ↗</a>
  </div>
</div>

<script>
var skOpen = false;
function bridge(m){ window.webkit.messageHandlers.bridge.postMessage(m); }
function toggleSK(){
  skOpen = !skOpen;
  document.getElementById('sk-wrap').style.display = skOpen ? 'block' : 'none';
  if(skOpen) setTimeout(function(){ document.getElementById('sk-in').focus(); }, 50);
}
function saveKey(){
  var k = document.getElementById('sk-in').value.trim();
  if(k){ bridge('key:'+k); document.getElementById('sk-in').value=''; toggleSK(); }
}
function barColor(p, def_){ return p>=80?'#c41a1a':p>=60?'#e8c520':def_; }
function fmtSecs(s){
  if(s==null||s===undefined) return '';
  if(s<=0) return 'resetting…';
  var d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
  if(d>0) return 'resets in '+d+'d '+h+'h';
  return h ? 'resets in '+h+'h '+m+'m' : 'resets in '+m+'m';
}
function update(d){
  document.getElementById('err').style.display='none';
  if(d.error){
    document.getElementById('err').textContent=d.error;
    document.getElementById('err').style.display='block';
    document.getElementById('upd').textContent='Error';
    return;
  }
  if(d.fh!=null){
    document.getElementById('fh-pct').textContent=Math.round(d.fh)+'%';
    document.getElementById('fh-fill').style.width=d.fh+'%';
    document.getElementById('fh-fill').style.background=barColor(d.fh,'#d4457a');
    document.getElementById('fh-rst').textContent=fmtSecs(d.fh_secs);
  }
  if(d.sd!=null){
    document.getElementById('sd-pct').textContent=Math.round(d.sd)+'%';
    document.getElementById('sd-fill').style.width=d.sd+'%';
    document.getElementById('sd-fill').style.background=barColor(d.sd,'#2abfbf');
    document.getElementById('sd-rst').textContent=fmtSecs(d.sd_secs);
  }
  if(d.extra_used!=null){
    document.getElementById('xtra-div').style.display='block';
    document.getElementById('xtra').textContent=
      'Extra credits  $'+d.extra_used.toFixed(2)+' / $'+d.extra_limit;
  }
  document.getElementById('upd').textContent='Updated '+d.updated;
}
</script></body></html>"""

# ─── bridge ───────────────────────────────────────────────────────────────────

class BridgeHandler(NSObject):
    app_delegate = None

    def userContentController_didReceiveScriptMessage_(self, ctl, msg):
        body = str(msg.body())
        if body == 'open':
            webbrowser.open('https://claude.ai')
        elif body == 'quit':
            AppKit.NSApp.terminate_(None)
        elif body == 'refresh':
            if self.app_delegate:
                self.app_delegate._trigger_refresh()
        elif body.startswith('key:'):
            key = body[4:].strip()
            if key:
                config.set_session_key(key)
                if self.app_delegate:
                    self.app_delegate._trigger_refresh()

# ─── nav delegate ─────────────────────────────────────────────────────────────

class NavDelegate(NSObject):
    app_delegate = None

    def webView_didFinishNavigation_(self, wv, nav):
        if not self.app_delegate:
            return
        self.app_delegate._page_ready = True
        pending = self.app_delegate._pending_js
        if pending:
            self.app_delegate._pending_js = None
            wv.evaluateJavaScript_completionHandler_(pending, None)

# ─── app delegate ─────────────────────────────────────────────────────────────

class AppDelegate(NSObject):

    def applicationDidFinishLaunching_(self, _notif):
        _init_icons()
        self._page_ready = False
        self._pending_js = None
        self._timer      = None
        self._setup_status_item()
        self._setup_popover()
        self._trigger_refresh()

    # ── status item ──────────────────────────────────────────────────────────

    def _setup_status_item(self):
        bar = AppKit.NSStatusBar.systemStatusBar()
        self._item = bar.statusItemWithLength_(AppKit.NSVariableStatusItemLength)
        btn = self._item.button()
        btn.setImage_(_ICONS['normal'])
        btn.setImagePosition_(AppKit.NSImageLeft)
        btn.setTitle_("  —")
        btn.setTarget_(self)
        btn.setAction_(objc.selector(self.togglePopover_, signature=b'v@:@'))

    # ── popover ──────────────────────────────────────────────────────────────

    def _setup_popover(self):
        self._popover = AppKit.NSPopover.alloc().init()
        self._popover.setContentSize_(AppKit.NSMakeSize(POPOVER_W, POPOVER_H))
        self._popover.setBehavior_(AppKit.NSPopoverBehaviorTransient)

        wk_cfg = WebKit.WKWebViewConfiguration.alloc().init()
        self._bridge = BridgeHandler.alloc().init()
        self._bridge.app_delegate = self
        wk_cfg.userContentController().addScriptMessageHandler_name_(
            self._bridge, 'bridge'
        )

        frame = AppKit.NSMakeRect(0, 0, POPOVER_W, POPOVER_H)
        self._wv = WebKit.WKWebView.alloc().initWithFrame_configuration_(frame, wk_cfg)
        self._wv.setValue_forKey_(False, 'drawsBackground')

        self._nav = NavDelegate.alloc().init()
        self._nav.app_delegate = self
        self._wv.setNavigationDelegate_(self._nav)
        self._wv.loadHTMLString_baseURL_(HTML, None)

        vc = AppKit.NSViewController.alloc().init()
        vc.setView_(self._wv)
        self._popover.setContentViewController_(vc)

    def togglePopover_(self, sender):
        if self._popover.isShown():
            self._popover.performClose_(sender)
        else:
            btn = self._item.button()
            self._popover.showRelativeToRect_ofView_preferredEdge_(
                btn.bounds(), btn, 3  # NSMaxYEdge — popover drops below menu bar
            )

    # ── fetch / refresh ───────────────────────────────────────────────────────

    def _trigger_refresh(self):
        if self._timer:
            self._timer.cancel()
        threading.Thread(target=self._fetch_and_reschedule, daemon=True).start()

    def _fetch_and_reschedule(self):
        self._fetch()
        self._timer = threading.Timer(REFRESH_INTERVAL, self._fetch_and_reschedule)
        self._timer.daemon = True
        self._timer.start()

    def _fetch(self):
        key = config.get_session_key()
        if not key:
            js_data = {
                'error': 'No session key — click ⚙ to set one.',
                'fh': None, 'sd': None, 'updated': '—',
            }
        else:
            try:
                js_data = self._to_js(ClaudeAPI(key).get_usage())
            except Exception as e:
                js_data = {
                    'error': str(e)[:80],
                    'fh': None, 'sd': None,
                    'updated': datetime.now().strftime('%H:%M:%S'),
                }

        NSOperationQueue.mainQueue().addOperationWithBlock_(
            lambda: self._update_ui(js_data)
        )

    @staticmethod
    def _to_js(data):
        def secs(iso):
            try:
                dt = datetime.fromisoformat((iso or '').replace('Z', '+00:00'))
                return max(0, int((dt - datetime.now(timezone.utc)).total_seconds()))
            except Exception:
                return None
        return {
            'error':       data.get('error'),
            'fh':          data.get('five_hour_pct'),
            'fh_secs':     secs(data.get('five_hour_resets_at')),
            'sd':          data.get('seven_day_pct'),
            'sd_secs':     secs(data.get('seven_day_resets_at')),
            'extra_used':  data.get('extra_credits_used'),
            'extra_limit': data.get('extra_credits_limit'),
            'updated':     datetime.now().strftime('%H:%M:%S'),
        }

    def _update_ui(self, js_data):
        fh = js_data.get('fh')
        sd = js_data.get('sd')

        self._item.button().setImage_(_icon_for(fh, sd))
        parts = []
        if fh is not None: parts.append(f'{round(fh)}%')
        if sd is not None: parts.append(f'{round(sd)}%')
        self._item.button().setTitle_('  ' + ' · '.join(parts) if parts else '  —')

        js = f'update({json.dumps(js_data, default=str)})'
        if self._page_ready:
            self._wv.evaluateJavaScript_completionHandler_(js, None)
        else:
            self._pending_js = js

# ─── entry ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    app = AppKit.NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)
    delegate = AppDelegate.alloc().init()
    app.setDelegate_(delegate)
    AppKit.NSApp.run()
