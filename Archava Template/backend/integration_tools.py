"""SDK-level integration tests use fakes and never open a paid provider call."""

import json
import os
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

from agent import ArchavaHost, session_metadata
import knowledge
from config import PROJECT_ID
from instructions import make_instructions
from site_context import NAVIGATION_TOPIC, SiteContext


class HostToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_navigation_cannot_open_an_arbitrary_url(self):
        room = Mock()
        room.local_participant.publish_data = AsyncMock()
        host = ArchavaHost(SiteContext(), room, make_instructions())
        self.assertIn("Unknown section", await host.show_site_section("https://elsewhere.test"))
        room.local_participant.publish_data.assert_not_awaited()
        self.assertIn("Requested", await host.show_site_section("business-section"))
        args, kwargs = room.local_participant.publish_data.await_args
        self.assertEqual(json.loads(args[0]), {"section": "business-section"})
        self.assertEqual(kwargs["topic"], NAVIGATION_TOPIC)
        with patch.dict(knowledge.FACTS, {"example": {"status": "planned", "text": "An example offering."}}):
            self.assertIn("[PLANNED]", await host.get_product_facts("example"))
        self.assertIn("not available", await host.get_current_page())

    def test_worker_rejects_wrong_project_or_provider_metadata(self):
        metadata = {"product": "archava-template", "projectId": PROJECT_ID, "guestIdentity": "guest-owned", "avatarProvider": "voice", "sessionSeconds": 120, "endsAt": int(time.time()) + 120}
        with patch.dict(os.environ, {"AVATAR_PROVIDER": "voice"}):
            self.assertEqual(session_metadata(json.dumps(metadata)), metadata)
            for overrides in [{"projectId": "other-project"}, {"avatarProvider": "spatius"}, {"guestIdentity": "agent-host"}, {"endsAt": 0}, {"sessionSeconds": True}]:
                with self.subTest(overrides=overrides):
                    with self.assertRaises(ValueError):
                        session_metadata(json.dumps({**metadata, **overrides}))
            for malformed in ("[]", "null", "not-json"):
                with self.assertRaises(ValueError):
                    session_metadata(malformed)


if __name__ == "__main__":
    unittest.main()
