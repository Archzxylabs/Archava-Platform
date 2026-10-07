import { randomBytes } from "node:crypto";

/** In-memory admissions for one API replica. Expiry is also stored in LiveKit. */
export function createSessions({ rooms, config, now = Date.now, newTicket = () => randomBytes(32).toString("hex") }) {
  const tickets = new Map();
  const openings = new Set();
  let pending = 0;
  let stopping = false;

  const unavailable = () => ({ status: 503, body: { error: "The live service is restarting. Please try again shortly." } });

  async function openSession() {
    if (!config.enabled) return { status: 403, body: { error: "The live conversation is not open right now." } };
    if (!config.providerConfigured || !rooms) return { status: 503, body: { error: "The live service is not configured yet." } };
    if (tickets.size + pending >= config.maxActive) return { status: 429, body: { error: "All conversation slots are busy. Please try again shortly." } };
    pending += 1;
    try {
      const endsAt = Math.floor(now() / 1000) + config.seconds;
      const { roomName, token } = await rooms.open({ endsAt });
      const ticket = newTicket();
      tickets.set(ticket, { roomName, endsAt });
      if (stopping) {
        await end(ticket);
        return unavailable();
      }
      return { status: 200, body: { ...config.publicFields, token, endsAt, ticket } };
    } finally {
      pending -= 1;
    }
  }

  function start() {
    if (stopping) return Promise.resolve(unavailable());
    const opening = openSession();
    openings.add(opening);
    // Observe both outcomes without leaving an unhandled rejected finally promise.
    opening.then(() => openings.delete(opening), () => openings.delete(opening));
    return opening;
  }

  async function end(ticket) {
    const session = tickets.get(ticket);
    if (session) {
      // Keep the ticket and occupied slot when deletion fails, so it can retry.
      await rooms.deleteRoom(session.roomName);
      tickets.delete(ticket);
    }
    return { ok: true };
  }

  async function sweep() {
    const expired = [...tickets].filter(([, session]) => session.endsAt <= Math.floor(now() / 1000));
    const results = await Promise.allSettled(expired.map(([ticket]) => end(ticket)));
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    // Recovers abandoned rooms after an API process restart using scoped metadata.
    if (rooms) {
      try { await rooms.sweep(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Some expired rooms could not close; retry next sweep");
  }

  async function shutdown() {
    stopping = true;
    // Do not let a successful provider response arrive after shutdown and leave
    // a room untracked. Existing openings finish before the final ticket cleanup.
    await Promise.allSettled([...openings]);
    await Promise.allSettled([...tickets.keys()].map(end));
  }

  return { start, end, sweep, shutdown };
}
