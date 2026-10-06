import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStateForTests } from './helpers.mjs';
import { addDays, weekDates } from '../js/dates.js';
import { dayInfo, generateWeek, hardDay, loadOn, rollover, suggestReplacements } from '../js/scheduler.js';
import { computeStats } from '../js/stats.js';
import { diffEvents, normalizeEvent, shortType } from '../scripts/fetch-edt.mjs';

const WS = '2026-10-05'; // lundi

function week(state, today = WS) {
  const r = generateWeek(state, WS, today);
  state.planned = r.planned;
  return r;
}

test('les poubelles sont verrouillées sur leur jour', () => {
  const s = defaultStateForTests();
  week(s);
  const grise = s.planned.find((p) => p.name.includes('grise'));
  const jaune = s.planned.find((p) => p.name.includes('jaune'));
  assert.equal(grise.date, '2026-10-05');
  assert.equal(jaune.date, '2026-10-07');
  assert.ok(grise.locked && jaune.locked);
});

test('le plafond de charge quotidien n’est jamais dépassé (hors tâches fixes)', () => {
  const s = defaultStateForTests();
  s.exams.push({ id: 'x1', subject: 'Réseaux', date: '2026-10-08', importance: 3, kind: 'controle' });
  week(s);
  for (const d of weekDates(WS)) {
    const info = dayInfo(s, d);
    const load = s.planned.filter((p) => p.date === d && p.status === 'todo' && !p.locked).reduce((a, p) => a + p.duration, 0);
    const fixed = s.planned.filter((p) => p.date === d && p.locked).reduce((a, p) => a + p.duration, 0);
    assert.ok(load + fixed <= Math.max(info.cap, fixed), `${d}: ${load + fixed} > ${info.cap}`);
  }
});

test('la veille et le jour d’un contrôle ont un plafond réduit', () => {
  const s = defaultStateForTests();
  s.exams.push({ id: 'x1', subject: 'Maths', date: '2026-10-08', importance: 1, kind: 'controle' });
  assert.equal(dayInfo(s, '2026-10-07').rawCap, s.settings.examCap);
  assert.equal(dayInfo(s, '2026-10-08').rawCap, s.settings.examCap);
  assert.equal(dayInfo(s, '2026-10-09').rawCap, s.settings.maxLoad);
  assert.equal(dayInfo(s, '2026-10-07').revisions[0].subject, 'Maths');
});

test('les cours réduisent le temps libre', () => {
  const s = defaultStateForTests();
  s.settings.useEdt = true;
  s.settings.commuteMax = 0;
  s.edt = { events: [{ date: '2026-10-05', start: '08:00', end: '18:00', title: 'Cours' }] };
  const lundi = dayInfo(s, '2026-10-05');
  const mardi = dayInfo(s, '2026-10-06');
  assert.equal(mardi.free - lundi.free, 600);
  assert.equal(mardi.free, 16 * 60);
});

test('le trajet compte : pas de tâche avant d’être rentré, temps entre les cours inclus', () => {
  const s = defaultStateForTests();
  s.settings.useEdt = true;
  s.settings.wake = '06:00';
  s.edt = { events: [
    { date: '2026-10-05', start: '08:30', end: '10:30', title: 'Réseaux' },
    { date: '2026-10-05', start: '15:00', end: '18:00', title: 'TP' },
  ] };
  const info = dayInfo(s, '2026-10-05');
  const retour = info.blocks.find((b) => b.title === 'Trajet retour');
  assert.deepEqual([retour.start, retour.homeAt, retour.end], ['18:00', '19:40', '19:40']);
  // 6h50 → 19h40 hors de la maison (aller 1h40 + cours et trou de midi + retour 1h40)
  assert.equal(info.busy, 19 * 60 + 40 - (6 * 60 + 50));
  // Retour avec maman : 45 min au lieu de 1 h 40
  s.rides = { '2026-10-05|retour': true };
  assert.equal(dayInfo(s, '2026-10-05').blocks.find((b) => b.title === 'Trajet retour').end, '18:45');
  s.rides = {};
  // Pas de cours : pas de trajet
  assert.equal(dayInfo(s, '2026-10-06').busy, 0);
  // Activité marquée « loin de chez moi » : trajet compté aussi
  s.events.push({ id: 'w', title: 'Entreprise', repeat: true, weekday: 1, start: '09:00', end: '17:00', commute: true });
  assert.ok(dayInfo(s, '2026-10-06').blocks.some((b) => b.title === 'Trajet retour'));
});

test('une journée bien remplie ne reçoit pas de tâche qui ne rentre pas', () => {
  const s = defaultStateForTests();
  s.events.push({ id: 'e', title: 'Stage', repeat: true, weekday: 1, start: '07:00', end: '22:50', from: '2026-01-01' });
  week(s);
  const mardi = s.planned.filter((p) => p.date === '2026-10-06' && p.status === 'todo');
  assert.ok(loadOn(mardi, '2026-10-06') <= 10);
});

test('le catalogue par défaut tient dans 45 min par jour', () => {
  const s = defaultStateForTests();
  const r = week(s);
  assert.deepEqual(r.unplaced.map((p) => p.name), []);
});

