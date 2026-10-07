import { ApiError } from "./apiError";

export type AvatarProvider = "spatius" | "tavus" | "voice";
export interface AppConfig {
  projectId: string;
  sessionsEnabled: boolean;
  providerConfigured: boolean;
  sessionSeconds: number;
  avatarProvider: AvatarProvider;
  spatiusAppId?: string;
  spatiusAvatarId?: string;
}
export interface AvatarSession {
  serverUrl: string;
  token: string;
  endsAt: number;
  ticket: string;
  avatarProvider: AvatarProvider;
  spatiusAppId?: string;
  spatiusAvatarId?: string;
}

const base = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
export const apiUrl = (path: string) => base + path;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...(body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new ApiError(response.status, data?.error || "The live service is unavailable. Please try again.");
  }
  return data as T;
}

export const getConfig = () => api<AppConfig>("/api/config");
export const startAvatarSession = () => api<AvatarSession>("/api/session", {});
export const endAvatarSession = (ticket: string) => api<{ ok: boolean }>("/api/session/end", { ticket });
export const canStartSession = (config: AppConfig | null) => Boolean(config?.sessionsEnabled && config.providerConfigured);
export const supportsAvatarRendering = (config: AppConfig | null) =>
  config?.avatarProvider !== "spatius" || "RTCRtpScriptTransform" in globalThis;

export function sessionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Could not open the conversation. Please try again.";
}
