// Suivi de régularité : série de jours réussis, pourcentage, historique par semaine.
import { addDays, weekStart } from './dates.js';

const counted = (p) => !p.bonus && p.date && ['todo', 'done', 'missed', 'postponed'].includes(p.status);

function dayResult(planned, date) {
  const items = planned.filter((p) => p.date === date && counted(p));
  if (!items.length) return null;
  return items.every((p) => p.status === 'done');
}

export function computeStats(planned, today) {
  // Série : jours consécutifs où tout a été fait (les jours sans tâche ne cassent pas la série).
  let streak = 0;
  let d = dayResult(planned, today) ? today : addDays(today, -1);
  for (let i = 0; i < 120; i += 1, d = addDays(d, -1)) {
    const r = dayResult(planned, d);
    if (r === null) continue;
    if (!r) break;
    streak += 1;
  }

  const from = addDays(today, -27);
  const past = planned.filter((p) => counted(p) && p.date >= from && p.date <= today);
  const due = past.filter((p) => p.date < today || p.status === 'done');
  const done = due.filter((p) => p.status === 'done').length;
  const percent = due.length ? Math.round((done / due.length) * 100) : null;

  const weeks = [];
  let ws = weekStart(today);
  for (let i = 0; i < 8; i += 1, ws = addDays(ws, -7)) {
    const we = addDays(ws, 6);
    const items = planned.filter((p) => counted(p) && p.date >= ws && p.date <= we && (p.date < today || p.status === 'done'));
    const ok = items.filter((p) => p.status === 'done');
    const bonus = planned.filter((p) => p.bonus && p.status === 'done' && p.date >= ws && p.date <= we).length;
    weeks.push({
      ws, total: items.length, done: ok.length, bonus,
      minutes: ok.reduce((a, p) => a + Number(p.duration || 0), 0),
      percent: items.length ? Math.round((ok.length / items.length) * 100) : null,
    });
  }
  const bonusTotal = planned.filter((p) => p.bonus && p.status === 'done').length;
  return { streak, percent, weeks, bonusTotal };
}
