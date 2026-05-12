import json
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "claude-monitor"
CONFIG_FILE = CONFIG_DIR / "config.json"


def load() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except Exception:
            pass
    return {}


def save(data: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(data, indent=2))


def get_session_key() -> str:
    return load().get("session_key", "")


def set_session_key(raw: str):
    """Accept either a bare sk-ant-... token or a full cookie string."""
    raw = raw.strip()
    # if it looks like a full cookie string, extract sessionKey= value
    if "sessionKey=" in raw:
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith("sessionKey="):
                raw = part[len("sessionKey="):]
                break
    data = load()
    data["session_key"] = raw
    save(data)
