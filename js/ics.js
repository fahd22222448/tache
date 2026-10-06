// Export .ics : les tâches et les rappels arrivent dans l'agenda du téléphone, avec alarme.
import { addDays, toMin, fromMin } from './dates.js';

const esc = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
const stamp = (date, hhmm) => `${date.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;

export function buildICS(state, today, days = 14) {
  const end = addDays(today, days);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tache//planning//FR', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Tâches maison'];
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const remind = state.settings.reminderTime || '19:30';
  const byDay = {};
  for (const p of state.planned) {
    if (p.status !== 'todo' || !p.date || p.date < today || p.date > end) continue;
    (byDay[p.date] ||= []).push(p);
  }
  for (const [date, items] of Object.entries(byDay)) {
    const total = items.reduce((a, p) => a + Number(p.duration), 0);
    const startMin = toMin(remind);
    lines.push(
      'BEGIN:VEVENT', `UID:tache-${date}@tache`, `DTSTAMP:${now}`,
      `DTSTART:${stamp(date, remind)}`, `DTEND:${stamp(date, fromMin(startMin + Math.max(total, 10)))}`,
      `SUMMARY:${esc(`Tâches (${total} min)`)}`,
      `DESCRIPTION:${esc(items.map((p) => `• ${p.name} (${p.duration} min)`).join('\n'))}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc('Tâches du jour')}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT',
    );
    for (const p of items.filter((i) => i.locked)) {
      const eve = addDays(date, -1);
      lines.push(
        'BEGIN:VEVENT', `UID:tache-fixe-${p.id}@tache`, `DTSTAMP:${now}`,
        `DTSTART:${stamp(eve, remind)}`, `DTEND:${stamp(eve, fromMin(toMin(remind) + 5))}`,
        `SUMMARY:${esc(`Demain : ${p.name}`)}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(p.name)}`, 'TRIGGER:PT0M', 'END:VALARM',
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
