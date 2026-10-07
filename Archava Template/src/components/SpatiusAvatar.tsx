import { useEffect, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { AvatarView } from "@spatius/avatarkit";
import { AvatarPlayer, LiveKitProvider } from "@spatius/avatarkit-rtc";
import { type AvatarSession } from "../lib/session";
import { prepareSpatiusAvatar } from "../lib/spatius";

import { project } from "../lib/project";

interface SpatiusAvatarProps {
  session: AvatarSession;
  onError: (message: string) => void;
}

export function SpatiusAvatar({ session, onError }: SpatiusAvatarProps) {
  const room = useRoomContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let connectionAttempted = false;
    let disposed = false;
    let view: AvatarView | undefined;
    let player: AvatarPlayer | undefined;

    const start = async () => {
      const avatar = await prepareSpatiusAvatar(session.spatiusAppId || "", session.spatiusAvatarId || "");
      if (cancelled || !containerRef.current) return;

      containerRef.current.replaceChildren();
      view = new AvatarView(avatar, containerRef.current);
      view.onFirstRendering = () => { if (!cancelled) setReady(true); };
      player = new AvatarPlayer(new LiveKitProvider(), view);
      await player.attach(room);
      if (cancelled) return;

      connectionAttempted = true;
      await room.connect(session.serverUrl, session.token);
      if (cancelled) return;
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (micError) {
        console.warn("Could not auto-enable microphone:", micError);
      }
    };

    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      await player?.detach().catch(() => {});
      if (connectionAttempted) await room.disconnect().catch(() => {});
      view?.dispose();
    };

    const startup = start().catch(async (cause: unknown) => {
      await dispose();
      if (!cancelled) {
        const message = cause instanceof Error ? cause.message : "Could not display the Spatius avatar.";
        setError(message);
        onError(message);
      }
    });
    return () => {
      cancelled = true;
      void startup.then(dispose);
    };
  }, [room, session.serverUrl, session.token, session.spatiusAppId, session.spatiusAvatarId, onError]);

  return (
    <div className="spatius-avatar-surface">
      <div className="spatius-avatar-canvas" ref={containerRef} />
      {(!ready || error) && (
        <div className="spatius-avatar-status" role={error ? "alert" : "status"}>
          <span className="live-pulse-dot" />
          <span>{error || `Preparing ${project.brand.hostName}'s live avatar…`}</span>
        </div>
      )}
    </div>
  );
}
