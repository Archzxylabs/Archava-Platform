import { ArrowUpRight, Mic, X } from "lucide-react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { LiveRoom } from "./LiveRoom";
import type { AvatarSession } from "../lib/session";
import { project } from "../lib/project";

interface Props {
  session: AvatarSession | null;
  available: boolean;
  loading: boolean;
  error: string;
  onStart: () => void;
  onClose: () => void;
  onClearError: () => void;
  onSessionError: (message: string) => void;
}

export function AvatarCatalog({ session, available, loading, error, onStart, onClose, onClearError, onSessionError }: Props) {
  return (
    <section className="avatar-catalog-section" id="catalog-section">
      <div className="catalog-grid-container">
        <div className="catalog-left-col" data-reveal>
          <div className="brand-massive-row"><h2 className="catalog-brand-title">{project.brand.name}<span className="brand-period">.</span></h2></div>
          <span className="catalog-chapter-label">01 / THE LIVE EXPERIENCE</span>
          <h3 className="catalog-chapter-title">Meet the face behind the voice.</h3>
          <p className="catalog-statement-p">{project.brand.heroBody}</p>
          {!session && <div className="catalog-demo-entry">
            <button type="button" className="catalog-demo-btn" onClick={onStart} disabled={!available || loading}>
              <Mic size={16} /><span>{loading ? "Preparing your conversation…" : available ? `Talk to ${project.brand.hostName}` : "Live host currently offline"}</span><ArrowUpRight size={16} />
            </button>
            <span>Your microphone starts only when you choose to talk.</span>
          </div>}
          <p className="catalog-concept-note">Portraits are concept artwork. Live sessions use your project's configured voice or avatar provider.</p>
          <a className="catalog-business-link" href="#business-section"><span>For your business</span><strong>Explore the possibilities <ArrowUpRight size={14} /></strong></a>
        </div>
        <div className="catalog-right-col" data-reveal>
          {session ? <div className="catalog-live-session-wrapper">
            <LiveKitRoom token={session.token} serverUrl={session.serverUrl}
              connect={session.avatarProvider !== "spatius"} audio video={false}
              options={session.avatarProvider === "spatius" ? { singlePeerConnection: false } : undefined}
              onDisconnected={onClose} onError={() => onSessionError("The live connection failed. Please try again.")} className="livekit-root-shell">
              <RoomAudioRenderer /><LiveRoom session={session} onClose={onClose} onError={onSessionError} />
            </LiveKitRoom>
          </div> : <div className="catalog-cards-carousel">
            {[project.assets.portraitOne, project.assets.portraitTwo].map((src, index) => <div key={src} className={`catalog-avatar-card ${index ? "card-pink" : "card-cyan"}`}>
              <img src={src} alt="Illustrative AI avatar concept" className="card-bg-img" />
              <div className="card-image-shade" />
              <span className="frost-overlay-tag bottom-left"><span className="tag-title">{index ? "A voice that guides" : "A presence that listens"}</span><span className="tag-subtitle">Concept artwork</span></span>
            </div>)}
          </div>}
          {error && <div className="catalog-alert error" role="alert"><span>{error}</span><button type="button" onClick={onClearError} aria-label="Dismiss error"><X size={14} /></button></div>}
        </div>
      </div>
    </section>
  );
}
