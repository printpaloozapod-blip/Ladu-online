// Ladu AI — ported from the solo game's client (same heuristics, same plan choice).
// Picks a whole plan for a roll using the engine's legal plans only.
const L = require("./engine");

function dangerPenalty(state, owner) {
  let pen = 0;
  const occ = L.buildOcc(state);
  const mySingles = [];
  state.players[owner].pieces.forEach(q => {
    if (q < 0 || q >= 51) return;
    const idx = L.trackIdx(owner, q);
    if (L.isEntryIdx(idx)) return;
    if ((occ.get("T" + idx) || []).filter(e => e.p === owner).length === 1) mySingles.push(idx);
  });
  for (let e = 0; e < 4; e++) {
    if (e === owner) continue;
    state.players[e].pieces.forEach(q => {
      if (q < 0 || q > 51) return;
      const eIdx = L.trackIdx(e, q);
      mySingles.forEach(mIdx => {
        const dist = (mIdx - eIdx + 52) % 52;
        if (dist >= 1 && dist <= 6) pen += 15;
        const back = (eIdx - mIdx + 52) % 52;
        if (back === 1) pen += 9;
      });
    });
  }
  return pen;
}

function scorePlan(plan, owner, before) {
  const st = plan.finalState;
  let sc = Math.random() * 4;
  plan.actions.forEach(a => { if (a.type === "enter" || a.type === "enterDouble") sc += 45; });
  (plan.victims || []).forEach(v => {
    if (v === L.PARTNER[owner]) sc -= 55;
    else sc += 95;
  });
  let progBefore = 0, progAfter = 0, homeB = 0, homeA = 0;
  before.players[owner].pieces.forEach(q => { progBefore += Math.max(q, -6); if (q === L.HOME) homeB++; });
  st.players[owner].pieces.forEach(q => { progAfter += Math.max(q, -6); if (q === L.HOME) homeA++; });
  sc += (progAfter - progBefore) * 1.2;
  sc += (homeA - homeB) * 70;
  const occB = L.buildOcc(before), occA = L.buildOcc(st);
  let stB = 0, stA = 0;
  occB.forEach(l => { if (l.filter(e => e.p === owner).length >= 2) stB++; });
  occA.forEach(l => { if (l.filter(e => e.p === owner).length >= 2) stA++; });
  sc += (stA - stB) * 30;
  sc -= dangerPenalty(st, owner) - dangerPenalty(before, owner);
  return sc;
}

// Mirror of the solo client's aiSpend plan selection. Returns a plan or null.
function chooseAiPlan(S, owner, rollCtx) {
  let plans = L.enumeratePlans(S, owner, rollCtx.dice).filter(pl => pl.diceUsed > 0);
  if (rollCtx.mustKill) {
    const forced = plans.filter(pl => L.planSatisfiesForce(pl, rollCtx.directKills));
    if (forced.length) plans = forced;
  }
  plans = L.filterPlans(plans);
  if (!plans.length) return null;
  let best = null, bestScore = -1e9;
  plans.forEach(pl => {
    const sc = scorePlan(pl, owner, S);
    if (sc > bestScore) { bestScore = sc; best = pl; }
  });
  return best;
}

module.exports = { chooseAiPlan, scorePlan, dangerPenalty };
