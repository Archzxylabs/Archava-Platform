import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Volume2, VolumeX } from "lucide-react";
import { sounds } from "../lib/sound";
import { project } from "../lib/project";

interface Props {
  available: boolean;
  loading: boolean;
  inCall: boolean;
  onStart: () => void;
}

export function VideoHero({ available, loading, inCall, onStart }: Props) {
  const canvas = useRef<HTMLDivElement>(null);
  const [soundActive, setSoundActive] = useState(sounds.isEnabled());
  const explore = () => document.getElementById("catalog-section")?.scrollIntoView({ behavior: "smooth" });
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => canvas.current?.style.setProperty("--hero-parallax", `${Math.min(window.scrollY, 700) * 0.11}px`));
    };
    window.addEventListener("scroll", update, { passive: true });
    return () => { window.removeEventListener("scroll", update); cancelAnimationFrame(frame); };
  }, []);
  return (
    <section className="video-hero-root" id="top">
      <div className="video-hero-canvas" ref={canvas}>
        <picture className="hero-picture">
          <source media="(max-width: 520px)" srcSet={project.assets.heroMobile} />
          <img src={project.assets.hero} alt="Illustrative AI avatar portrait" className="hero-bg-image" />
        </picture>
        <div className="hero-technical-overlay" aria-hidden="true"><div className="hero-grid-lines" /><div className="hero-fibonacci-arc" /><div className="hero-crosshair-center">+</div></div>
        <header className="hero-navbar">
          <nav className="nav-left-links" aria-label="Main navigation">
            {project.sections.map((section) => <a key={section.id} href={`#${section.id}`} className="nav-item">{section.label}</a>)}
          </nav>
          <div className="nav-right-actions">
            <button type="button" className={`nav-round-btn${soundActive ? " active" : ""}`} onClick={() => setSoundActive(sounds.toggle())} aria-label={soundActive ? "Mute interface sounds" : "Enable interface sounds"}>
              {soundActive ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </button>
            <span className="template-brand">{project.brand.name}</span>
          </div>
        </header>
        <nav className="hero-section-jump" aria-label="Jump to a section">
          {project.sections.slice(1).map((section) => <a key={section.id} className="hero-jump-link" href={`#${section.id}`}>{section.label}</a>)}
        </nav>
        <div className="hero-left-hud">
          <span className="hud-sub-label">{project.brand.name.toUpperCase()} / LIVE AI HOST</span>
          <div className="hud-empower-box">
            <h2 className="hud-headline">{project.brand.tagline}</h2>
            <button type="button" className="hud-next-btn" onClick={explore}><span>Meet the host</span><span className="next-bar" /></button>
          </div>
        </div>
        <div className="hero-bottom-left-card"><div className="glass-card-inner">
          <div className="card-top-icon-row"><span className="brand-mark-circle"><span className="cut-pie" /></span><span className="card-tag">{project.brand.name.toUpperCase()} // 01</span></div>
          <p className="card-body-text">{project.brand.heroBody}</p>
        </div></div>
        <div className="hero-center-typography">
          <h1 className="hero-massive-title"><span>TALK TO</span><span>{project.brand.hostName.toUpperCase()}.</span></h1>
          <span className="hero-sub-kicker">{project.brand.name.toUpperCase()} / A CONVERSATION WITH PRESENCE</span>
        </div>
        <button type="button" className="hero-right-circle-widget" onClick={explore} aria-label="Explore the host">
          <span className="circle-inner-image"><img src={project.assets.portraitTwo} alt="" /><span className="circle-text-overlay">Meet {project.brand.hostName}</span></span>
          <span className="circle-arrow-badge"><ArrowUpRight size={16} /></span>
        </button>
        <div className="hero-cta-stack">
          <button type="button" className="hero-neon-pill-btn" onClick={available && !inCall ? onStart : explore} disabled={loading}>
            <span>{loading ? "Preparing your conversation…" : inCall ? "Return to conversation" : available ? `Talk to ${project.brand.hostName}` : "Explore the host"}</span><ArrowUpRight size={16} />
          </button>
          <span className="hero-preview-hint">{inCall ? "Your conversation is running below" : available ? "Live conversation · allow your microphone" : "Live conversation is currently offline"}</span>
        </div>
        <span className="hero-disclosure-label">AI-GENERATED VISUALS · {project.brand.name.toUpperCase()}</span>
      </div>
    </section>
  );
}
