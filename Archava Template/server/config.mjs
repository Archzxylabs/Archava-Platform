import { readFileSync } from "node:fs";

export const project = JSON.parse(readFileSync(new URL("../config/project.json", import.meta.url), "utf8"));

export function integer(value, fallback, min, max, name) {
  const result = Number(value || fallback);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return result;
}

export function configured(value) {
  return typeof value === "string" && value.trim() && !/your[-_]|example\./i.test(value);
}

export function runtimeConfig(env = process.env) {
  const projectId = env.PROJECT_ID || project.projectId;
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(projectId)) throw new Error("PROJECT_ID must be a 3–48 character lowercase slug");
  const avatarProvider = env.AVATAR_PROVIDER || "spatius";
  if (!["spatius", "tavus", "voice"].includes(avatarProvider)) throw new Error("AVATAR_PROVIDER must be spatius, tavus, or voice");
  const origins = (env.WEB_ORIGIN || "http://localhost:5174").split(",").map((value) => value.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("WEB_ORIGIN must contain exact HTTP(S) origins without trailing slashes");
  }
  const livekitConfigured = [env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET].every(configured);
  if (configured(env.LIVEKIT_URL) && !/^wss?:\/\//.test(env.LIVEKIT_URL)) throw new Error("LIVEKIT_URL must use ws:// or wss://");
  const providerConfigured = Boolean(livekitConfigured && configured(env.GEMINI_API_KEY) && (
    avatarProvider === "voice" || (avatarProvider === "spatius"
      ? [env.SPATIUS_API_KEY, env.SPATIUS_APP_ID, env.SPATIUS_AVATAR_ID].every(configured)
      : [env.TAVUS_API_KEY, env.FACE_ID].every(configured))
  ));
  const agentName = env.ARCHAVA_AGENT_NAME?.trim() || `${projectId}-host`;
  return {
    projectId, avatarProvider, origins, livekitConfigured, providerConfigured, agentName,
    enabled: env.ENABLE_SESSIONS === "true",
    trustProxy: env.TRUST_PROXY === "true",
    port: integer(env.PORT, 5002, 1, 65535, "PORT"),
    seconds: integer(env.SESSION_SECONDS, 120, 30, 1800, "SESSION_SECONDS"),
    maxActive: integer(env.MAX_ACTIVE_SESSIONS, 10, 1, 100, "MAX_ACTIVE_SESSIONS"),
    startsPerMinute: integer(env.SESSION_STARTS_PER_MINUTE, 3, 1, 60, "SESSION_STARTS_PER_MINUTE"),
    publicFields: {
      serverUrl: env.LIVEKIT_URL || "",
      avatarProvider,
      ...(avatarProvider === "spatius" ? { spatiusAppId: env.SPATIUS_APP_ID || "", spatiusAvatarId: env.SPATIUS_AVATAR_ID || "" } : {}),
    },
  };
}
