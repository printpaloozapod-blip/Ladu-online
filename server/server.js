// Ladu online — game server. Pure Node (no dependencies): HTTP + Server-Sent Events.
// The server is authoritative: it runs the same rules engine as the solo game,
// validates every roll/step, fills empty seats with the same AI, and broadcasts
// state snapshots to everyone in the room.
const http = require("http");
const fs = require("fs");
const path = require("path");
const L = require("./engine");
const AI = require("./ai");

const PORT = process.env.PORT || 8471;
const FAST = process.env.LADU_FAST ? 0.03 : 1; // test hook: compress pacing delays
const CLIENT_DIR = path.join(__dirname, "..", "client");

// Presentation constants, mirrored from the client so server log lines match.
const CLUBS = [
  { name: "Arsenal",    short: "ARS", color: "#ee2737" },
  { name: "Liverpool",  short: "LIV", color: "#00a35c" },
  { name: "Man City",   short: "MCI", color: "#6cabdd" },
  { name: "Man United", short: "MUN", color: "#ffd400" }
];

const rooms = new Map();
const rid = n => { const c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };
const token = () => rid(10) + Date.now().toString(36);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cleanName = s => esc(String(s || "Player").trim().slice(0, 16) || "Player");

function newRoom(hostName, hostToken) {
  let code; do { code = rid(4); } while (rooms.has(code));
  const room = {
    code, hostToken,
    members: new Map(),           // token -> { name }
    seats: [0, 1, 2, 3].map(() => ({ kind: "open", token: null, name: null, club: null, connected: false })),
    phase: "lobby",               // lobby | roll | steps | over
    S: null, rollCtx: null, rollStreak: 0, nextSource: "start", controlSeat: -1,
    log: [], clients: new Set(), gen: 0, lastActivity: Date.now(), lastEv: null
  };
  room.members.set(hostToken, { name: hostName });
  room.seats[0] = { kind: "human", token: hostToken, name: hostName, club: null, connected: false };
  rooms.set(code, room);
  return room;
}

function seatClubOf(room) {
  // Chosen clubs first; unchosen seats preview/auto-fill in canonical order.
  const used = new Set(room.seats.map(s => s.club).filter(c => c !== null));
  const rest = [0, 1, 2, 3].filter(c => !used.has(c));
  return room.seats.map(s => (s.club !== null ? s.club : rest.shift()));
}
function displayName(room, p) {
  const club = CLUBS[room.seatClub ? room.seatClub[p] : seatClubOf(room)[p]].name;
  const seat = room.seats[p];
  return seat.kind === "human" && seat.name ? club + " (" + seat.name + ")" : club;
}
function who(room, p) {
  const sc = room.seatClub || seatClubOf(room);
  return '<b style="color:' + CLUBS[sc[p]].color + '">' + esc(displayName(room, p)) + "</b>";
}
function pushLog(room, html) {
  room.log.push(html);
  if (room.log.length > 120) room.log.splice(0, room.log.length - 120);
  for (const res of room.clients) send(res, "log", { html });
}
function snapshot(room) {
  const sc = room.seatClub || seatClubOf(room);
  let steps = [];
  if (room.phase === "steps" && room.S && room.rollCtx) {
    const owner = room.controlSeat;
    if (room.seats[owner] && room.seats[owner].kind === "human") {
      steps = L.allowedStepActions(room.S, owner, room.rollCtx.remaining, room.rollCtx)
        .map(a => ({ type: a.type, piece: a.piece, die: a.die, from: a.from, to: a.to, kills: (a.kills || []).map(v => ({ p: v.p, i: v.i })) }));
    }
  }
  return {
    code: room.code, phase: room.phase, seatClub: sc,
    seats: room.seats.map(s => ({ kind: s.kind, name: s.name, club: s.club, connected: s.connected })),
    hostSeat: room.seats.findIndex(s => s.token === room.hostToken),
    members: [...room.members.values()].map(m => m.name),
    S: room.S, turn: room.S ? room.S.turn : 0, controlSeat: room.controlSeat,
    dice: room.rollCtx ? room.rollCtx.dice : null,
    remaining: room.rollCtx ? room.rollCtx.remaining.slice() : [],
    mustKill: !!(room.rollCtx && room.rollCtx.mustKill && !room.rollCtx.killSatisfied),
    steps, winner: room.S ? room.S.winner : null, lastEv: room.lastEv,
    logTail: room.log.slice(-40)
  };
}
function send(res, event, data) {
  try { res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); } catch (e) {}
}
function broadcast(room) {
  room.lastActivity = Date.now();
  const snap = snapshot(room);
  for (const res of room.clients) send(res, "state", snap);
}
function schedule(room, fn, ms) {
  const g = room.gen;
  setTimeout(() => { if (room.gen === g && rooms.has(room.code)) fn(); }, ms * FAST);
}

