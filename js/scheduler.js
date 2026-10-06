// Moteur de planification : fonctions pures, sans DOM, testables avec node --test.
import { DAY_NAMES, addDays, diffDays, fmtDuration, fromMin, month, toMin, weekDates, weekStart, weekday } from './dates.js';

// « other » = faite par quelqu'un d'autre : compte comme faite pour la fréquence, pas pour tes stats.
const DONE_LIKE = ['todo', 'done', 'other'];

export const FREQ_DAYS = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };
// Délai minimal depuis la dernière fois avant de reproposer la tâche.
const FREQ_TOLERANCE = { daily: 1, weekly: 4, biweekly: 10, monthly: 24 };
const REVISION = {
  1: { days: 1, minutes: 30 },
  2: { days: 3, minutes: 45 },
  3: { days: 5, minutes: 60 },
};

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------- Ce qui occupe une journée ---------- */

/**
 * Créneaux occupés d'une date : événements perso, cours de l'EDT et trajets. Entre le départ et le retour, tu n'es pas à la maison : ce temps est compté
 * comme occupé (bloc « absent », non affiché).
 */
export function blocksOn(state, date, opts = {}) {
  const wd = weekday(date);
  const blocks = [];
  for (const e of state.events) {
    const matches = e.repeat
      ? e.weekday === wd && (!e.from || e.from <= date) && !(e.exceptions || []).includes(date)
      : e.date === date;
    if (matches) blocks.push({ kind: 'event', title: e.title, start: e.start, end: e.end, id: e.id, away: !!e.commute });
  }
  if (state.settings.useEdt && state.edt?.events) {
    for (const e of state.edt.events) {
      if (e.date === date && !(state.settings.hiddenEdt || []).includes(e.title)) {
        blocks.push({ kind: 'cours', title: e.title, start: e.start, end: e.end, room: e.room, type: e.type, teachers: e.teachers, away: true });
      }
    }
  }
  const arabic = arabicPlan(state, date);
  if (arabic?.date === date) {
    const a = state.settings.arabic;
    blocks.push({ kind: 'event', title: a.title || 'Cours d’arabe', start: a.start, end: a.end, away: !!a.commute, arabic: true });
  }
  blocks.push(...commuteBlocks(state.settings, blocks.filter((b) => b.away), state.rides || {}, date, state.edt?.trips?.[date]));
  // Salle de sport : séances fixes du week-end + séance en plus choisie en semaine.
  const g = state.settings.gym;
  if (g?.enabled) {
    const dur = Number(g.duration || 90);
    const tr = gymTravel(state, date);
    if (g.weekend !== false && (g.weekendDays || [5, 6]).includes(wd)) {
      const st = toMin(g.weekendStart || '10:00');
      blocks.push({
        kind: 'sport', title: 'Salle de sport', start: fromMin(st - tr.a), end: fromMin(st + dur + tr.r),
        session: [fromMin(st), fromMin(st + dur)], tr,
      });
    } else if (!opts.noGym && wd < 5) {
      const plan = gymPlan(state, date);
      if (plan?.chosen?.date === date) {
        const { slot } = plan.chosen;
        blocks.push({ kind: 'sport', title: 'Salle de sport · séance en plus', start: slot.from, end: slot.to, session: [slot.start, slot.end], tr, extra: true, plan });
      }
    }
  }
  return blocks.sort((a, b) => toMin(a.start) - toMin(b.start));
}

/**
 * Trajet maison ↔ salle ce jour-là : celui calculé par IDF Mobilités s'il existe,
 * sinon la durée saisie dans les réglages.
 */
export function gymTravel(state, date) {
  const g = state.settings.gym || {};
  const t = g.useTransit !== false ? state.edt?.gymTrips?.[date] : null;
  const ok = (j) => j && j.duration > 0 && j.duration <= 180;
  const manual = Number(g.travel || 0);
  return {
    a: ok(t?.aller) ? t.aller.duration : manual,
    r: ok(t?.retour) ? t.retour.duration : manual,
    ja: ok(t?.aller) ? t.aller : null,
    jr: ok(t?.retour) ? t.retour : null,
  };
}

