import assert from "node:assert/strict";
import test from "node:test";
import { createSessions } from "./sessions.mjs";

const config = {
  enabled: true, providerConfigured: true, seconds: 120, maxActive: 1,
  publicFields: { serverUrl: "wss://unit.test", avatarProvider: "voice" },
};

test("disabled or unconfigured sessions never allocate a provider room", async () => {
  let opened = 0;
  const rooms = { async open() { opened++; } };
  for (const overrides of [{ enabled: false }, { providerConfigured: false }]) {
    const sessions = createSessions({ rooms, config: { ...config, ...overrides } });
    assert.ok((await sessions.start()).status >= 400);
  }
  assert.equal(opened, 0);
});

test("concurrent requests count pending room creation toward the capacity", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const sessions = createSessions({ config, rooms: {
    async open() { await barrier; return { roomName: "one", token: "token" }; },
    async deleteRoom() {}, async sweep() {},
  } });
  const first = sessions.start();
  assert.equal((await sessions.start()).status, 429);
  release();
  assert.equal((await first).status, 200);
});

test("provider failure releases admission so the next attempt can succeed", async () => {
  let calls = 0;
  const sessions = createSessions({ config, rooms: { async open() {
    if (++calls === 1) throw new Error("provider failed");
    return { roomName: "working", token: "token" };
  } } });
  await assert.rejects(sessions.start(), /provider failed/);
  assert.equal((await sessions.start()).status, 200);
});

test("end is ticket-bound, idempotent, and does not discard a failed cleanup", async () => {
  const deleted = [];
  let fail = true;
  const sessions = createSessions({ config, newTicket: () => "a".repeat(64), rooms: {
    async open() { return { roomName: "owned-room", token: "token" }; },
    async deleteRoom(name) { if (fail) throw new Error("temporary"); deleted.push(name); },
  } });
  const result = await sessions.start();
  await sessions.end("b".repeat(64));
  assert.deepEqual(deleted, []);
  await assert.rejects(sessions.end(result.body.ticket), /temporary/);
  assert.equal((await sessions.start()).status, 429);
  fail = false;
  await sessions.end(result.body.ticket);
  await sessions.end(result.body.ticket);
  assert.deepEqual(deleted, ["owned-room"]);
  assert.equal((await sessions.start()).status, 200);
});

test("deadline cleanup closes tickets and asks the provider to recover abandoned rooms", async () => {
  let clock = 1_000_000;
  const deleted = [];
  let swept = 0;
  const sessions = createSessions({ config, now: () => clock, rooms: {
    async open() { return { roomName: "expiring", token: "token" }; },
    async deleteRoom(name) { deleted.push(name); }, async sweep() { swept++; },
  } });
  const result = await sessions.start();
  assert.equal(result.body.endsAt, 1120);
  clock += 120_000;
  await sessions.sweep();
  assert.deepEqual(deleted, ["expiring"]);
  assert.equal(swept, 1);
});

test("shutdown also closes a room whose creation is still in flight", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const deleted = [];
  const sessions = createSessions({ config, rooms: {
    async open() { await barrier; return { roomName: "late-room", token: "token" }; },
    async deleteRoom(name) { deleted.push(name); },
  } });
  const opening = sessions.start();
  const stopping = sessions.shutdown();
  release();
  const result = await opening;
  await stopping;
  assert.equal(result.status, 503);
  assert.deepEqual(deleted, ["late-room"]);
  assert.equal((await sessions.start()).status, 503);
});

test("a failed expiry cleanup does not stop other tickets or restart recovery", async () => {
  let clock = 1_000_000;
  const attempted = [];
  let recovered = 0;
  let roomIndex = 0;
  const sessions = createSessions({ config: { ...config, maxActive: 2 }, now: () => clock, rooms: {
    async open() { return { roomName: `room-${++roomIndex}`, token: "token" }; },
    async deleteRoom(name) {
      attempted.push(name);
      if (name === "room-1") throw new Error("transient failure");
    },
    async sweep() { recovered++; },
  } });
  await sessions.start();
  await sessions.start();
  clock += 120_000;
  await assert.rejects(sessions.sweep());
  assert.deepEqual(attempted.sort(), ["room-1", "room-2"]);
  assert.equal(recovered, 1);
  // Only the failed deletion still occupies a slot, so another call fits.
  assert.equal((await sessions.start()).status, 200);
});