/* ================= game flow (ported from the solo client) ================= */
function reportEvents(room, owner, a, ev) {
  if (a.type === "enter" || a.type === "enterDouble") pushLog(room, who(room, owner) + " brings a piece in.");
  if (ev.kills && ev.kills.length) ev.kills.forEach(v => pushLog(room, "💥 " + who(room, owner) + " killed " + who(room, v.p) + "'s piece!"));
  if (ev.homed) {
    const n = room.S.players[owner].pieces.filter(q => q === L.HOME).length;
    pushLog(room, "🏠 " + who(room, owner) + " got a piece HOME (" + n + "/4).");
  }
  if (room.S.players[owner].finished && ev.homed) pushLog(room, "🎉 " + who(room, owner) + " has all 4 pieces home!");
  room.lastEv = { kills: (ev.kills || []).length, homed: !!ev.homed, entered: !!ev.entered };
}

function startGame(room) {
  room.gen++;
  room.seatClub = seatClubOf(room);
  room.seats.forEach((s, i) => { if (s.kind === "open") s.kind = "ai"; s.club = room.seatClub[i]; });
  room.S = L.newGame();
  room.rollCtx = null; room.rollStreak = 0; room.nextSource = "start"; room.lastEv = null;
  room.log = [];
  pushLog(room, "🎲 New game! " + room.seats.map((s, i) => who(room, i)).join(" · "));
  pushLog(room, "First team to get all 8 pieces home wins.");
  room.phase = "roll";
  broadcast(room);
  runTurn(room);
}

function runTurn(room) {
  const S = room.S;
  if (S.winner !== null) return gameOver(room);
  if (S.players[S.turn].finished && !S.players[S.turn].satOut) {
    S.players[S.turn].satOut = true;
    pushLog(room, who(room, S.turn) + " finished all 4 pieces — sits this round out, then plays as a second hand.");
    S.turn = (S.turn + 1) % 4; room.rollStreak = 0;
    broadcast(room);
    return schedule(room, () => runTurn(room), 800);
  }
  room.controlSeat = L.turnOwner(S);
  room.phase = "roll";
  broadcast(room);
  if (room.seats[room.controlSeat].kind === "ai") schedule(room, () => doRoll(room), 950);
}

function doRoll(room) {
  const S = room.S, t = S.turn, owner = room.controlSeat;
  const dice = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  room.rollCtx = {
    dice, remaining: dice.slice(), kills: 0,
    source: room.rollStreak === 0 ? "start" : room.nextSource, owner
  };
  room.rollCtx.directKills = L.directKillsAt(S, owner, dice);
  room.rollCtx.mustKill = room.rollCtx.directKills.length > 0;
  room.rollCtx.movedPieces = [];
  room.rollCtx.killSatisfied = false;
  const srcNote = room.rollCtx.source !== "start" ? " (bonus roll)" : "";
  pushLog(room, who(room, t) + " rolled <b>" + dice[0] + " + " + dice[1] + "</b>" + srcNote + (owner !== t ? " for " + who(room, owner) + "'s hand" : "") + ".");
  room.lastEv = { roll: true };
  if (room.seats[owner].kind === "ai") {
    room.phase = "steps"; broadcast(room);
    schedule(room, () => aiSpend(room), 750);
  } else {
    room.phase = "steps"; broadcast(room);
    if (!L.allowedStepActions(S, owner, room.rollCtx.remaining, room.rollCtx).length)
      schedule(room, () => finishRoll(room), 1000);
  }
}

