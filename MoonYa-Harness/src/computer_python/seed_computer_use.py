"""MoonYa physical-primary-desktop compatibility API; all input is mediated by the host."""
import base64
import json
import sys
import time
from dataclasses import dataclass

_channel = sys.stdout
_sequence = 0
_calls = 0

def _rpc(method, **args):
    global _sequence, _calls
    _sequence += 1
    _calls += 1
    _channel.write(json.dumps({"kind": "rpc", "id": _sequence, "method": method, "args": args}, ensure_ascii=True) + "\n")
    _channel.flush()
    reply = json.loads(sys.stdin.readline())
    if reply.get("id") != _sequence:
        raise RuntimeError("Desktop response sequence mismatch")
    result = reply["result"]
    if result.get("success") is False:
        raise RuntimeError(result.get("error") or result.get("message") or "Desktop action failed")
    return result

@dataclass(frozen=True)
class App:
    name: str

class AppCatalog(list):
    def __repr__(self):
        return "AppCatalog(" + repr(self[:5]) + (", ..." if len(self) > 5 else "") + ")"

class Screenshot(bytes):
    def __new__(cls, result):
        obj = super().__new__(cls, base64.b64decode(result["image"], validate=True))
        obj.width = int(result["width"])
        obj.height = int(result["height"])
        return obj

def screenshot(tag=None): return Screenshot(_rpc("screenshot", tag=tag))
def list_apps(): return AppCatalog(App(item["name"]) for item in _rpc("list_apps")["apps"])
def launch_app(name): return _rpc("launch_app", name=name)
def click(x, y): return _rpc("click", x=x, y=y, button="left", count=1)
def left_double(x, y): return _rpc("click", x=x, y=y, button="left", count=2)
def triple_click(x, y): return _rpc("click", x=x, y=y, button="left", count=3)
def right_single(x, y): return _rpc("click", x=x, y=y, button="right", count=1)
def hover(x, y): return _rpc("hover", x=x, y=y)
move = move_mouse = hover
def drag(x1, y1, x2, y2): return _rpc("drag", x=x1, y=y1, x2=x2, y2=y2)
def scroll(x, y, delta): return _rpc("scroll", x=x, y=y, delta=delta)
def type(text): return _rpc("type", text=text)
def hotkey(*keys): return _rpc("hotkey", keys=list(keys))
def press(key): return hotkey(key)
def key_down(key): return _rpc("key_down", key=key)
def key_up(key): return _rpc("key_up", key=key)
def wait(seconds):
    result = _rpc("wait", seconds=seconds)
    time.sleep(result["wait_ms"] / 1000)
    return result
def get_clipboard(): return _rpc("get_clipboard")["text"]
def set_clipboard(text): return _rpc("set_clipboard", text=text)
def copy_selection():
    hotkey("ctrl", "c")
    wait(0.15)
    return get_clipboard()
