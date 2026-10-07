// Ladu rules engine — extracted verbatim from the solo game (ladu.html).
// Pure logic, no DOM. The same code that enforces Asad's house rules client-side
// runs on the server, so online games play by exactly the same rules.
"use strict";
/* ============ LADU ENGINE (Asad's rules) — pure logic, no DOM ============ */
const STARTS = [51, 12, 25, 38];           // track index of each player's entry square (arm tip, beside its 12)
const PARTNER = [2, 3, 0, 1];              // 2v2 teams: 0&2, 1&3
const TRACK = [ // [row,col] on a 15x15 board, travel order
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],[8,14],
  [8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],
  [13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0]
];
const COLUMNS = [ // private home-column cells, mouth -> deep (progress 52..56)
  [[7,1],[7,2],[7,3],[7,4],[7,5]],
  [[1,7],[2,7],[3,7],[4,7],[5,7]],
  [[7,13],[7,12],[7,11],[7,10],[7,9]],
  [[13,7],[12,7],[11,7],[10,7],[9,7]]
];
const HOME = 57; // progress value = finished

function newGame(){
  return {
    players: [0,1,2,3].map(()=>({ pieces:[-1,-1,-1,-1], finished:false, satOut:false })),
    turn: 0, winner: null
  };
}
function cloneState(s){ return JSON.parse(JSON.stringify(s)); }
function trackIdx(p, q){ return (STARTS[p] + q) % 52; }        // q in 0..51
function mouthIdx(p){ return (STARTS[p] + 51) % 52; }
function isEntryIdx(idx){ return STARTS.indexOf(idx) >= 0; }
function cellKey(p, q){
  if (q < 0) return "Y" + p;
  if (q <= 51) return "T" + trackIdx(p, q);
  if (q <= 56) return "C" + p + ":" + (q - 52);
  return "H" + p;
}
function cellCoord(p, q){
  if (q <= 51) return TRACK[trackIdx(p, q)];
  if (q <= 56) return COLUMNS[p][q - 52];
  return null;
}
function buildOcc(s){
  const occ = new Map();
  s.players.forEach((pl, p)=>pl.pieces.forEach((q, i)=>{
    if (q < 0 || q >= HOME) return;
    const k = cellKey(p, q);
    if (!occ.has(k)) occ.set(k, []);
    occ.get(k).push({ p, i });
  }));
  return occ;
}
function stackOwnerAt(occ, key){
  const list = occ.get(key) || [];
  const counts = {};
  list.forEach(e=>{ counts[e.p] = (counts[e.p]||0) + 1; });
  for (const p in counts) if (counts[p] >= 2) return parseInt(p);
  return null;
}
function landingInfo(occ, key, mover){
  const so = stackOwnerAt(occ, key);
  if (so !== null) return { legal: so === mover, kills: [] };       // own stack: join it; enemy stack: locked
  const list = occ.get(key) || [];
  if (key[0] === "T" && isEntryIdx(parseInt(key.slice(1)))) return { legal: true, kills: [] }; // entry = safe for all
  return { legal: true, kills: list.filter(e => e.p !== mover) };
}
/* All single-die actions for the player who OWNS the pieces (owner). */
function actionsForDie(s, owner, die){
  const occ = buildOcc(s);
  const pl = s.players[owner];
  const acts = [];
  pl.pieces.forEach((q, i)=>{
    if (q >= HOME) return;
    if (q < 0){ // in the yard: only a 6 brings a piece in
      if (die === 6){
        const key = "T" + STARTS[owner];
        if (landingInfo(occ, key, owner).legal) acts.push({ type:"enter", piece:i, die, to:0 });
      }
      return;
    }
    // forward move
    const nq = q + die;
    if (nq <= HOME){
      let ok = true;
      for (let step = q + 1; step < nq; step++){
        if (stackOwnerAt(occ, cellKey(owner, step)) !== null){ ok = false; break; } // can't pass any stack
      }
      if (ok && nq < HOME){
        const li = landingInfo(occ, cellKey(owner, nq), owner);
        if (!li.legal) ok = false;
        else acts.push({ type:"move", piece:i, die, from:q, to:nq, kills: li.kills });
      }
      if (ok && nq === HOME) acts.push({ type:"move", piece:i, die, from:q, to:HOME, kills: [] });
    }
    // backward kill: rolled a 1, target exactly one square behind, not from / onto an entry square
    if (die === 1 && q >= 1 && q <= 51){
      const myIdx = trackIdx(owner, q);
      if (!isEntryIdx(myIdx)){
        const tIdx = trackIdx(owner, q - 1);
        if (!isEntryIdx(tIdx)){
          const list = occ.get("T" + tIdx) || [];
          if (list.length === 1 && list[0].p !== owner)
            acts.push({ type:"back", piece:i, die, from:q, to:q - 1, kills:[list[0]] });
        }
      }
    }
  });
  return acts;
}
/* Apply an action to state s (mutates). Returns event info. */
function applyAction(s, owner, a){
  const pl = s.players[owner];
  const ev = { kills: [], entered:false, homed:false };
  if (a.type === "enter" || a.type === "enterDouble"){
    pl.pieces[a.piece] = 0; ev.entered = true; return ev;
  }
  const kills = a.kills || [];
  kills.forEach(v => { s.players[v.p].pieces[v.i] = -1; ev.kills.push(v); });
  pl.pieces[a.piece] = a.to;
  if (a.to === HOME){
    ev.homed = true;
    if (pl.pieces.every(q => q === HOME)) pl.finished = true;
  }
  const team = owner % 2;
  const teamHome = [0,1,2,3].filter(p => p % 2 === team)
    .reduce((n, p) => n + s.players[p].pieces.filter(q => q === HOME).length, 0);
  if (teamHome === 8) s.winner = team;
  return ev;
}
/* Enumerate every way to spend the rolled dice (plans), incl. partial spends. */
function enumeratePlans(s, owner, dice){
  const plans = [];
  function rec(state, diceLeft, actions, kills, diceUsed, victims){
    plans.push({ actions: actions.slice(), kills, diceUsed, victims: victims.slice(), finalState: state });
    if (!diceLeft.length) return;
    const triedValues = {};
    diceLeft.forEach((die, di)=>{
      if (triedValues[die]) return;                    // equal dice are interchangeable — branch once per value
      triedValues[die] = 1;
      const rest = diceLeft.slice(0, di).concat(diceLeft.slice(di + 1));
      actionsForDie(state, owner, die).forEach(a=>{
        const ns = cloneState(state);
        const ev = applyAction(ns, owner, a);
        rec(ns, rest, actions.concat([a]), kills + ev.kills.length, diceUsed + 1, victims.concat(ev.kills.map(v=>v.p)));
      });
    });
    // doubles can bring a piece in, but the WHOLE roll is spent
    if (dice.length === 2 && diceLeft.length === 2 && dice[0] === dice[1] && dice[0] !== 6){
      const yardPiece = state.players[owner].pieces.findIndex(q => q < 0);
      if (yardPiece >= 0){
        const occ = buildOcc(state);
        if (landingInfo(occ, "T" + STARTS[owner], owner).legal){
          const a = { type:"enterDouble", piece:yardPiece, die:dice[0] };
          const ns = cloneState(state);
          applyAction(ns, owner, a);
          plans.push({ actions:[a], kills:0, diceUsed:2, victims:[], finalState: ns });
        }
      }
    }
  }
  rec(cloneState(s), dice.slice(), [], 0, 0, []);
  return plans;
}
/* Plan preference only: use as many dice as possible. (Forced-kill is handled separately — direct kills only.) */
function filterPlans(plans){
  const useful = plans.filter(pl => pl.diceUsed > 0);
  if (!useful.length) return [];
  const maxDice = Math.max.apply(null, useful.map(pl => pl.diceUsed));
  return useful.filter(pl => pl.diceUsed === maxDice);
}
function legalPlans(s, owner, dice){
  return filterPlans(enumeratePlans(s, owner, dice));
}
/* --- Forced kill = DIRECT kill only: a kill available with ONE die from the roll's starting position.
       A kill that needs two moves is legal to take but is NEVER forced. --- */