function applyStepBookkeeping(room, chosen) {
  const rc = room.rollCtx;
  if (L.matchesDirectKill(chosen, rc.directKills, rc.movedPieces)) rc.killSatisfied = true;
  rc.movedPieces.push(chosen.piece);
  if (chosen.type === "enterDouble") rc.remaining = [];
  else { const i = rc.remaining.indexOf(chosen.die); if (i >= 0) rc.remaining.splice(i, 1); }
  const ev = L.applyAction(room.S, rc.owner, chosen);
  rc.kills += ev.kills.length;
  reportEvents(room, rc.owner, chosen, ev);
}

function humanStep(room, seatIdx, sel) {
  if (room.phase !== "steps" || !room.rollCtx) return err("Not waiting for a move.");
  if (seatIdx !== room.controlSeat) return err("Not your turn.");
  const acts = L.allowedStepActions(room.S, room.controlSeat, room.rollCtx.remaining, room.rollCtx);
  const chosen = acts.find(a => a.piece === sel.piece && a.die === sel.die && a.type === sel.type && a.to === sel.to);
  if (!chosen) return err("That move isn't legal right now.");
  applyStepBookkeeping(room, chosen);
  broadcast(room);
  if (room.S.winner !== null) return finishRoll(room);
  if (!room.rollCtx.remaining.length || !L.allowedStepActions(room.S, room.controlSeat, room.rollCtx.remaining, room.rollCtx).length) {
    room.phase = "roll"; // block further steps while the roll wraps up
    schedule(room, () => finishRoll(room), 550);
  }
  return { ok: true };
}

function aiSpend(room) {
  const rc = room.rollCtx; if (!rc) return;
  const owner = rc.owner;
  const plan = AI.chooseAiPlan(room.S, owner, rc);
  if (!plan) return finishRoll(room);
  let i = 0;
  const stepOnce = () => {
    if (room.gen !== undefined && !rooms.has(room.code)) return;
    if (i >= plan.actions.length) return finishRoll(room);
    const a = plan.actions[i++];
    if (L.matchesDirectKill(a, rc.directKills, rc.movedPieces)) rc.killSatisfied = true;
    rc.movedPieces.push(a.piece);
    if (a.type === "enterDouble") rc.remaining = [];
    else { const j = rc.remaining.indexOf(a.die); if (j >= 0) rc.remaining.splice(j, 1); }
    const ev = L.applyAction(room.S, owner, a);
    rc.kills += ev.kills.length;
    reportEvents(room, owner, a, ev);
    broadcast(room);
    if (room.S.winner !== null) return finishRoll(room);
    schedule(room, stepOnce, 520);
  };
  stepOnce();
}

