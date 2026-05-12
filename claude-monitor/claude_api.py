import requests
from pathlib import Path


class ClaudeAPIError(Exception):
    pass


class ClaudeAPI:
    BASE = "https://claude.ai/api"

    def __init__(self, session_key: str):
        self.session = requests.Session()
        self.session.cookies.set("sessionKey", session_key, domain="claude.ai")
        self.session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://claude.ai/",
            "Origin": "https://claude.ai",
            "anthropic-client-platform": "web_claude_ai",
            "anthropic-client-version": "unknown",
        })
        self._org_uuid = None

    @property
    def org_uuid(self) -> str:
        if not self._org_uuid:
            r = self.session.get(f"{self.BASE}/account")
            if r.status_code in (401, 403):
                raise ClaudeAPIError("Session key invalid or expired.")
            r.raise_for_status()
            memberships = r.json().get("memberships", [])
            if not memberships:
                raise ClaudeAPIError("No organization found on this account.")
            # prefer the org that owns Claude Pro (has usage endpoint)
            # use lastActiveOrg cookie hint if present, else first
            for m in memberships:
                if m["organization"].get("capabilities") and "api" not in m["organization"].get("capabilities", []):
                    self._org_uuid = m["organization"]["uuid"]
                    break
            if not self._org_uuid:
                self._org_uuid = memberships[0]["organization"]["uuid"]
        return self._org_uuid

    def get_usage(self) -> dict:
        result = {"raw": {}, "error": None}
        try:
            # try both orgs — usage endpoint only works on the Pro/claude.ai org
            r = self.session.get(f"{self.BASE}/account")
            if r.status_code in (401, 403):
                raise ClaudeAPIError("Session key invalid or expired.")
            r.raise_for_status()
            memberships = r.json().get("memberships", [])

            for m in memberships:
                oid = m["organization"]["uuid"]
                r2 = self.session.get(f"{self.BASE}/organizations/{oid}/usage")
                if r2.status_code == 200:
                    data = r2.json()
                    if data.get("five_hour") or data.get("seven_day"):
                        result["raw"]["usage"] = data
                        break

        except ClaudeAPIError as e:
            result["error"] = str(e)
            return result
        except Exception as e:
            result["error"] = str(e)
            return result

        result.update(_parse(result["raw"]))
        return result


def _parse(raw: dict) -> dict:
    parsed = {
        "five_hour_pct": None,
        "five_hour_resets_at": None,
        "seven_day_pct": None,
        "seven_day_resets_at": None,
        "extra_credits_used": None,
        "extra_credits_limit": None,
    }
    usage = raw.get("usage", {})
    if not usage:
        return parsed

    fh = usage.get("five_hour") or {}
    parsed["five_hour_pct"] = fh.get("utilization")
    parsed["five_hour_resets_at"] = fh.get("resets_at")

    sd = usage.get("seven_day") or {}
    parsed["seven_day_pct"] = sd.get("utilization")
    parsed["seven_day_resets_at"] = sd.get("resets_at")

    ex = usage.get("extra_usage") or {}
    if ex.get("is_enabled"):
        parsed["extra_credits_used"] = ex.get("used_credits")
        parsed["extra_credits_limit"] = ex.get("monthly_limit")

    return parsed