function directKillsAt(s, owner, dice){
  const out = [], seen = {};
  dice.forEach(die=>{
    actionsForDie(s, owner, die).forEach(a=>{
      if ((a.kills||[]).length){
        const key = a.piece + ":" + a.die + ":" + a.to;
        if (!seen[key]){ seen[key] = 1; out.push({ piece:a.piece, die:a.die, to:a.to }); }
      }
    });
  });
  return out;
}
function matchesDirectKill(a, dks, movedPieces){
  if (!(a.kills||[]).length) return false;
  if (movedPieces.indexOf(a.piece) >= 0) return false;   // the piece already moved this roll — no longer the direct kill
  return dks.some(dk => dk.piece === a.piece && dk.die === a.die && dk.to === a.to);
}
function directKillAvailable(s, owner, remainingDice, dks, movedPieces){
  return dks.some(dk => movedPieces.indexOf(dk.piece) < 0 && remainingDice.indexOf(dk.die) >= 0 &&
    actionsForDie(s, owner, dk.die).some(a => a.piece === dk.piece && a.to === dk.to && (a.kills||[]).length));
}
/* Legal single-die step actions for interactive (human) play, with the direct-kill force applied. */
function allowedStepActions(s, owner, remainingDice, rollInfo){
  const cand = [], seen = {};
  const values = [];
  remainingDice.forEach(d=>{ if (values.indexOf(d) < 0) values.push(d); });
  values.forEach(die=>{
    actionsForDie(s, owner, die).forEach(a=>{
      const key = a.type + ":" + a.piece + ":" + a.die;
      if (!seen[key]){ seen[key] = 1; cand.push(a); }
    });
  });
  if (remainingDice.length === 2 && remainingDice[0] === remainingDice[1] && remainingDice[0] !== 6){
    const yardPiece = s.players[owner].pieces.findIndex(q => q < 0);
    if (yardPiece >= 0 && landingInfo(buildOcc(s), "T" + STARTS[owner], owner).legal)
      cand.push({ type:"enterDouble", piece:yardPiece, die:remainingDice[0] });
  }
  if (!rollInfo || !rollInfo.mustKill || rollInfo.killSatisfied) return cand;
  const dks = rollInfo.directKills, moved = rollInfo.movedPieces;
  return cand.filter(a=>{
    if (matchesDirectKill(a, dks, moved)) return true;
    if ((a.kills||[]).length) return false;              // any other capture would dodge the forced kill
    const ns = cloneState(s); applyAction(ns, owner, a);
    const rem = remainingDice.slice();
    if (a.type === "enterDouble") rem.length = 0;
    else { const ix = rem.indexOf(a.die); if (ix >= 0) rem.splice(ix, 1); }
    return directKillAvailable(ns, owner, rem, dks, moved.concat([a.piece])); // neutral move only if the direct kill survives it
  });
}
/* Does this full plan take one of the roll-start direct kills? (AI force check.) */
function planSatisfiesForce(plan, dks){
  if (!dks.length) return true;
  const moved = [];
  for (const a of plan.actions){
    if (matchesDirectKill(a, dks, moved)) return true;
    moved.push(a.piece);
  }
  return false;
}
/* Extra roll? kills always earn one; a 6 earns one unless this roll was earned by a kill. */
function earnsExtraRoll(dice, kills, rollSource){
  if (kills > 0) return true;
  if (dice.indexOf(6) >= 0 && rollSource !== "kill") return true;
  return false;
}
/* Who moves this turn: a finished player who already sat out a round plays their partner's hand. */
function turnOwner(s){
  const t = s.turn, pl = s.players[t];
  if (pl.finished && pl.satOut) return PARTNER[t];
  return t;
}

module.exports = { COLUMNS, HOME, PARTNER, STARTS, TRACK, actionsForDie, allowedStepActions, applyAction, buildOcc, cellCoord, cellKey, cloneState, directKillAvailable, directKillsAt, earnsExtraRoll, enumeratePlans, filterPlans, isEntryIdx, landingInfo, legalPlans, matchesDirectKill, mouthIdx, newGame, planSatisfiesForce, stackOwnerAt, trackIdx, turnOwner };
