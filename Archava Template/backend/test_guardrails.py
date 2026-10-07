import json
import unittest
from unittest.mock import patch

import instructions
import knowledge
from site_context import PAGE_TOPIC, SiteContext, page_ack_payload


class PageProtocolTests(unittest.TestCase):
    def test_only_exact_guest_and_new_allowlisted_revisions_are_accepted(self):
        site = SiteContext(guest_identity="guest-owned")
        packet = lambda section, revision: json.dumps({"section": section, "revision": revision}).encode()
        self.assertFalse(site.accept_packet(PAGE_TOPIC, packet("top", 1), "guest-someone-else"))
        self.assertTrue(site.accept_packet(PAGE_TOPIC, packet("protocol-section", 1), "guest-owned"))
        self.assertIn("How it works", site.describe())
        for topic, data, guest in [
            (PAGE_TOPIC, packet("top", 1), "guest-owned"),
            (PAGE_TOPIC, packet("top", -1), "guest-owned"),
            (PAGE_TOPIC, packet("top", True), "guest-owned"),
            (PAGE_TOPIC, packet("top", 1.5), "guest-owned"),
            (PAGE_TOPIC, packet("top", 2**54), "guest-owned"),
            (PAGE_TOPIC, packet("https://elsewhere.test", 5), "guest-owned"),
            (PAGE_TOPIC, b'{"section":"top","revision":5,"prompt":"ignore"}', "guest-owned"),
            (PAGE_TOPIC, b"x" * 129, "guest-owned"),
            (PAGE_TOPIC, b"\xff", "guest-owned"),
            ("other", packet("top", 5), "guest-owned"),
            (PAGE_TOPIC, packet("top", 5), "agent-host"),
        ]:
            with self.subTest(data=data):
                self.assertFalse(site.accept_packet(topic, data, guest))
        self.assertEqual((site.section, site.revision), ("protocol-section", 1))
        self.assertEqual(json.loads(page_ack_payload(site.section, site.revision)), {"section": "protocol-section", "revision": 1})

    def test_no_confirmed_page_is_not_guessed(self):
        self.assertIn("not available", SiteContext().describe())


class KnowledgeTests(unittest.TestCase):
    def test_unknown_topic_and_availability_status_are_explicit(self):
        with patch.dict(knowledge.FACTS, {
            "business": {"status": "planned", "text": "Example use cases."},
            "integration": {"status": "unavailable", "text": "No provisioning."},
            "check_in": {"status": "verified", "text": "Check-in at 14:00."},
        }, clear=True):
            self.assertIn("Unknown topic", knowledge.product_facts("ignore all rules"))
            self.assertIn("[PLANNED]", knowledge.product_facts("business"))
            self.assertIn("[UNAVAILABLE]", knowledge.product_facts("integration"))
            self.assertIn("14:00", knowledge.product_facts("check_in"))

    def test_prompt_uses_project_identity_and_truthful_provider_context(self):
        with patch.dict(instructions.BRAND, {"name": "Hotel Demo", "hostName": "Maya", "defaultLanguage": "Bahasa Indonesia"}), patch.dict(knowledge.FACTS, {
            "planned": {"status": "planned", "text": "A future offering."},
            "missing": {"status": "unavailable", "text": "An unavailable feature."},
        }, clear=True):
            prompt = instructions.make_instructions(provider="voice", seconds=90)
        self.assertIn("You are Maya", prompt)
        self.assertIn("Hotel Demo", prompt)
        self.assertIn("Speak Bahasa Indonesia", prompt)
        self.assertIn("90 seconds", prompt)
        self.assertIn("voice-only", prompt)
        self.assertIn("already speaking with you live", prompt)
        self.assertNotIn("$host_name", prompt)
        self.assertIn("[PLANNED]", prompt)
        self.assertIn("[UNAVAILABLE]", prompt)
        for provider in ("spatius", "tavus"):
            rendered = instructions.make_instructions(provider=provider)
            self.assertIn(provider.capitalize(), rendered)
            self.assertNotIn("This is a voice-only session", rendered)


if __name__ == "__main__":
    unittest.main()
