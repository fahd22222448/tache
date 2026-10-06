// Dates manipulées en chaînes locales "YYYY-MM-DD" ; lundi = jour 0.

export const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
export const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
export const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const pad = (n) => String(n).padStart(2, '0');

export function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO() {
  return iso(new Date());
}

export function addDays(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}

/** Nombre de jours de a vers b (b - a). */
export function diffDays(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

export function weekday(s) {
  return (parseISO(s).getDay() + 6) % 7;
}

export function weekStart(s) {
  return addDays(s, -weekday(s));
}

export function weekDates(ws) {
  return Array.from({ length: 7 }, (_, i) => addDays(ws, i));
}

export function month(s) {
  return Number(s.slice(5, 7));
}

export function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function fromMin(min) {
  const m = Math.max(0, Math.round(min));
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

export function fmtDuration(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${pad(r)}` : `${h} h`;
}

export function fmtDate(s, withDay = true) {
  const d = parseISO(s);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return withDay ? `${DAY_NAMES[weekday(s)]} ${base}` : base;
}
