import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, X } from "lucide-react";
import { apiUrl, canStartSession, endAvatarSession, getConfig, sessionErrorMessage, startAvatarSession, supportsAvatarRendering, type AppConfig, type AvatarSession } from "./lib/session";
import { project } from "./lib/project";
import { useScrollReveal } from "./lib/motion";
import { VideoHero } from "./components/VideoHero";
import { CyberMarquee } from "./components/CyberMarquee";
import { AvatarCatalog } from "./components/AvatarCatalog";
import { DigitalFrontierSection } from "./components/DigitalFrontierSection";
import { BusinessSection } from "./components/BusinessSection";

async function prepareAvatar(config: AppConfig | null): Promise<void> {
  if (config?.avatarProvider !== "spatius") return;
  const { prepareSpatiusAvatar } = await import("./lib/spatius");
  await prepareSpatiusAvatar(config.spatiusAppId || "", config.spatiusAvatarId || "");
}

export default function App() {
  useScrollReveal();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [session, setSession] = useState<AvatarSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  const opening = useRef(false);
  const activeSession = useRef<AvatarSession | null>(null);
  const available = canStartSession(config);

  useEffect(() => {
    document.title = `${project.brand.name} — Talk to ${project.brand.hostName}`;
    let disposed = false;
    const refresh = () => void getConfig().then((value) => {
      if (disposed) return;
      setConfig(value);
      // Match the original Archava warm-up: fetch and cache avatar assets while
      // the visitor reads the page. No microphone or LiveKit room is opened.
      if (value.avatarProvider === "spatius" && supportsAvatarRendering(value)
        && value.spatiusAppId && value.spatiusAvatarId) {
        void prepareAvatar(value).catch(() => {});
      }
    }).catch(() => { if (!disposed) setConfig(null); });
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const onPageHide = () => {
      const active = activeSession.current;
      if (active) navigator.sendBeacon(apiUrl("/api/session/end"), new Blob([JSON.stringify({ ticket: active.ticket })], { type: "application/json" }));
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const closeSession = useCallback(() => {
    const active = activeSession.current;
    if (!active) return;
    activeSession.current = null;
    setSession(null);
    setEnded(true);
    void endAvatarSession(active.ticket).catch(() => {});
  }, []);

  const onSessionError = useCallback((message: string) => {
    setError(message);
    closeSession();
  }, [closeSession]);

  const start = async () => {
    if (!available || opening.current || activeSession.current) return;
    opening.current = true;
    setLoading(true);
    setError("");
    setEnded(false);
    try {
      if (!supportsAvatarRendering(config)) throw new Error("This browser cannot display the live avatar. Try a recent Chrome or Edge browser.");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires HTTPS or localhost and a supported browser.");
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphone.getTracks().forEach((track) => track.stop());
      await prepareAvatar(config);
      const next = await startAvatarSession();
      activeSession.current = next;
      setSession(next);
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Allow microphone access in your browser to start a conversation." : sessionErrorMessage(cause));
    } finally {
      opening.current = false;
      setLoading(false);
      document.getElementById("catalog-section")?.scrollIntoView({ behavior: "smooth" });
    }
  };

  return <div className="archava-site-root">
    <VideoHero available={available} loading={loading} inCall={Boolean(session)} onStart={() => void start()} />
    <CyberMarquee />
    <AvatarCatalog session={session} available={available} loading={loading} error={error} onStart={() => void start()} onClose={closeSession} onClearError={() => setError("")} onSessionError={onSessionError} />
    {ended && !session && <section className="post-call-panel" aria-label="After your conversation"><div className="post-call-inner">
      <div className="post-call-head"><span className="post-call-eyebrow">CONVERSATION ENDED</span><button type="button" className="post-call-dismiss" onClick={() => setEnded(false)} aria-label="Dismiss"><X size={14} /></button></div>
      <h2 className="post-call-title">Thanks for talking to {project.brand.hostName}.</h2>
      <div className="post-call-actions"><button type="button" className="post-call-btn primary" disabled={!available || loading} onClick={() => void start()}><Mic size={15} />Talk again</button><a className="post-call-btn" href="#business-section">For business</a></div>
    </div></section>}
    <DigitalFrontierSection />
    <BusinessSection contactHref={project.brand.contactUrl} previewEnabled={available && !session && !loading} onTryPreview={() => void start()} />
  </div>;
}