// Host replaces a stuck/disconnected human seat with the computer mid-game.
function aiTakeover(room, seatIdx) {
  const seat = room.seats[seatIdx];
  if (!seat || seat.kind !== "human") return;
  seat.kind = "ai"; seat.connected = false;
  pushLog(room, "🤖 The computer takes over " + who(room, seatIdx) + "'s seat.");
  broadcast(room);
  if ((room.phase === "roll" || room.phase === "steps") && room.controlSeat === seatIdx && room.S && room.S.winner === null) {
    if (room.phase === "roll" && !room.rollCtx) schedule(room, () => doRoll(room), 700);
    else if (room.phase === "steps" && room.rollCtx) schedule(room, () => aiSpendRemaining(room), 700);
  }
}
// AI finishes a partially-spent roll (after a takeover): plans over the remaining dice.
function aiSpendRemaining(room) {
  const rc = room.rollCtx; if (!rc || !rc.remaining.length) return finishRoll(room);
  const owner = rc.owner;
  let plans = L.enumeratePlans(room.S, owner, rc.remaining.slice()).filter(pl => pl.diceUsed > 0);
  if (rc.mustKill && !rc.killSatisfied) {
    const forced = plans.filter(pl => L.planSatisfiesForce(pl, rc.directKills));
    if (forced.length) plans = forced;
  }
  plans = L.filterPlans(plans);
  if (!plans.length) return finishRoll(room);
  let best = null, bs = -1e9;
  plans.forEach(pl => { const sc = AI.scorePlan(pl, owner, room.S); if (sc > bs) { bs = sc; best = pl; } });
  let i = 0;
  const stepOnce = () => {
    if (i >= best.actions.length) { rc.remaining = []; return finishRoll(room); }
    const a = best.actions[i++];
    if (L.matchesDirectKill(a, rc.directKills, rc.movedPieces)) rc.killSatisfied = true;
    rc.movedPieces.push(a.piece);
    const ev = L.applyAction(room.S, owner, a);
    rc.kills += ev.kills.length;
    reportEvents(room, owner, a, ev);
    broadcast(room);
    if (room.S.winner !== null) return finishRoll(room);
    schedule(room, stepOnce, 520);
  };
  stepOnce();
}

function finishRoll(room) {
  const S = room.S; if (!S) return;
  if (S.winner !== null) return gameOver(room);
  const rc = room.rollCtx;
  const earned = rc && L.earnsExtraRoll(rc.dice, rc.kills, rc.source);
  const kills = rc ? rc.kills : 0, t = S.turn;
  if (earned && room.rollStreak < 14) {
    room.rollStreak++;
    room.nextSource = kills > 0 ? "kill" : "six";
    room.rollCtx = null;
    pushLog(room, who(room, t) + (kills > 0 ? " killed — rolls again!" : " rolled a 6 — rolls again!"));
    room.phase = "roll";
    broadcast(room);
    if (room.seats[room.controlSeat].kind === "ai") schedule(room, () => doRoll(room), 850);
    return;
  }
  room.rollCtx = null;
  S.turn = (S.turn + 1) % 4; room.rollStreak = 0;
  runTurn(room);
}

function gameOver(room) {
  room.phase = "over";
  const w = room.S.winner;
  pushLog(room, w === 0 ? "🏆 " + who(room, 0) + " and " + who(room, 2) + " win the game!" : "🏆 " + who(room, 1) + " and " + who(room, 3) + " win the game!");
  broadcast(room);
}

function err(error) { return { error }; }

