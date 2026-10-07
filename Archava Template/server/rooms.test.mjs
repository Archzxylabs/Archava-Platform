import assert from "node:assert/strict";
import test from "node:test";
import { createRoomProvider, removeAutomaticAgents } from "./livekit-rooms.mjs";

function fixture() {
  const created = [], deleted = [], dispatched = [], evicted = [];
  let listed = [];
  const config = { projectId: "unit-project", agentName: "unit-project-host", seconds: 120, avatarProvider: "voice" };
  const rooms = {
    async createRoom(options) { created.push(options); },
    async deleteRoom(name) { deleted.push(name); },
    async listRooms() { return listed; },
    async listParticipants() { return [{ identity: "agent-auto-job" }, { identity: "guest-person" }]; },
    async removeParticipant(room, identity) { evicted.push(identity); },
  };
  const dispatch = {
    async listDispatch() { return [{ id: "auto", state: { jobs: [{ id: "auto-job" }] } }, { id: "other", agentName: "another-host" }]; },
    async deleteDispatch(id) { dispatched.push(id); },
    async createDispatch(room, name) { dispatched.push(name); },
  };
  const provider = createRoomProvider({ rooms, dispatch, config, key: "test-key", secret: "test-secret" });
  return { provider, rooms, dispatch, created, deleted, dispatched, evicted, setListed(value) { listed = value; } };
}

test("guest tokens grant only room join, microphone, data and subscribe; metadata is project-bound", async () => {
  const f = fixture();
  const endsAt = Math.floor(Date.now() / 1000) + 120;
  const opened = await f.provider.open({ endsAt });
  const claims = JSON.parse(Buffer.from(opened.token.split(".")[1], "base64url"));
  const metadata = JSON.parse(f.created[0].metadata);
  assert.equal(claims.sub, metadata.guestIdentity);
  assert.match(claims.sub, /^guest-[a-f0-9]{16}$/);
  assert.equal(claims.video.room, opened.roomName);
  assert.equal(claims.video.roomJoin, true);
  assert.deepEqual(claims.video.canPublishSources, ["microphone"]);
  assert.equal(claims.video.roomAdmin, undefined);
  assert.equal(claims.video.roomCreate, undefined);
  assert.ok(claims.exp <= endsAt);
  assert.equal(metadata.projectId, "unit-project");
  assert.equal(metadata.product, "archava-template");
  assert.deepEqual(f.dispatched, ["auto", "unit-project-host"]);
  assert.deepEqual(f.evicted, ["agent-auto-job"]);
});

test("failed dispatch rolls back the room", async () => {
  const f = fixture();
  f.dispatch.createDispatch = async () => { throw new Error("dispatch failed"); };
  await assert.rejects(f.provider.open({ endsAt: Math.floor(Date.now() / 1000) + 120 }), /dispatch failed/);
  assert.deepEqual(f.deleted, [f.created[0].name]);
});

test("restart expiry sweep deletes only this project's expired rooms", async () => {
  const f = fixture();
  const expired = Math.floor(Date.now() / 1000) - 1;
  const meta = { product: "archava-template", projectId: "unit-project", endsAt: expired };
  f.setListed([
    { name: "ours", metadata: JSON.stringify(meta) },
    { name: "other-project", metadata: JSON.stringify({ ...meta, projectId: "elsewhere" }) },
    { name: "original-product", metadata: JSON.stringify({ ...meta, product: "archava" }) },
    { name: "active", metadata: JSON.stringify({ ...meta, endsAt: expired + 1000 }) },
    { name: "malformed", metadata: "null" },
  ]);
  await f.provider.sweep();
  assert.deepEqual(f.deleted, ["ours"]);
});

test("a cancelled automatic agent that joins late is evicted without removing the guest", async () => {
  let polls = 0;
  const removed = [];
  await removeAutomaticAgents("unit-room", {
    async listParticipants() { return ++polls < 2 ? [{ identity: "guest-abc" }] : [{ identity: "agent-late" }, { identity: "guest-abc" }]; },
    async removeParticipant(room, identity) { removed.push(identity); },
  }, [{ state: { jobs: [{ id: "late" }] } }], { gracePolls: 1, latePolls: 5, pauseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(removed, ["agent-late"]);
});

test("a failed recovered-room deletion does not block other expired rooms", async () => {
  const f = fixture();
  const expired = Math.floor(Date.now() / 1000) - 1;
  const metadata = JSON.stringify({ product: "archava-template", projectId: "unit-project", endsAt: expired });
  f.setListed([{ name: "failed", metadata }, { name: "closable", metadata }]);
  const attempted = [];
  f.rooms.deleteRoom = async (name) => {
    attempted.push(name);
    if (name === "failed") throw new Error("transient failure");
  };
  await assert.rejects(f.provider.sweep());
  assert.deepEqual(attempted.sort(), ["closable", "failed"]);
});