/** Premier créneau libre pour une séance de sport ce jour-là (après le retour à la maison). */
export function gymSlot(state, date, blocks, latestStart = null) {
  const s = state.settings;
  const g = s.gym || {};
  const dur = Number(g.duration || 90);
  const tr = gymTravel(state, date);
  const need = tr.a + dur + tr.r;
  const home = blocks.find((b) => b.dir === 'retour');
  let lo = toMin(s.wake) + 60;
  lo = Math.max(lo, home ? toMin(home.homeAt) + 15 : toMin(g.freeDayFrom || '10:00'));
  let hi = toMin(s.sleep);
  if (hi <= toMin(s.wake)) hi += 1440;
  hi -= 30;
  const busy = blocks.map((b) => {
    const a = toMin(b.start);
    let e = toMin(b.end);
    if (e <= a) e += 1440;
    return [a, e];
  });
  for (let t = Math.ceil(lo / 15) * 15; t + need <= hi; t += 15) {
    // séance qui commencerait trop tard : on arrête de chercher
    if (latestStart != null && t + tr.a > latestStart) break;
    if (busy.every(([a, e]) => t + need <= a || t >= e)) {
      return { from: fromMin(t), to: fromMin(t + need), start: fromMin(t + tr.a), end: fromMin(t + tr.a + dur) };
    }
  }
  return null;
}

// Espacement avec les séances du samedi et du dimanche : mercredi est le plus loin des deux.
const GYM_SPACING = [2, 1, 0, 1, 2];

/**
 * Meilleur jour (lundi → vendredi) pour la séance de sport en plus, recalculé chaque semaine :
 * il faut un créneau libre après le retour ; on préfère le milieu de semaine (récupération),
 * on évite le soir du cours d'arabe, le jour et la veille d'un contrôle, et les séances tardives.
 */
export function gymPlan(state, date) {
  const g = state.settings.gym;
  if (!g?.enabled || g.weekday === false) return null;
  const ws = weekStart(date);
  const options = [];
  for (let i = 0; i < 5; i += 1) {
    const d = addDays(ws, i);
    const blocks = blocksOn(state, d, { noGym: true });
    const latest = toMin(g.latestStart || '17:45');
    const slot = gymSlot(state, d, blocks, latest);
    if (!slot) {
      const home = blocks.find((b) => b.dir === 'retour');
      const late = home && toMin(home.homeAt) + 15 > latest;
      options.push({ date: d, day: i, slot: null, score: Infinity, why: [late ? `retour à ${home.homeAt}, trop tard pour une séance avant ${g.latestStart || '17:45'}` : 'pas de créneau libre'] });
      continue;
    }
    let score = GYM_SPACING[i];
    const why = [];
    if (i === 2) why.push('bien espacé des séances du week-end');
    else if (i === 0) why.push('lendemain de la séance de dimanche');
    else if (i === 4) why.push('veille de la séance de samedi');
    if (blocks.some((b) => b.arabic)) {
      score += 3;
      why.push('soir de cours d’arabe');
    }
    for (const ex of state.exams) {
      const k = diffDays(d, ex.date);
      if (k === 0 || k === 1) {
        score += 3;
        why.push(k === 0 ? `contrôle de ${ex.subject}` : `veille du contrôle de ${ex.subject}`);
      }
    }
    const cours = blocks.filter((b) => b.kind === 'cours');
    if (!cours.length) {
      score -= 1;
      why.push('pas cours');
    } else if (cours.some((b) => toMin(b.end) >= toMin('17:30'))) {
      score += 0.5;
      why.push('longue journée');
    }
    if (!why.length) why.push(cours.length ? 'soirée libre après les cours' : 'journée libre');
    options.push({ date: d, day: i, slot, score, why });
  }
  const ranked = [...options].sort((a, b) => a.score - b.score || a.day - b.day);
  const pick = g.pick?.[ws];
  const manual = pick != null ? options.find((o) => o.day === pick && o.slot) : null;
  const chosen = manual || (ranked[0]?.slot ? ranked[0] : null);
  return { ws, chosen, ranked, manual: !!manual };
}

/** Heure de fin du dernier cours de l'EDT ce jour-là (null s'il n'y a pas cours). */
export function edtEndOn(state, date) {
  if (!state.settings.useEdt || !state.edt?.events) return null;
  const ends = state.edt.events.filter((e) => e.date === date).map((e) => e.end);
  return ends.length ? ends.sort().at(-1) : null;
}

