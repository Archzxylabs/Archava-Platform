"""Only operator-approved, explicitly labelled facts enter the model's briefing."""

from config import PROJECT, BRAND, SECTIONS

FACTS = PROJECT["knowledge"]


def product_facts(topic: str) -> str:
    if topic not in FACTS:
        return "Unknown topic. Choose " + ", ".join(FACTS) + "."
    fact = FACTS[topic]
    return f"[{fact['status'].upper()}] {fact['text']}"


def product_knowledge() -> str:
    facts = "\n".join(f"- {topic}: {product_facts(topic)}" for topic in FACTS)
    sections = "\n".join(f"- {key} ({label}): {detail}" for key, (label, detail) in SECTIONS.items())
    contact = BRAND["contactUrl"]
    contact_fact = f"Published business contact: {contact}." if contact else "No business contact is published. This website sends no inquiry."
    return f"VERIFIED PROJECT BRIEFING:\n{facts}\n\nCONTACT:\n{contact_fact}\n\nALLOWED SITE SECTIONS:\n{sections}"
