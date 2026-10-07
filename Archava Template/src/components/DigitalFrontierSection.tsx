import { ArrowUpRight, AudioLines, Mic, MousePointer2 } from "lucide-react";
import { project } from "../lib/project";
import { sounds } from "../lib/sound";

const steps = [
  {
    number: "01",
    icon: MousePointer2,
    title: "Open",
    detail: "Tap the conversation button when the live host is available.",
  },
  {
    number: "02",
    icon: Mic,
    title: "Allow audio",
    detail: "Allow your microphone so the host can hear your questions.",
  },
  {
    number: "03",
    icon: AudioLines,
    title: "Converse",
    detail: "Speak with the avatar through a live audio and video session.",
  },
] as const;

const headlineLines = [
  ["Presence", "you", "can", "feel."],
  ["Answers", "you", "can", "use."],
];

export function DigitalFrontierSection() {
  return (
    <section className="digital-frontier-section" id="protocol-section">
      <div className="frontier-cad-grid" aria-hidden="true" />
      <div className="frontier-fibonacci-curve" aria-hidden="true" />

      <div className="frontier-container">
        <div className="frontier-heading-wrapper" data-reveal>
          <span className="frontier-section-label">HOW THE CONVERSATION WORKS / 001</span>
          <h2 className="frontier-main-title" aria-label="Presence you can feel. Answers you can use.">
            {headlineLines.map((line, lineIndex) => (
              <span className="frontier-title-line" aria-hidden="true" key={lineIndex}>
                {line.map((word, wordIndex) => (
                  <span
                    className="frontier-title-word"
                    style={{ transitionDelay: `${140 + (lineIndex * 4 + wordIndex) * 90}ms` }}
                    key={wordIndex}
                  >{word}</span>
                ))}
              </span>
            ))}
          </h2>
          <div className="frontier-reflected-title" aria-hidden="true">
            Presence you can feel.<br />Answers you can use.
          </div>
        </div>

        <div className="frontier-split-row">
          <div className="frontier-left-col" data-reveal>
            <span className="frontier-kicker">FROM HELLO TO CONVERSATION</span>
            <div className="frontier-team-cards">
              {steps.map((step) => {
                const Icon = step.icon;
                return (
                  <div key={step.number} className="team-item">
                    <div className="team-portrait-circle"><Icon size={28} strokeWidth={1.5} /></div>
                    <div className="team-meta">
                      <span className="step-number">{step.number} / 03</span>
                      <h3 className="team-name">{step.title}</h3>
                      <p className="team-role">{step.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <a
              href="#catalog-section"
              className="story-pill-btn"
              onClick={() => sounds.playClick()}
            >
              Explore the avatar <ArrowUpRight size={15} />
            </a>

            <div className="frontier-follow-box">
              <span className="follow-label">POWERED BY</span>
              <div className="follow-icons-row" aria-label="Technology stack">
                <span className="social-badge">Gemini</span>
                <span className="social-badge">Avatar engine</span>
                <span className="social-badge">LiveKit</span>
              </div>
            </div>
          </div>

          <div className="frontier-right-col" data-reveal>
            <div className="chrome-avatar-portal">
              <img src={project.assets.workflow} alt="Chrome AI avatar concept artwork" className="chrome-portal-image" />
              <div className="portal-cad-rings" aria-hidden="true" />
            </div>
            <p className="frontier-explanation-p">
              Open a conversation, allow your microphone, and speak naturally. The host answers from approved knowledge and can guide you through the website.
            </p>
            <p className="frontier-disclosure">Portraits on this page are concept artwork. Live sessions use the configured AI voice or avatar provider.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
