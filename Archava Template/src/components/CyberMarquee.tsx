import { project } from "../lib/project";

export function CyberMarquee() {
  const items = [
    "AI AVATAR ON DEMAND",
    "LIVE CONVERSATION",
    "APPROVED KNOWLEDGE",
    "PAGE-AWARE GUIDANCE",
    "GEMINI REALTIME VOICE",
    "REALTIME AVATAR",
    "LIVEKIT TRANSPORT",
    project.brand.name.toUpperCase(),
  ];

  return (
    <div className="cyber-marquee-bar" aria-hidden="true">
      <div className="marquee-content-loop">
        {[...items, ...items].map((text, i) => (
          <div key={i} className="marquee-unit">
            <span className="unit-label">{text}</span>
            <span className="unit-arrow">◄►</span>
          </div>
        ))}
      </div>
    </div>
  );
}
