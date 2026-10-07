"""Archava's portable worker: realtime voice, optional avatar, bounded tools."""

import asyncio
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from google.genai import types as genai_types
from livekit import agents
from livekit.agents import NOT_GIVEN, APIConnectOptions, Agent, AgentSession, function_tool, room_io
from livekit.agents.voice.turn import EndpointingOptions, InterruptionOptions, TurnHandlingOptions
from livekit.plugins import google, spatius, tavus

from config import AGENT_NAME, BRAND, PROJECT_ID, SECTIONS
from instructions import make_instructions
from knowledge import product_facts
from site_context import NAVIGATION_TOPIC, PAGE_ACK_TOPIC, SiteContext, page_ack_payload


def configured(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value if value and not value.lower().startswith(("your_", "your-")) else None


def session_metadata(raw: str | None) -> dict:
    """Ignore dispatches for other projects, even when LiveKit is shared."""
    try:
        meta = json.loads(raw or "{}")
    except (TypeError, ValueError):
        raise ValueError("Invalid room metadata") from None
    if (not isinstance(meta, dict) or meta.get("product") != "archava-template"
        or meta.get("projectId") != PROJECT_ID
        or not isinstance(meta.get("guestIdentity"), str) or not meta["guestIdentity"].startswith("guest-")
        or meta.get("avatarProvider") not in {"spatius", "tavus", "voice"}
        or meta.get("avatarProvider") != os.getenv("AVATAR_PROVIDER", "spatius")
        or isinstance(meta.get("sessionSeconds"), bool) or not isinstance(meta.get("sessionSeconds"), int)
        or not 30 <= meta["sessionSeconds"] <= 1800
        or isinstance(meta.get("endsAt"), bool) or not isinstance(meta.get("endsAt"), int)
        or meta["endsAt"] <= time.time()):
        raise ValueError("Room belongs to another project or has invalid session context")
    return meta


def new_session(instructions: str) -> AgentSession:
    key = configured("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is required")
    return AgentSession(
        llm=google.realtime.RealtimeModel(
            model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"),
            voice=os.getenv("GEMINI_VOICE", "Kore"), api_key=key,
            thinking_config=genai_types.ThinkingConfig(thinking_budget=0), instructions=instructions,
        ),
        turn_handling=TurnHandlingOptions(
            endpointing=EndpointingOptions(min_delay=0.15, max_delay=0.6),
            interruption=InterruptionOptions(enabled=True, min_duration=0.8, min_words=1),
        ),
    )


class ArchavaHost(Agent):
    def __init__(self, site: SiteContext, room: object, instructions: str) -> None:
        self._site, self._room = site, room
        super().__init__(instructions=instructions)

    @function_tool
    async def get_current_page(self) -> str:
        """Get the last acknowledged website section. No screen or page-text access."""
        return self._site.describe()

    @function_tool
    async def get_product_facts(self, topic: str) -> str:
        """Read an approved knowledge topic and its verified/planned/unavailable status."""
        return product_facts(topic)

    @function_tool
    async def show_site_section(self, section: str) -> str:
        """Request scrolling to a configured section ID; arbitrary URLs are forbidden."""
        if section not in SECTIONS:
            return "Unknown section. Choose " + ", ".join(SECTIONS) + "."
        await self._room.local_participant.publish_data(
            json.dumps({"section": section}).encode("utf-8"), reliable=True, topic=NAVIGATION_TOPIC,
        )
        return f"Requested the {SECTIONS[section][0]} section. Wait for browser confirmation before claiming it is visible."


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()
    meta = session_metadata(ctx.room.metadata)
    provider = meta["avatarProvider"]
    instructions = make_instructions(provider=provider, seconds=meta["sessionSeconds"])
    session = new_session(instructions)
    site = SiteContext(guest_identity=meta["guestIdentity"])
    pending_acks: set[asyncio.Task] = set()

    async def acknowledge_page(section: str, revision: int) -> None:
        try:
            await ctx.room.local_participant.publish_data(page_ack_payload(section, revision), reliable=True, topic=PAGE_ACK_TOPIC)
        except Exception:
            print("[archava] page acknowledgement failed", flush=True)

    @ctx.room.on("data_received")
    def on_data_received(packet) -> None:
        identity = packet.participant.identity if packet.participant else None
        if site.accept_packet(packet.topic, packet.data, identity):
            task = asyncio.create_task(acknowledge_page(site.section, site.revision))
            pending_acks.add(task)
            task.add_done_callback(pending_acks.discard)

    async def finish_at_deadline() -> None:
        await asyncio.sleep(max(0, meta["endsAt"] - time.time()))
        # The worker enforces expiry even while the API is temporarily offline.
        from livekit import api
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))

    deadline = asyncio.create_task(finish_at_deadline())

    async def cancel_tasks() -> None:
        deadline.cancel()
        for task in pending_acks:
            task.cancel()
        await asyncio.gather(deadline, *pending_acks, return_exceptions=True)

    ctx.add_shutdown_callback(cancel_tasks)

    if provider == "spatius":
        required = [configured(name) for name in ("SPATIUS_API_KEY", "SPATIUS_APP_ID", "SPATIUS_AVATAR_ID")]
        if not all(required):
            raise RuntimeError("Spatius credentials are required")
        avatar = spatius.AvatarSession(api_key=required[0], app_id=required[1], avatar_id=required[2])
        await avatar.start(session, room=ctx.room)
        await avatar.wait_for_join(timeout=20)
    elif provider == "tavus":
        if not configured("TAVUS_API_KEY") or not configured("FACE_ID"):
            raise RuntimeError("TAVUS_API_KEY and FACE_ID are required")
        avatar = tavus.AvatarSession(
            face_id=configured("FACE_ID"), pal_id=configured("PAL_ID") or NOT_GIVEN,
            api_key=configured("TAVUS_API_KEY"),
            conn_options=APIConnectOptions(max_retry=1, retry_interval=0.5, timeout=8),
        )
        await avatar.start(session, room=ctx.room)
        await avatar.wait_for_join(timeout=20)

    await session.start(
        room=ctx.room, agent=ArchavaHost(site, ctx.room, instructions),
        room_options=room_io.RoomOptions(audio_output=False if provider == "spatius" else NOT_GIVEN, close_on_disconnect=True),
    )
    print("[archava] session ready", flush=True)
    session.generate_reply(instructions=f"Greet the visitor briefly as {BRAND['hostName']} from {BRAND['name']} in {BRAND['defaultLanguage']}.")


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
