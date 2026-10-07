import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new RequestError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
    return body;
  } catch { throw new RequestError(400, "Expected a JSON object"); }
}

export function createApp({ config, sessions, distDir, now = Date.now }) {
  const rateBuckets = new Map();
  const allowedOrigins = new Set(config.origins);
  function respond(res, status, body, origin, headers = {}) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store", "x-content-type-options": "nosniff",
      vary: "Origin",
      ...(allowedOrigins.has(origin) ? { "access-control-allow-origin": origin } : {}),
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  function pruneRateBuckets() {
    for (const [key, times] of rateBuckets) {
      const recent = times.filter((time) => now() - time < 60_000);
      if (recent.length) rateBuckets.set(key, recent);
      else rateBuckets.delete(key);
    }
  }

  function allowStart(req) {
    const forwarded = req.headers["x-forwarded-for"];
    const key = config.trustProxy && typeof forwarded === "string"
      ? forwarded.split(",")[0].trim() : req.socket.remoteAddress || "unknown";
    const times = (rateBuckets.get(key) || []).filter((time) => now() - time < 60_000);
    if (times.length >= config.startsPerMinute) return false;
    times.push(now());
    rateBuckets.set(key, times);
    return true;
  }

  async function serveStatic(pathname, res) {
    if (!distDir) return false;
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw new RequestError(400, "Invalid path"); }
    const path = resolve(distDir, "." + decoded);
    if (path !== distDir && !path.startsWith(distDir + sep)) return false;
    const file = pathname === "/" || !extname(path) ? resolve(distDir, "index.html") : path;
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".webp": "image/webp", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": types[extname(file)] || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      });
      res.end(body);
      return true;
    } catch (error) {
      if (["ENOENT", "EISDIR"].includes(error.code)) return false;
      throw error;
    }
  }

  async function handle(req, res) {
    const origin = req.headers.origin || "";
    try {
      if (origin && !allowedOrigins.has(origin)) return respond(res, 403, { error: "Origin not allowed" }, origin);
      const path = new URL(req.url || "/", "http://localhost").pathname;
      if (req.method === "OPTIONS") return respond(res, 204, null, origin, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      if (req.method === "GET" && path === "/api/health") return respond(res, 200, { ok: true }, origin);
      if (req.method === "GET" && path === "/api/config") return respond(res, 200, {
        projectId: config.projectId,
        sessionsEnabled: config.enabled,
        providerConfigured: config.providerConfigured,
        sessionSeconds: config.seconds,
        avatarProvider: config.avatarProvider,
        ...(config.avatarProvider === "spatius" ? {
          spatiusAppId: config.publicFields.spatiusAppId,
          spatiusAvatarId: config.publicFields.spatiusAvatarId,
        } : {}),
      }, origin);
      if (req.method === "POST" && path === "/api/session") {
        const body = await readJson(req);
        if (Object.keys(body).length) throw new RequestError(400, "Session creation accepts an empty object only");
        if (!allowStart(req)) return respond(res, 429, { error: "Too many conversation attempts. Try again in a minute." }, origin, { "retry-after": "60" });
        const result = await sessions.start();
        return respond(res, result.status, result.body, origin);
      }
      if (req.method === "POST" && path === "/api/session/end") {
        const body = await readJson(req);
        if (Object.keys(body).length !== 1 || typeof body.ticket !== "string" || !/^[a-f0-9]{64}$/.test(body.ticket)) {
          throw new RequestError(400, "Invalid session ticket");
        }
        return respond(res, 200, await sessions.end(body.ticket), origin);
      }
      // Unknown API routes always return JSON, including former product routes.
      if (path === "/api" || path.startsWith("/api/") || path === "/v1" || path.startsWith("/v1/")) return respond(res, 404, { error: "Not found" }, origin);
      if (req.method === "GET" && await serveStatic(path, res)) return;
      return respond(res, 404, { error: "Not found" }, origin);
    } catch (error) {
      if (error instanceof RequestError) return respond(res, error.status, { error: error.message }, origin);
      // Provider errors may contain tokens or URLs. Keep public errors generic.
      console.error("[archava] request failed:", error?.name || "Error");
      return respond(res, 503, { error: "The live service is temporarily unavailable. Please try again." }, origin);
    }
  }

  return { handle, pruneRateBuckets };
}