/**
 * Jour du cours d'arabe pour la semaine de `date`, recalculé à partir de l'EDT :
 * - jour préféré (mercredi) si les cours y finissent avant 18h ;
 * - sinon l'autre jour (mardi) si les cours y finissent avant 18h ;
 * - sinon pas de cours d'arabe cette semaine.
 */
export function arabicPlan(state, date) {
  const a = state.settings.arabic;
  if (!a?.enabled) return null;
  const ws = weekStart(date);
  const [d1, d2] = a.days;
  const [date1, date2] = [addDays(ws, d1), addDays(ws, d2)];
  const [e1, e2] = [edtEndOn(state, date1), edtEndOn(state, date2)];
  const late = (e) => e != null && toMin(e) >= toMin(a.lateFrom);
  const fin = (e) => (e ? `tu finis à ${e.replace(':', 'h')}` : 'pas cours');
  const why = `${DAY_NAMES[d1].toLowerCase()} ${fin(e1)}, ${DAY_NAMES[d2].toLowerCase()} ${fin(e2)}`;
  const known = !state.edt?.range || date2 <= state.edt.range.to;
  const res = (d, reason) => ({ date: d, day: d ? weekday(d) : null, reason, why, known, ends: [e1, e2], dates: [date1, date2] });
  const limit = a.lateFrom.replace(':', 'h');
  const prefDay = a.days.includes(a.tieDay) ? a.tieDay : d2;
  const [pDate, pEnd, oDate, oEnd, oDay] = prefDay === d1 ? [date1, e1, date2, e2, d2] : [date2, e2, date1, e1, d1];
  const name = (d) => DAY_NAMES[d].toLowerCase();
  if (!late(pEnd)) return res(pDate, `${name(prefDay)} : tu finis avant ${limit}`);
  if (!late(oEnd)) return res(oDate, `${name(prefDay)} tu finis trop tard, ${name(oDay)} avant ${limit}`);
  return res(null, `pas de cours d’arabe : tu finis à ${limit} ou plus les deux jours`);
}

/**
 * Trajets aller/retour autour des cours (et des activités « loin de chez moi »).
 * Avec maman (voiture) : trajet court (45 min). Sinon : trajet long (1 h 40).
 * `rides` = { "YYYY-MM-DD|aller": true, "YYYY-MM-DD|retour": true } pour les trajets avec maman.
 * `trip` = trajets réels calculés par PRIM (IDF Mobilités) : utilisés quand tu n'es pas avec maman.
 */
export function commuteBlocks(settings, away, rides = {}, date = '', trip = null) {
  const max = Number(settings.commuteMax) || 0;
  if (!away.length || max <= 0) return [];
  const min = Math.min(Number(settings.commuteMin) || max, max);
  const first = Math.min(...away.map((b) => toMin(b.start)));
  const last = Math.max(...away.map((b) => toMin(b.end) <= toMin(b.start) ? toMin(b.end) + 1440 : toMin(b.end)));
  const out = [];
  const momA = !!rides[`${date}|aller`];
  const momR = !!rides[`${date}|retour`];
  const real = (j, ok) => (j && ok && j.duration > 0 && j.duration <= 240 ? j : null);
  if (settings.commuteMorning !== false) {
    const j = momA ? null : real(trip?.aller, trip?.aller?.leave < fromMin(first));
    const d = j ? first - toMin(j.leave) : momA ? min : max;
    out.push({ kind: 'trajet', dir: 'aller', date, mom: momA, journey: j, title: 'Trajet aller', start: fromMin(Math.max(0, first - d)), end: fromMin(first), duration: d });
  }
  const j = momR ? null : real(trip?.retour, trip?.retour?.arrive > fromMin(last));
  const d = j ? toMin(j.arrive) - last : momR ? min : max;
  out.push({ kind: 'trajet', dir: 'retour', date, mom: momR, journey: j, title: 'Trajet retour', start: fromMin(last), end: fromMin(last + d), duration: d, homeAt: fromMin(last + d) });
  if (last > first) out.push({ kind: 'absent', title: 'Hors de la maison', start: fromMin(first), end: fromMin(last), hidden: true });
  return out;
}