test('une même tâche n’est pas planifiée deux fois dans la semaine', () => {
  const s = defaultStateForTests();
  week(s);
  week(s); // régénérer ne doit pas dupliquer
  const asp = s.planned.filter((p) => p.name === 'Aspirateur : salon' && p.status === 'todo');
  assert.equal(asp.length, 1);
  const vaisselle = s.planned.filter((p) => p.name.startsWith('Vaisselle'));
  assert.ok(vaisselle.length <= 7);
});

test('régénérer en milieu de semaine garde les tâches faites et passées', () => {
  const s = defaultStateForTests();
  week(s);
  const asp = s.planned.find((p) => p.name === 'Aspirateur : salon');
  asp.status = 'done';
  const before = s.planned.filter((p) => p.date && p.date < '2026-10-08').map((p) => p.id).sort();
  week(s, '2026-10-08');
  assert.equal(s.planned.filter((p) => p.name === 'Aspirateur : salon').length, 1);
  const after = s.planned.filter((p) => p.date && p.date < '2026-10-08').map((p) => p.id).sort();
  assert.deepEqual(after, before);
});

test('rattrapage : une tâche non faite est reportée avec une priorité plus haute', () => {
  const s = defaultStateForTests();
  week(s);
  const t = s.planned.find((p) => p.date === '2026-10-05' && !p.locked && p.name !== 'Vaisselle / lave-vaisselle');
  const lundiVaisselle = s.planned.find((p) => p.date === '2026-10-05' && p.name.startsWith('Vaisselle'));
  const { planned, moved } = rollover(s, '2026-10-06');
  if (t) {
    assert.equal(planned.find((p) => p.id === t.id).status, 'postponed');
    const copy = planned.find((p) => p.from === '2026-10-05' && p.name === t.name);
    assert.ok(copy && copy.priority === 1 && copy.date >= '2026-10-06');
    assert.ok(moved.length >= 1);
  }
  if (lundiVaisselle) assert.equal(planned.find((p) => p.id === lundiVaisselle.id).status, 'missed');
});

test('journée difficile : seules les tâches fixes restent', () => {
  const s = defaultStateForTests();
  week(s);
  const r = hardDay(s, '2026-10-05');
  const left = r.planned.filter((p) => p.date === '2026-10-05' && p.status === 'todo');
  assert.ok(left.every((p) => p.locked));
  assert.ok(r.hardDays.includes('2026-10-05'));
});

test('tâches saisonnières seulement pendant leur saison', () => {
  const s = defaultStateForTests();
  s.settings.maxLoad = 120;
  week(s);
  assert.ok(s.planned.some((p) => p.name === 'Ramasser les feuilles'));
  const s2 = defaultStateForTests();
  const r = generateWeek(s2, '2027-01-04', '2027-01-04');
  assert.ok(!r.planned.some((p) => p.name === 'Ramasser les feuilles' || p.name === 'Tondre la pelouse'));
});

test('une tâche bonus est proposée chaque semaine s’il reste de la place', () => {
  const s = defaultStateForTests();
  s.settings.maxLoad = 90;
  week(s);
  assert.equal(s.planned.filter((p) => p.bonus).length, 1);
});

test('tâche faite par quelqu’un d’autre : remplaçants proposés, pas de doublon en régénérant', () => {
  const s = defaultStateForTests();
  week(s);
  const asp = s.planned.find((p) => p.name === 'Aspirateur : salon');
  const day = asp.date;
  asp.status = 'other';
  const { room, items } = suggestReplacements(s, day);
  assert.ok(room >= asp.duration);
  assert.ok(items.length > 0);
  assert.ok(items.every((it) => it.duration <= room && it.name !== asp.name));
  assert.ok(items.filter((it) => it.kind === 'advance').every((it) => it.from > day));
  week(s); // l'aspirateur ne doit pas être reprogrammé cette semaine
  assert.equal(s.planned.filter((p) => p.name === 'Aspirateur : salon').length, 1);
  // ne compte pas dans les stats
  assert.equal(computeStats([{ date: '2026-10-05', status: 'other', duration: 10 }], '2026-10-06').percent, null);
});

test('statistiques : série et pourcentage', () => {
  const planned = [
    { date: '2026-10-03', status: 'done', duration: 10 },
    { date: '2026-10-04', status: 'done', duration: 10 },
    { date: '2026-10-05', status: 'done', duration: 10 },
    { date: '2026-10-05', status: 'missed', duration: 10 },
    { date: '2026-10-06', status: 'done', duration: 10 },
    { date: '2026-10-07', status: 'todo', duration: 10 },
  ];
  const st = computeStats(planned, '2026-10-07');
  assert.equal(st.streak, 1);
  assert.equal(st.percent, 80);
});

