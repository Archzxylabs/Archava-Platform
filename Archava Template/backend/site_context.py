"""Strict section protocol; binds page messages to the API-issued guest identity."""

import json
import re
from dataclasses import dataclass

from config import SECTIONS

PAGE_TOPIC = "archava.page"
PAGE_ACK_TOPIC = "archava.page.ack"
NAVIGATION_TOPIC = "archava.navigation"


@dataclass
class SiteContext:
    section: str | None = None
    revision: int = -1
    guest_identity: str | None = None

    def accept_packet(self, topic: str | None, data: bytes, identity: str | None) -> bool:
        participant_allowed = bool(identity and re.fullmatch(r"guest-[a-zA-Z0-9-]+", identity))
        if self.guest_identity is not None:
            participant_allowed = identity == self.guest_identity
        if topic != PAGE_TOPIC or not participant_allowed or len(data) > 128:
            return False
        try:
            payload = json.loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False
        if not isinstance(payload, dict) or set(payload) != {"section", "revision"}:
            return False
        section, revision = payload["section"], payload["revision"]
        if (not isinstance(section, str) or section not in SECTIONS
            or isinstance(revision, bool) or not isinstance(revision, int)
            or revision <= self.revision or revision < 0 or revision > 9_007_199_254_740_991):
            return False
        self.section, self.revision = section, revision
        return True

    def describe(self) -> str:
        if self.section is None:
            return "The visitor's current website section is not available yet. Do not guess."
        title, detail = SECTIONS[self.section]
        return f"The browser last confirmed the '{title}' section ({self.section}). This may change as the visitor scrolls. {detail}"


def page_ack_payload(section: str, revision: int) -> bytes:
    return json.dumps({"section": section, "revision": revision}).encode("utf-8")
