"""Public configuration shared by the website and the conversational worker."""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT = json.loads((ROOT / "config/project.json").read_text(encoding="utf-8"))
BRAND = PROJECT["brand"]
SECTIONS = {item["id"]: (item["label"], item["description"]) for item in PROJECT["sections"]}
PROJECT_ID = os.getenv("PROJECT_ID") or PROJECT["projectId"]
AGENT_NAME = os.getenv("ARCHAVA_AGENT_NAME", "").strip() or f"{PROJECT_ID}-host"