test('EDT : normalisation d’un événement Celcat', () => {
  const e = normalizeEvent({
    id: 'abc', start: '2026-09-28T08:30:00', end: '2026-09-28T10:30:00', allDay: false,
    description: 'CM<br />\r\n\r\nR5.01 Management<br />\r\n\r\nE207<br />\r\n\r\nRT3-FA<br />\r\n\r\nDUPONT Jean',
    eventCategory: 'CM', modules: ['R5.01 - Management de projet'],
  }, 'RT3-FA');
  assert.deepEqual([e.date, e.start, e.end, e.title, e.type, e.room], ['2026-09-28', '08:30', '10:30', 'R5.01 - Management de projet', 'CM', 'E207']);
});

test('EDT : format de l’IUT (enseignant, groupe, salle « 412 - VEL »)', () => {
  const e = normalizeEvent({
    id: 'z', start: '2026-10-06T13:00:00', end: '2026-10-06T14:30:00',
    description: 'TD<br />\r\n\r\nVANNIER Edwige<br />\r\n\r\nRT3-FA<br />\r\n\r\n412 - VEL<br />\r\n\r\nR5.07 Automatisation des tâches',
    eventCategory: 'TD', modules: [],
  }, 'RT3-FA-A1');
  assert.deepEqual([e.type, e.room, e.title, e.teachers[0]], ['TD', '412 - VEL', 'R5.07 Automatisation des tâches', 'VANNIER Edwige']);
});

test('EDT : la fiche détaillée Celcat est prioritaire', () => {
  const e = normalizeEvent({ id: 'y', start: '2026-10-06T15:00:00', end: '2026-10-06T16:30:00', description: 'FANCETT Jennifer<br />RT3-FA<br />513 - VEL', eventCategory: '' }, 'RT3-FA-A1', {
    elements: [
      { label: 'Catégorie', content: 'Travaux Pratiques' },
      { label: 'Matière', content: 'R5.13 Anglais', entityType: 100 },
      { label: 'Salle', content: '513 - VEL', entityType: 102 },
      { label: 'Enseignant', content: 'FANCETT Jennifer', entityType: 101 },
    ],
  });
  assert.deepEqual([e.type, e.title, e.room], ['TP', 'R5.13 Anglais', '513 - VEL']);
  assert.deepEqual(['Cours magistral', 'DS', 'Devoir surveillé', 'TD'].map(shortType), ['CM', 'DS', 'DS', 'TD']);
});

test('EDT : détection des cours ajoutés, déplacés et annulés', () => {
  const base = { start: '08:00', end: '10:00', title: 'Réseaux', room: 'E1' };
  const prev = [{ id: '1', date: '2026-10-07', ...base }, { id: '2', date: '2026-10-08', ...base }, { id: '0', date: '2026-10-01', ...base }];
  const next = [{ id: '1', date: '2026-10-07', ...base, start: '13:00', end: '15:00' }, { id: '3', date: '2026-10-09', ...base }];
  const c = diffEvents(prev, next, { today: '2026-10-06', prevTo: '2026-11-01', at: 'now' });
  assert.deepEqual(c.map((x) => x.kind), ['modified', 'removed', 'added']);
  assert.equal(addDays('2026-10-06', 1), '2026-10-07');
});

test('cours d’arabe : mardi ou mercredi selon l’heure de fin des cours', async () => {
  const { arabicPlan } = await import('../js/scheduler.js');
  const s = defaultStateForTests();
  s.settings.useEdt = true;
  const plan = (mar, mer) => {
    s.edt = { events: [
      ...(mar ? [{ date: '2026-10-06', start: '08:00', end: mar }] : []),
      ...(mer ? [{ date: '2026-10-07', start: '08:00', end: mer }] : []),
    ] };
    return arabicPlan(s, '2026-10-05').date;
  };
  assert.equal(plan('18:00', '16:00'), '2026-10-07'); // mardi trop tard → mercredi
  assert.equal(plan('16:00', '18:30'), '2026-10-06'); // mercredi trop tard → mardi
  assert.equal(plan('16:00', '16:00'), '2026-10-07'); // pareil → mercredi
  assert.equal(plan(null, null), '2026-10-07'); // pas cours → mercredi
  assert.equal(plan('15:00', '17:00'), '2026-10-06'); // plus tôt mardi → mardi
  assert.equal(plan('18:00', '18:15'), null); // trop tard les deux → pas de cours
  plan('16:00', '17:00');
  const mardi = dayInfo(s, '2026-10-06');
  assert.ok(mardi.blocks.some((b) => b.arabic && b.start === '20:00' && b.end === '23:00'));
  assert.ok(!dayInfo(s, '2026-10-07').blocks.some((b) => b.arabic));
});

test('temps libre restant compté à partir de maintenant', async () => {
  const { freeAfter } = await import('../js/scheduler.js');
  const s = defaultStateForTests();
  s.settings.useEdt = true;
  s.settings.arabic.enabled = false;
  s.edt = { events: [{ date: '2026-10-06', start: '13:00', end: '16:30', title: 'Cours' }] };
  const info = dayInfo(s, '2026-10-06');
  // À 13h32 : il ne reste que 18h10 → 23h00
  assert.equal(freeAfter(s, info, 13 * 60 + 32), 23 * 60 - (18 * 60 + 10));
  assert.equal(freeAfter(s, info, 7 * 60), info.free);
});
