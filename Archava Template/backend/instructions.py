"""Render the editable system prompt without importing any paid provider SDK."""

from string import Template

from config import BRAND, ROOT, SECTIONS
from knowledge import FACTS, product_knowledge


def make_instructions(*, provider: str = "voice", seconds: int = 120) -> str:
    rendering = {
        "spatius": "Spatius renders the live avatar.",
        "tavus": "Tavus renders the live avatar.",
        "voice": "This is a voice-only session; there is no live avatar video.",
    }[provider]
    return Template((ROOT / "prompts/system.md").read_text(encoding="utf-8")).substitute(
        host_name=BRAND["hostName"], brand_name=BRAND["name"],
        default_language=BRAND["defaultLanguage"], topics=", ".join(FACTS),
        section_ids=", ".join(SECTIONS), knowledge=product_knowledge(),
        session_context=f"This conversation is already active. Its configured time window is {seconds} seconds. {rendering} The website issues public guest sessions without sign-in. Never request an account or payment during this call.",
    )


if __name__ == "__main__":
    import os
    print(make_instructions(provider=os.getenv("AVATAR_PROVIDER", "spatius"), seconds=int(os.getenv("SESSION_SECONDS", "120"))))
