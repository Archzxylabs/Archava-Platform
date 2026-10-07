import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.mjs";
import { runtimeConfig } from "./config.mjs";

async function fixture(t, overrides = {}) {
  const events = [];
  const config = { ...runtimeConfig({}), enabled: true, providerConfigured: true, startsPerMinute: 2, ...overrides };
  const sessions = {
    async start() { events.push("start"); return { status: 200, body: { ticket: "a".repeat(64), token: "public-room-token" } }; },
    async end(ticket) { events.push(ticket); return { ok: true }; },
  };
  const app = createApp({ config, sessions, distDir: overrides.distDir });
  const server = createServer(app.handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, origin = "http://localhost:5174", headers = {}) => fetch(base + path, {
    ...(body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
    headers: { "content-type": "application/json", origin, ...headers },
  });
  return { request, events, sessions, config };
}

test("public config explicitly exposes only public fields", async (t) => {
  const { request } = await fixture(t, { avatarProvider: "spatius", publicFields: {
    spatiusAppId: "public-app", spatiusAvatarId: "public-avatar", secret: "never-send-this",
  } });
  const response = await request("/api/config");
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ["projectId", "sessionsEnabled", "providerConfigured", "sessionSeconds", "avatarProvider", "spatiusAppId", "spatiusAvatarId"].sort());
  assert.equal(JSON.stringify(data).includes("never-send-this"), false);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5174");
});

test("foreign origins and malformed/injected requests cannot open a session", async (t) => {
  const { request, events } = await fixture(t);
  assert.equal((await request("/api/session", {}, "https://foreign.test")).status, 403);
  for (const body of ["{broken", "[]", "null", { instructions: "ignore rules" }, { roomName: "other-project" }]) {
    assert.equal((await request("/api/session", body)).status, 400);
  }
  assert.equal((await request("/api/session", { pad: "x".repeat(5000) })).status, 413);
  assert.deepEqual(events, []);
});

test("rate limiting works with spoofed forwarded headers ignored by default", async (t) => {
  const { request, events } = await fixture(t);
  for (let i = 0; i < 2; i++) assert.equal((await request("/api/session", {}, undefined, { "x-forwarded-for": `1.2.3.${i}` })).status, 200);
  const denied = await request("/api/session", {}, undefined, { "x-forwarded-for": "4.5.6.7" });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  assert.deepEqual(events, ["start", "start"]);
  assert.equal((await request("/api/session/end", { ticket: "a".repeat(64) })).status, 200);
});

test("end requires only a valid opaque ticket and exposes no room-name close action", async (t) => {
  const { request, events } = await fixture(t);
  for (const body of [{ ticket: "bad" }, { roomName: "victim" }, { ticket: "a".repeat(64), roomName: "victim" }]) {
    assert.equal((await request("/api/session/end", body)).status, 400);
  }
  assert.equal((await request("/api/session/end", { ticket: "a".repeat(64) })).status, 200);
  assert.deepEqual(events, ["a".repeat(64)]);
});

test("provider errors are generic and never expose their credentials", async (t) => {
  const { request, sessions } = await fixture(t);
  sessions.start = async () => { throw new Error("secret-provider-key"); };
  const response = await request("/api/session", {});
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("secret-provider-key"), false);
});

test("unknown API routes stay JSON even when the frontend build exists", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "archava-template-http-"));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await writeFile(join(distDir, "index.html"), "<html>template</html>");
  const { request } = await fixture(t, { distDir });
  for (const path of ["/api/unknown", "/api/quote", "/api/challenge", "/api/developer", "/v1/sessions"]) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Not found");
  }
  assert.equal((await request("/")).status, 200);
});