/** Minutes occupées dans la fenêtre éveillée, chevauchements fusionnés. */
export function busyMinutes(blocks, wake, sleep) {
  const lo = toMin(wake);
  let hi = toMin(sleep);
  if (hi <= lo) hi += 1440;
  const ranges = blocks
    .map((b) => [Math.max(lo, toMin(b.start)), Math.min(hi, toMin(b.end) <= toMin(b.start) ? toMin(b.end) + 1440 : toMin(b.end))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const r of ranges) {
    if (!cur || r[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [...r];
    } else cur[1] = Math.max(cur[1], r[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return { total, awake: hi - lo };
}

/** Temps libre restant d'une journée à partir de la minute `fromM` (pour « aujourd'hui »). */
export function freeAfter(state, info, fromM) {
  const lo = Math.max(toMin(state.settings.wake), fromM);
  let hi = toMin(state.settings.sleep);
  if (hi <= toMin(state.settings.wake)) hi += 1440;
  if (lo >= hi) return 0;
  const { total, awake } = busyMinutes(info.blocks, fromMin(lo), state.settings.sleep);
  return Math.max(0, awake - total - info.revisionMin);
}

/** Révisions automatiques à prévoir ce jour-là selon les contrôles à venir. */
export function revisionsOn(state, date) {
  const out = [];
  for (const ex of state.exams) {
    const k = diffDays(date, ex.date);
    const r = REVISION[ex.importance] || REVISION[1];
    if (k >= 1 && k <= r.days) out.push({ subject: ex.subject, minutes: r.minutes, examDate: ex.date, examId: ex.id });
  }
  const base = Number(state.settings.dailyRevision) || 0;
  if (base > 0) out.push({ subject: 'Révision quotidienne', minutes: base });
  return out;
}

/** Plafond de charge du jour (avant prise en compte du temps libre). */
export function capFor(state, date) {
  const s = state.settings;
  if ((state.hardDays || []).includes(date)) return { cap: Number(s.hardDayCap), reason: 'Journée difficile' };
  const weekend = weekday(date) >= 5;
  let cap = weekend ? Number(s.weekendLoad ?? 90) : Number(s.maxLoad);
  let reason = weekend ? 'Week-end : place aux grosses tâches' : null;
  // Soir de cours d'arabe : peu de temps entre le retour et le cours, on allège.
  const ar = s.arabic;
  if (ar?.enabled && arabicPlan(state, date)?.date === date && Number(ar.cap ?? 20) < cap) {
    cap = Number(ar.cap ?? 20);
    reason = `Soir de ${(ar.title || 'cours d’arabe').toLowerCase()} : charge réduite`;
  }
  for (const ex of state.exams) {
    const k = diffDays(date, ex.date);
    let c = null;
    let why = null;
    if (k === 0) [c, why] = [s.examCap, `Contrôle : ${ex.subject}`];
    else if (k === 1) [c, why] = [s.examCap, `Veille du contrôle : ${ex.subject}`];
    else if (k === 2 && ex.importance >= 2) [c, why] = [Math.round(s.maxLoad * 0.6), `${ex.subject} dans 2 jours`];
    else if (k === 3 && ex.importance >= 3) [c, why] = [Math.round(s.maxLoad * 0.8), `${ex.subject} dans 3 jours`];
    if (c != null && Number(c) < cap) [cap, reason] = [Number(c), why];
  }
  return { cap, reason };
}

/** Tout ce qu'il faut savoir sur une journée pour planifier et afficher. */
/**
 * Minutes de tâches possibles selon le temps libre de la journée :
 * 1 h → 0, 2 h → 5 min, 3 h → 15 min, 4 h → 30 min, 5 h → 50 min… (interpolé, arrondi à 5 min).
 */
const LOAD_SCALE = [[60, 0], [120, 5], [180, 15], [240, 30], [300, 50], [360, 75], [420, 105]];
export function loadForFree(free) {
  if (free <= LOAD_SCALE[0][0]) return 0;
  for (let i = 1; i < LOAD_SCALE.length; i += 1) {
    const [x1, y1] = LOAD_SCALE[i];
    if (free <= x1) {
      const [x0, y0] = LOAD_SCALE[i - 1];
      return Math.round((y0 + ((free - x0) * (y1 - y0)) / (x1 - x0)) / 5) * 5;
    }
  }
  const [xl, yl] = LOAD_SCALE.at(-1);
  return Math.round((yl + (free - xl) / 2) / 5) * 5;
}

export function dayInfo(state, date) {
  const blocks = blocksOn(state, date);
  const { total, awake } = busyMinutes(blocks, state.settings.wake, state.settings.sleep);
  const revisions = revisionsOn(state, date);
  const revisionMin = revisions.reduce((a, r) => a + r.minutes, 0);
  const free = Math.max(0, awake - total - revisionMin);
  const { cap: rawCap, reason: capReason } = capFor(state, date);
  const byFree = loadForFree(free);
  let reason = capReason;
  if (byFree < rawCap) {
    const h = fmtDuration(free);
    reason = byFree ? `${h} de libre : ${byFree} min de tâches max` : `Seulement ${h} de libre : pas de tâche`;
  }
  const cap = Math.max(0, Math.min(rawCap, byFree, free));
  const exams = state.exams.filter((e) => e.date === date);
  return {
    date, blocks, revisions, revisionMin, awake, busy: total, free, cap, rawCap, capReason: reason, exams,
    energy: awake ? free / awake : 0,
  };
}

/** Charge d'un jour. Les tâches fixes (poubelles) sont hors plafond : elles ont leur jour quoi qu'il arrive. */
export function loadOn(planned, date) {
  return planned
    .filter((p) => p.date === date && !p.locked && (p.status === 'todo' || p.status === 'done'))
    .reduce((a, p) => a + Number(p.duration || 0), 0);
}

/* ---------- Génération de la semaine ---------- */

function lastOccurrence(planned, tplId, before) {
  let last = null;
  for (const p of planned) {
    if (p.templateId !== tplId || !p.date || p.date >= before) continue;
    if (!DONE_LIKE.includes(p.status)) continue;
    if (!last || p.date > last) last = p.date;
  }
  return last;
}

function effectiveFreq(tpl, date) {
  if (tpl.freq !== 'seasonal') return tpl.freq;
  return (tpl.months || []).includes(month(date)) ? tpl.every || 'monthly' : null;
}

function fromTemplate(tpl, extra = {}) {
  return {
    id: uid('p'), templateId: tpl.id, name: tpl.name, duration: Number(tpl.duration), category: tpl.category,
    status: 'todo', priority: 0, ...extra,
  };
}

function pref(state, item) {
  const tpl = state.templates.find((t) => t.id === item.templateId);
  return { hate: tpl?.pref === 'hate' || (tpl?.difficulty ?? 1) >= 3, easy: tpl?.pref === 'easy', freq: tpl?.freq };
}

/** Score d'un jour pour une tâche : plus bas = mieux. null si le plafond serait dépassé. */
function scoreDay(state, ctx, item, date, idx, earlyWeight) {
  const info = ctx.info[date];
  const load = ctx.load[date] || 0;
  if (load + item.duration > info.cap) return null;
  const p = pref(state, item);
  let s = info.cap ? (load + item.duration) / info.cap : 1;
  if (p.freq !== 'daily') {
    const same = (d) => ctx.byTpl[`${item.templateId}|${d}`];
    if (same(date)) s += 2;
    if (same(addDays(date, -1)) || same(addDays(date, 1))) s += 0.6;
  }
  // Week-end : on y met en priorité les grosses tâches (≥ 20 min ou pénibles).
  if (weekday(date) >= 5 && p.freq !== 'daily') s += isBig(state, item) ? -0.6 : 0.3;
  if (p.hate) s += (1 - info.energy) * 0.8;
  if (p.easy) s += info.energy * 0.3;
  s += idx * earlyWeight;
  return s;
}

export function isBig(state, item) {
  const tpl = state.templates.find((t) => t.id === item.templateId);
  return Number(item.duration) >= 20 || (tpl?.difficulty ?? 1) >= 3;
}

function makeCtx(state, planned, dates) {
  const ctx = { info: {}, load: {}, byTpl: {} };
  for (const d of dates) {
    ctx.info[d] = dayInfo(state, d);
    ctx.load[d] = loadOn(planned, d);
  }
  for (const p of planned) {
    if (p.date && DONE_LIKE.includes(p.status)) ctx.byTpl[`${p.templateId}|${p.date}`] = true;
  }
  return ctx;
}

function place(ctx, item, date) {
  item.date = date;
  ctx.load[date] = (ctx.load[date] || 0) + item.duration;
  ctx.byTpl[`${item.templateId}|${date}`] = true;
}

function bestDay(state, ctx, item, dates, earlyWeight = 0) {
  let best = null;
  dates.forEach((d, i) => {
    if (!ctx.info[d]) return;
    const s = scoreDay(state, ctx, item, d, i, earlyWeight);
    if (s != null && (!best || s < best.s)) best = { d, s };
  });
  return best?.d ?? null;
}

/**
 * Génère (ou régénère) la semaine qui commence le lundi `ws`.
 * Les tâches déjà faites, déplacées à la main (pinned) ou passées sont conservées.
 * Retourne { planned, unplaced }.
 */
export function generateWeek(state, ws, today) {
  const dates = weekDates(ws);
  const weekEnd = dates[6];
  const start = today > ws ? today : ws;
  if (start > weekEnd) return { planned: state.planned, unplaced: [] };
  const usable = dates.filter((d) => d >= start);

  const kept = [];
  const carried = [];
  for (const p of state.planned) {
    const inRange = p.date && p.date >= start && p.date <= weekEnd;
    const removable = p.status === 'todo' && !p.pinned && (inRange || p.date == null);
    if (!removable) kept.push(p);
    else if (p.carried) carried.push({ ...p, date: null });
    else if (p.date == null) carried.push({ ...p, carried: true });
  }

  const inWeek = (p) => p.date && p.date >= ws && p.date <= weekEnd && DONE_LIKE.includes(p.status);
  const keptByTpl = {};
  for (const p of kept.filter(inWeek)) (keptByTpl[p.templateId] ||= []).push(p.date);
  for (const c of carried) (keptByTpl[c.templateId] ||= []).push('carried');

  const fixed = [];
  const demands = [];
  for (const tpl of state.templates) {
    if (tpl.active === false) continue;
    const f = effectiveFreq(tpl, dates[3]);
    if (!f) continue;
    const have = keptByTpl[tpl.id] || [];
    const last = lastOccurrence(state.planned.filter((p) => p.status === 'done' || kept.includes(p)), tpl.id, start);
    if (f === 'daily') {
      for (const d of usable) {
        if (tpl.fixedDay != null && tpl.fixedDay !== weekday(d)) continue;
        if (!have.includes(d)) demands.push({ item: fromTemplate(tpl), window: [d], latest: d, fixed: false });
      }
      continue;
    }
    if (have.length) continue;
    const earliest = last ? addDays(last, FREQ_TOLERANCE[f]) : ws;
    if (tpl.fixedDay != null) {
      const d = dates[tpl.fixedDay];
      if (d >= start && d >= earliest) fixed.push(fromTemplate(tpl, { date: d, locked: true }));
      continue;
    }
    const window = usable.filter((d) => d >= earliest);
    if (!window.length) continue;
    const latest = last ? addDays(last, FREQ_DAYS[f]) : weekEnd;
    // Une tâche espacée (15 jours, mois…) pas encore en retard peut attendre la semaine suivante.
    const deferrable = f !== 'weekly' && (!last || latest > weekEnd);
    demands.push({ item: fromTemplate(tpl), window, latest: latest < weekEnd ? latest : weekEnd, deferrable });
  }

  const planned = [...kept];
  const ctx = makeCtx(state, planned, dates);
  for (const f of fixed) {
    f.date = f.date || null;
    ctx.byTpl[`${f.templateId}|${f.date}`] = true;
    planned.push(f);
  }

  const unplaced = [];
  // 1. tâches en retard (rattrapage), priorité la plus haute d'abord, au plus tôt
  carried.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const c of carried) {
    const d = bestDay(state, ctx, c, usable, 0.35);
    if (d) place(ctx, c, d);
    else unplaced.push(c);
    planned.push(c);
  }
  // 2. urgence (échéance la plus proche, fenêtre la plus étroite), 3. préférence, puis les plus longues
  demands.sort((a, b) => {
    if (!!a.deferrable !== !!b.deferrable) return a.deferrable ? 1 : -1;
    if (a.latest !== b.latest) return a.latest < b.latest ? -1 : 1;
    if (a.window.length !== b.window.length) return a.window.length - b.window.length;
    const pa = pref(state, a.item).hate ? 0 : 1;
    const pb = pref(state, b.item).hate ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.item.duration - a.item.duration;
  });
  for (const { item, window, deferrable } of demands) {
    const d = bestDay(state, ctx, item, window);
    if (d) {
      place(ctx, item, d);
      planned.push(item);
    } else if (deferrable) {
      // reviendra la semaine prochaine
    } else if (window.length > 1) {
      // ne rentre nulle part sans dépasser le plafond : à placer à la main
      item.date = null;
      item.carried = true;
      planned.push(item);
      unplaced.push(item);
    } else {
      unplaced.push(item);
    }
  }

  // Tâche bonus de la semaine
  const bonusList = (state.bonusIdeas || []).filter(Boolean);
  const hasBonus = planned.some((p) => p.bonus && p.date >= ws && p.date <= weekEnd);
  if (!hasBonus && bonusList.length && state.settings.bonusEnabled !== false) {
    const recent = planned.filter((p) => p.bonus).map((p) => p.name);
    const weekNo = Math.floor(diffDays('2024-01-01', ws) / 7);
    const candidates = bonusList.filter((b) => !recent.slice(-4).includes(b.name));
    const pick = (candidates.length ? candidates : bonusList)[weekNo % (candidates.length || bonusList.length)];
    const item = { id: uid('p'), templateId: null, name: pick.name, duration: Number(pick.duration), category: 'bonus', status: 'todo', priority: 0, bonus: true };
    const d = bestDay(state, ctx, item, usable);
    if (d) {
      place(ctx, item, d);
      planned.push(item);
    }
  }

  return { planned, unplaced };
}

/* ---------- Rattrapage, journée difficile ---------- */

function tryPlaceAhead(state, planned, item, from, days = 14) {
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const ctx = makeCtx(state, planned, dates);
  const d = bestDay(state, ctx, item, dates, 0.35);
  item.date = d;
  return d;
}

/**
 * Tâches non faites avant `today` : reportées au prochain créneau libre avec une priorité plus haute.
 * Les tâches quotidiennes manquées ne sont pas reportées (on ne fait pas deux vaisselles le lendemain).
 */
export function rollover(state, today) {
  const planned = state.planned.map((p) => ({ ...p }));
  const moved = [];
  const newItems = [];
  for (const p of planned) {
    if (p.status !== 'todo' || !p.date || p.date >= today) continue;
    if (p.bonus) {
      p.status = 'skipped';
      continue;
    }
    const tpl = state.templates.find((t) => t.id === p.templateId);
    if (tpl?.freq === 'daily') {
      p.status = 'missed';
      continue;
    }
    p.status = 'postponed';
    const copy = { ...p, id: uid('p'), date: null, carried: true, pinned: false, locked: false, priority: (p.priority || 0) + 1, from: p.date };
    newItems.push(copy);
  }
  // Inclut aussi les tâches restées « à placer »
  for (const p of planned) if (p.status === 'todo' && p.date == null) newItems.push(p);
  const all = planned.filter((p) => !newItems.includes(p));
  newItems.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const it of newItems) {
    const d = tryPlaceAhead(state, all, it, today);
    all.push(it);
    if (d) moved.push(it);
  }
  return { planned: all, moved };
}

/** Allège une journée : on garde les tâches fixes, le reste part sur les jours suivants. */
export function hardDay(state, date) {
  const hardDays = [...new Set([...(state.hardDays || []), date])];
  const st = { ...state, hardDays };
  const planned = state.planned.map((p) => ({ ...p }));
  const toMove = [];
  for (const p of planned) {
    if (p.date !== date || p.status !== 'todo' || p.locked) continue;
    const tpl = state.templates.find((t) => t.id === p.templateId);
    if (p.bonus || tpl?.freq === 'daily') p.status = 'skipped';
    else toMove.push(p);
  }
  const rest = planned.filter((p) => !toMove.includes(p));
  for (const p of toMove) {
    p.carried = true;
    p.pinned = false;
    p.priority = (p.priority || 0) + 1;
    tryPlaceAhead(st, rest, p, addDays(date, 1), 7);
    rest.push(p);
  }
  return { planned: rest, hardDays, moved: toMove };
}

/**
 * Une tâche a été faite par quelqu'un d'autre : propose quoi faire à la place ce jour-là,
 * sans dépasser le plafond. D'abord avancer une tâche des jours suivants, puis une tâche
 * du catalogue qui n'est pas prévue prochainement, puis une idée bonus.
 */
export function suggestReplacements(state, date, limit = 5) {
  const room = dayInfo(state, date).cap - loadOn(state.planned, date);
  if (room <= 0) return { room: 0, items: [] };
  const tplOf = (id) => state.templates.find((t) => t.id === id);
  const onDate = new Set(state.planned.filter((p) => p.date === date && DONE_LIKE.includes(p.status)).map((p) => p.templateId));
  const horizon = addDays(date, 7);

  const advance = state.planned
    .filter((p) => p.status === 'todo' && p.date > date && p.date <= horizon && !p.locked && !p.bonus
      && p.templateId && tplOf(p.templateId)?.freq !== 'daily' && !onDate.has(p.templateId) && p.duration <= room)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.date.localeCompare(b.date) || b.duration - a.duration)
    .slice(0, 3)
    .map((p) => ({ kind: 'advance', id: p.id, name: p.name, duration: p.duration, category: p.category, from: p.date }));

  const soon = new Set(state.planned
    .filter((p) => p.date && p.date >= addDays(date, -6) && p.date <= addDays(date, 13) && DONE_LIKE.includes(p.status))
    .map((p) => p.templateId));
  const templates = state.templates
    .filter((t) => t.active !== false && t.fixedDay == null && !soon.has(t.id) && Number(t.duration) <= room)
    .filter((t) => {
      const f = effectiveFreq(t, date);
      return f && f !== 'daily';
    })
    .sort((a, b) => (a.pref === 'hate') - (b.pref === 'hate') || b.duration - a.duration)
    .slice(0, 2)
    .map((t) => ({ kind: 'template', tplId: t.id, name: t.name, duration: Number(t.duration), category: t.category }));

  const recentBonus = new Set(state.planned.filter((p) => p.bonus && p.date >= addDays(date, -14)).map((p) => p.name));
  const bonus = (state.bonusIdeas || [])
    .filter((b) => Number(b.duration) <= room && !recentBonus.has(b.name))
    .slice(0, 1)
    .map((b) => ({ kind: 'bonus', name: b.name, duration: Number(b.duration), category: 'bonus' }));

  return { room, items: [...advance, ...templates, ...bonus].slice(0, limit) };
}

/**
 * Remet chaque jour sous son plafond (si un contrôle, le cours d'arabe ou un changement d'EDT
 * l'a fait baisser) : les tâches en trop partent au prochain jour libre. Les tâches fixes,
 * quotidiennes ou déplacées à la main ne bougent pas.
 */
export function rebalance(state, from, days = 7) {
  const planned = state.planned.map((p) => ({ ...p }));
  const moved = [];
  const isDaily = (p) => state.templates.find((t) => t.id === p.templateId)?.freq === 'daily';
  for (let i = 0; i < days; i += 1) {
    const d = addDays(from, i);
    const cap = dayInfo(state, d).cap;
    let load = loadOn(planned, d);
    if (load <= cap) continue;
    const movable = planned
      .filter((p) => p.date === d && p.status === 'todo' && !p.locked && !p.pinned && !isDaily(p))
      .sort((a, b) => (a.bonus ? -1 : 0) - (b.bonus ? -1 : 0) || b.duration - a.duration);
    for (const p of movable) {
      if (load <= cap) break;
      for (let k = 1; k <= 7; k += 1) {
        const nd = addDays(d, k);
        if (loadOn(planned, nd) + Number(p.duration) <= dayInfo(state, nd).cap) {
          p.date = nd;
          load -= Number(p.duration);
          moved.push(p);
          break;
        }
      }
    }
  }
  return { planned, moved };
}

/** Prochain jour (à partir de `from`) où la tâche rentre sous le plafond. */
export function nextFreeDay(state, item, from, days = 14) {
  const others = state.planned.filter((p) => p.id !== item.id);
  for (let i = 0; i < days; i += 1) {
    const d = addDays(from, i);
    const info = dayInfo(state, d);
    if (loadOn(others, d) + Number(item.duration) <= info.cap) return d;
  }
  return null;
}