/* ================= HTTP ================= */
function body(req) {
  return new Promise(resolve => {
    let b = ""; req.on("data", c => { b += c; if (b.length > 20000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve({}); } });
  });
}
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}
function seatOf(room, tk) { return room.seats.findIndex(s => s.token === tk && tk); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/health") return json(res, 200, { ok: true });

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/solo")) {
    const file = url.pathname === "/" ? "ladu-online.html" : "ladu.html";
    fs.readFile(path.join(CLIENT_DIR, file), (e, buf) => {
      if (e) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buf);
    });
    return;
  }

  if (parts[0] === "api" && parts[1] === "rooms") {
    // POST /api/rooms — create
    if (req.method === "POST" && parts.length === 2) {
      const b = await body(req);
      const tk = token();
      const room = newRoom(cleanName(b.name), tk);
      return json(res, 200, { code: room.code, token: tk });
    }
    const room = rooms.get((parts[2] || "").toUpperCase());
    if (!room) return json(res, 404, { error: "Room not found — check the code." });
    const action = parts[3];

    if (req.method === "GET" && action === "events") {
      const tk = url.searchParams.get("token");
      if (!room.members.has(tk)) return json(res, 403, { error: "Not a member of this room." });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      room.clients.add(res);
      const si = seatOf(room, tk);
      if (si >= 0 && !room.seats[si].connected) { room.seats[si].connected = true; broadcast(room); }
      send(res, "state", snapshot(room));
      const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
      req.on("close", () => {
        clearInterval(hb);
        room.clients.delete(res);
        const sj = seatOf(room, tk);
        if (sj >= 0) { room.seats[sj].connected = false; broadcast(room); }
      });
      return;
    }

    if (req.method === "POST") {
      const b = await body(req);
      const tk = b.token;
      if (action === "join") {
        const ntk = token();
        room.members.set(ntk, { name: cleanName(b.name) });
        broadcast(room);
        return json(res, 200, { token: ntk });
      }
      if (!room.members.has(tk)) return json(res, 403, { error: "Not a member of this room." });
      const mySeat = seatOf(room, tk);

      if (action === "seat") {
        const target = b.seat;
        if (room.phase !== "lobby") return json(res, 400, { error: "Seats are locked once the game starts." });
        if (mySeat >= 0) { room.seats[mySeat] = { kind: "open", token: null, name: null, club: null, connected: false }; }
        if (target >= 0 && target <= 3) {
          if (room.seats[target].kind !== "open") return json(res, 400, { error: "That seat is taken." });
          room.seats[target] = { kind: "human", token: tk, name: room.members.get(tk).name, club: null, connected: true };
        }
        broadcast(room);
        return json(res, 200, { ok: true });
      }
      if (action === "club") {
        if (mySeat < 0) return json(res, 400, { error: "Take a seat first." });
        const club = b.club;
        if (!(club >= 0 && club <= 3)) return json(res, 400, { error: "Bad club." });
        if (room.seats.some((s, i) => i !== mySeat && s.club === club)) return json(res, 400, { error: "That club is already picked." });
        room.seats[mySeat].club = club;
        broadcast(room);
        return json(res, 200, { ok: true });
      }
      if (action === "start") {
        if (tk !== room.hostToken) return json(res, 403, { error: "Only the host can start the game." });
        if (room.phase !== "lobby" && room.phase !== "over") return json(res, 400, { error: "Game already running." });
        if (!room.seats.some(s => s.kind === "human")) return json(res, 400, { error: "No players seated." });
        // reopen seats that were AI-filled in a previous game if a member wants in later — keep kinds; startGame re-fills opens
        room.seats.forEach(s => { if (s.kind === "ai" && !s.token) s.kind = "open"; });
        startGame(room);
        return json(res, 200, { ok: true });
      }
      if (action === "roll") {
        if (room.phase !== "roll" || room.rollCtx) return json(res, 400, { error: "Can't roll right now." });
        if (mySeat !== room.controlSeat) return json(res, 403, { error: "Not your turn." });
        doRoll(room);
        return json(res, 200, { ok: true });
      }
      if (action === "step") {
        if (mySeat < 0) return json(res, 403, { error: "You're spectating." });
        const r = humanStep(room, mySeat, b.step || {});
        return json(res, r && r.error ? 400 : 200, r || { ok: true });
      }
      if (action === "takeover") {
        if (tk !== room.hostToken) return json(res, 403, { error: "Only the host can do that." });
        aiTakeover(room, b.seat);
        return json(res, 200, { ok: true });
      }
      if (action === "leave") {
        room.members.delete(tk);
        if (mySeat >= 0) {
          if (room.phase === "lobby") room.seats[mySeat] = { kind: "open", token: null, name: null, club: null, connected: false };
          else { room.seats[mySeat].kind = "ai"; room.seats[mySeat].token = null; }
        }
        broadcast(room);
        return json(res, 200, { ok: true });
      }
    }
  }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log("Ladu online server listening on port " + PORT));

// Room cleanup: drop rooms with nobody connected for 30+ minutes.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.lastActivity > 30 * 60 * 1000) rooms.delete(code);
  }
}, 60000);
