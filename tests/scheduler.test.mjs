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
    assert.ok(load <= info.cap, `${d}: ${load} > ${info.cap}`);
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
  assert.equal(plan('15:00', '17:00'), '2026-10-07'); // mercredi finit avant 18h → mercredi
  assert.equal(plan('18:00', '18:15'), null); // trop tard les deux → pas de cours
  plan('16:00', '18:00');
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

test('le week-end reçoit les grosses tâches', async () => {
  const { isBig } = await import('../js/scheduler.js');
  const s = defaultStateForTests();
  week(s);
  const weekend = ['2026-10-10', '2026-10-11'];
  const big = s.planned.filter((p) => p.status === 'todo' && p.date && !p.locked && isBig(s, p));
  const onWeekend = big.filter((p) => weekend.includes(p.date)).reduce((a, p) => a + p.duration, 0);
  const total = big.reduce((a, p) => a + p.duration, 0);
  assert.ok(onWeekend / total >= 0.5, `${onWeekend}/${total} min de grosses tâches le week-end`);
  assert.equal(dayInfo(s, '2026-10-10').rawCap, 90);
});

test('trajets réels PRIM : heure de départ et de retour utilisées sauf avec maman', async () => {
  const { simplifyJourney } = await import('../scripts/trips.mjs');
  const aller = simplifyJourney({
    departure_date_time: '20261006T110700', arrival_date_time: '20261006T124500', duration: 5880, nb_transfers: 1,
    sections: [
      { type: 'street_network', duration: 420 },
      { type: 'public_transport', departure_date_time: '20261006T111400', arrival_date_time: '20261006T113000', from: { name: 'Mairie' }, to: { name: 'Gare' }, display_informations: { commercial_mode: 'Bus', code: '6', color: 'FF0000', direction: 'Gare' } },
      { type: 'public_transport', departure_date_time: '20261006T114000', arrival_date_time: '20261006T123500', from: { name: 'Gare' }, to: { name: 'Vélizy' }, display_informations: { commercial_mode: 'RER', code: 'C' } },
      { type: 'street_network', duration: 600 },
    ],
  });
  assert.deepEqual([aller.leave, aller.arrive, aller.duration, aller.walk, aller.legs.map((l) => l.line)], ['11:07', '12:45', 98, 17, ['6', 'C']]);
  const s = defaultStateForTests();
  s.settings.useEdt = true;
  s.settings.arabic.enabled = false;
  s.edt = {
    events: [{ date: '2026-10-06', start: '13:00', end: '16:30', title: 'Cours' }],
    trips: { '2026-10-06': { aller, retour: { leave: '16:38', arrive: '17:52', duration: 74, legs: [] } } },
  };
  const blocks = dayInfo(s, '2026-10-06').blocks;
  const a = blocks.find((b) => b.dir === 'aller');
  const r = blocks.find((b) => b.dir === 'retour');
  assert.deepEqual([a.start, a.journey.legs.length, r.homeAt], ['11:07', 2, '17:52']);
  s.rides = { '2026-10-06|retour': true };
  assert.equal(dayInfo(s, '2026-10-06').blocks.find((b) => b.dir === 'retour').homeAt, '17:15');
});

test('soir de cours d’arabe : plafond réduit et tâches en trop reportées', async () => {
  const { rebalance } = await import('../js/scheduler.js');
  const s = defaultStateForTests();
  s.settings.useEdt = true;
  s.edt = { events: [
    { date: '2026-10-06', start: '13:00', end: '16:30', title: 'Cours' },
    { date: '2026-10-07', start: '09:00', end: '18:30', title: 'Cours' },
  ] };
  // Mercredi finit trop tard → arabe mardi
  assert.equal(dayInfo(s, '2026-10-06').rawCap, 20);
  assert.match(dayInfo(s, '2026-10-06').capReason, /arabe/);
  assert.equal(dayInfo(s, '2026-10-07').rawCap, 50);
  // Une journée trop chargée est rééquilibrée, la vaisselle (quotidienne) reste
  const vaisselle = s.templates.find((t) => t.freq === 'daily');
  const add = (name, duration, extra = {}) => s.planned.push({ id: name, templateId: extra.tpl || null, name, duration, date: '2026-10-06', status: 'todo', ...extra });
  add('vaisselle', 15, { tpl: vaisselle.id });
  add('linge', 15);
  add('micro', 10);
  add('poubelle', 5, { locked: true });
  const { planned, moved } = rebalance(s, '2026-10-06');
  const mardi = planned.filter((p) => p.date === '2026-10-06').map((p) => p.name).sort();
  assert.deepEqual(mardi, ['poubelle', 'vaisselle']);
  assert.equal(moved.length, 2);
  assert.ok(moved.every((p) => p.date > '2026-10-06'));
});

test('salle de sport : week-end fixe + meilleur jour en semaine', async () => {
  const { gymPlan } = await import('../js/scheduler.js');
  const s = defaultStateForTests();
  s.settings.gym.enabled = true;
  s.settings.useEdt = true;
  s.edt = { events: [
    { date: '2026-10-05', start: '08:00', end: '17:00', title: 'L' },
    { date: '2026-10-06', start: '13:00', end: '16:30', title: 'M' },
    { date: '2026-10-07', start: '09:00', end: '17:00', title: 'Me' },
    { date: '2026-10-08', start: '08:15', end: '17:30', title: 'J' },
    { date: '2026-10-09', start: '11:00', end: '17:30', title: 'V' },
  ] };
  // Samedi : séance fixe à 10h
  assert.ok(dayInfo(s, '2026-10-10').blocks.some((b) => b.kind === 'sport' && b.start === '10:00' && b.end === '11:30'));
  // Tous les jours de cours, retour après 17h45 → pas de séance en plus (week-end seulement)
  let plan = gymPlan(s, '2026-10-05');
  assert.equal(plan.chosen, null);
  assert.match(plan.ranked.find((o) => o.day === 1).why[0], /trop tard/);
  const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  assert.equal(days.filter((d) => dayInfo(s, d).blocks.some((b) => b.kind === 'sport')).length, 0);
  // Jeudi sans cours → séance jeudi à 10h
  s.edt.events = s.edt.events.filter((e) => e.date !== '2026-10-08');
  plan = gymPlan(s, '2026-10-05');
  assert.equal(plan.chosen.date, '2026-10-08');
  assert.equal(plan.chosen.slot.start, '10:00');
  // Mardi, rentré tôt avec maman (16h30 + 45 min) → séance possible à 17h30
  s.rides = { '2026-10-06|retour': true };
  assert.equal(gymPlan(s, '2026-10-05').ranked.find((o) => o.day === 1).slot.start, '17:30');
  // Choix manuel respecté
  s.settings.gym.pick = { '2026-10-05': 1 };
  assert.equal(gymPlan(s, '2026-10-05').chosen.date, '2026-10-06');
});

test('salle de sport : trajet IDF Mobilités pris en compte', () => {
  const s = defaultStateForTests();
  s.settings.gym.enabled = true;
  s.edt = { events: [], gymTrips: { '2026-10-10': { aller: { duration: 25, legs: [] }, retour: { duration: 30, legs: [] } } } };
  const b = dayInfo(s, '2026-10-10').blocks.find((x) => x.kind === 'sport');
  assert.deepEqual([b.start, b.end, b.session[0], b.session[1]], ['09:35', '12:00', '10:00', '11:30']);
});

test('tâches selon le temps libre : 1 h → 0, 2 h → 5, 3 h → 15, 4 h → 30, plafond 50 en semaine', async () => {
  const { loadForFree } = await import('../js/scheduler.js');
  assert.deepEqual([60, 120, 180, 240, 300, 150].map(loadForFree), [0, 5, 15, 30, 50, 10]);
  const s = defaultStateForTests();
  const free = (h) => {
    s.events = [{ id: 'x', title: 'occupé', repeat: false, date: '2026-10-06', start: s.settings.wake, end: `${String(23 - h).padStart(2, '0')}:00` }];
    return dayInfo(s, '2026-10-06').cap;
  };
  assert.deepEqual([free(1), free(2), free(3), free(4), free(8)], [0, 5, 15, 30, 50]);
  // Le week-end garde son plafond (90) quand il y a du temps
  assert.equal(dayInfo(s, '2026-10-10').cap, 90);
});

test('aujourd’hui : plafond selon le temps libre restant, le reste est reporté', async () => {
  const { rebalance } = await import('../js/scheduler.js');
  const s = defaultStateForTests();
  const vaisselle = s.templates.find((t) => t.freq === 'daily');
  s.planned = [
    { id: 'v', templateId: vaisselle.id, name: 'vaisselle', duration: 15, date: '2026-10-06', status: 'todo' },
    { id: 'a', templateId: null, name: 'linge', duration: 15, date: '2026-10-06', status: 'todo' },
    { id: 'b', templateId: null, name: 'frigo', duration: 5, date: '2026-10-06', status: 'todo' },
    { id: 'c', templateId: null, name: 'aspi', duration: 10, date: '2026-10-06', status: 'done' },
  ];
  // Le matin : toute la journée devant soi
  s.clock = { date: '2026-10-06', minutes: 8 * 60 };
  assert.equal(dayInfo(s, '2026-10-06').cap, 50);
  // 21h20 avant un coucher à 23h : 1 h 40 de libre → seulement la vaisselle (15) + 10 min déjà faites
  s.clock = { date: '2026-10-06', minutes: 21 * 60 + 20 };
  const info = dayInfo(s, '2026-10-06');
  assert.equal(info.cap, 25);
  assert.match(info.capReason, /Plus que 1 h 40/);
  const { planned } = rebalance(s, '2026-10-06');
  const left = planned.filter((p) => p.date === '2026-10-06').map((p) => p.id).sort();
  assert.deepEqual(left, ['c', 'v']); // la tâche faite et la vaisselle restent
});
