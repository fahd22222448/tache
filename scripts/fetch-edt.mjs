#!/usr/bin/env node
// Récupère l'emploi du temps Celcat de l'IUT, détecte les changements et écrit edt.json.
// Lancé par la GitHub Action à heures fixes (voir .github/workflows/pages.yml).
//
//   node scripts/fetch-edt.mjs --out _site/edt.json [--prev ancien.json]
//
// Variables d'environnement :
//   EDT_BASE      https://edt.iut-velizy.uvsq.fr
//   EDT_GROUP     RT3-FA-A1
//   EDT_WEEKS     nombre de semaines à récupérer (défaut 5)
//   PREVIOUS_URL  edt.json actuellement publié, pour détecter les changements
//   NTFY_TOPIC    (optionnel) sujet ntfy.sh pour recevoir une notification push en cas de changement
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeTrips } from './trips.mjs';

const BASE = process.env.EDT_BASE || 'https://edt.iut-velizy.uvsq.fr';
const GROUP = process.env.EDT_GROUP || 'RT3-FA-A1';
// À changer quand la façon de lire les cours change : évite de signaler tous les cours comme « modifiés ».
const PARSER_VERSION = 2;
const WEEKS = Number(process.env.EDT_WEEKS || 5);
const TZ = 'Europe/Paris';

export function parisToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(s, n) {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOf(s) {
  const wd = (new Date(`${s}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(s, -wd);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z#0-9]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}

/** Type de cours court : CM, TD, TP, DS, SAÉ, Projet… */
export function shortType(raw) {
  const s = String(raw || '').trim();
  const rules = [
    [/\b(ds|devoir surveill|contr[ôo]le|examen|partiel|évaluation|evaluation)\b/i, 'DS'],
    [/\b(cm|cours magistral|magistral|amphi)\b/i, 'CM'],
    [/\b(td|travaux dirig)/i, 'TD'],
    [/\b(tp|travaux pratiq)/i, 'TP'],
    [/\bsa[ée]\b|situation d.apprentissage/i, 'SAÉ'],
    [/projet/i, 'Projet'],
    [/soutenance/i, 'Soutenance'],
    [/r[ée]union|amphi de rentr/i, 'Réunion'],
  ];
  for (const [re, label] of rules) if (re.test(s)) return label;
  return s || 'Cours';
}

const isGroup = (l) => /^[A-Z]{1,5}\d?(-[A-Z0-9]+)+$/.test(l);
// Salles du type « 412 - VEL », « G105 », « Amphi A », « Salle 12 », « E207 - VEL »
const isRoom = (l) => l.length < 40
  && (/\s-\s(VEL|RAM|VLZ|RBT)\b/i.test(l) || /^(salle|amphi|labo|bât|bat)\b/i.test(l) || /^[A-Z]{0,2}\d{2,4}[A-Z]?$/.test(l));
const isPerson = (l) => /^[A-ZÀ-Ý' -]{2,}\s+[A-ZÀ-Ý][a-zà-ÿ'-]+(\s[A-ZÀ-Ý][a-zà-ÿ'-]+)*$/.test(l);

/** Transforme un événement Celcat brut (et, si dispo, sa fiche détaillée) en événement simple. */
export function normalizeEvent(raw, group = GROUP, side = null) {
  const lines = String(raw.description || '')
    .split(/<br\s*\/?>/i)
    .map((l) => decode(l.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const modules = Array.isArray(raw.modules) ? raw.modules.filter(Boolean) : [];
  const typeLine = lines.find((l) => shortType(l) !== l && l.length < 30);
  const sideGet = (re, type) => (side?.elements || [])
    .filter((e) => (type && e.entityType === type) || re.test(e.label || ''))
    .map((e) => decode(String(e.content || '')).trim())
    .filter(Boolean);
  const sideRooms = sideGet(/salle|room|local/i, 102);
  const sideTeachers = sideGet(/enseignant|staff|intervenant|prof/i, 101);
  const sideCategory = sideGet(/cat[ée]gorie|category|type/i)[0];
  const sideModule = sideGet(/mati[èe]re|module|enseignement/i, 100)[0];
  const rooms = sideRooms.length ? sideRooms : lines.filter(isRoom);
  const teachers = sideTeachers.length ? sideTeachers : lines.filter(isPerson);
  const typeRaw = sideCategory || raw.eventCategory || typeLine || '';
  const type = shortType(typeRaw);
  const rest = lines.filter((l) => !isGroup(l) && !rooms.includes(l) && !teachers.includes(l) && l !== typeLine && l !== raw.eventCategory);
  const room = [...new Set(rooms)].join(', ');
  const title = sideModule || modules[0] || rest.find((l) => /^(R|S|SAÉ|SAE)\s?\d/i.test(l)) || rest[0] || typeRaw || 'Cours';
  const start = String(raw.start || '');
  const end = String(raw.end || start);
  return {
    id: String(raw.id),
    date: start.slice(0, 10),
    start: raw.allDay ? '08:00' : start.slice(11, 16),
    end: raw.allDay ? '18:00' : end.slice(11, 16),
    title,
    type,
    typeRaw,
    room,
    teachers: [...new Set(teachers)],
    site: Array.isArray(raw.sites) ? raw.sites.filter(Boolean).join(', ') : '',
    details: lines,
  };
}

export async function fetchCelcat({ from, to, group = GROUP, base = BASE }) {
  const body = new URLSearchParams({
    start: from,
    end: to,
    resType: '103', // 103 = groupe d'étudiants
    calView: 'agendaWeek',
    'federationIds[]': group,
    colourScheme: '3',
  });
  const res = await fetch(`${base}/Home/GetCalendarData`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': 'Mozilla/5.0 (compatible; tache-edt-sync/1.0)',
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Celcat a répondu ${res.status}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Réponse non JSON (${text.slice(0, 80).replace(/\s+/g, ' ')}…)`);
  }
  if (!Array.isArray(data)) throw new Error('Réponse Celcat inattendue');
  // Fiche détaillée de chaque cours (salle, type, matière) : plus fiable que la description.
  const sides = await mapLimit(data, 5, (e) => fetchSideBar(e.id, base).catch(() => null));
  const okSides = sides.filter(Boolean).length;
  console.log(`Fiches détaillées : ${okSides}/${data.length}`);
  if (data.length) {
    console.log('Exemple brut :', JSON.stringify({ ...data[0], description: data[0]?.description }).slice(0, 600));
    if (sides[0]) console.log('Exemple fiche :', JSON.stringify(sides[0]).slice(0, 800));
  }
  return data
    .map((e, i) => normalizeEvent(e, group, sides[i]))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchSideBar(eventId, base = BASE) {
  const res = await fetch(`${base}/Home/GetSideBarEvent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': 'Mozilla/5.0 (compatible; tache-edt-sync/1.0)',
    },
    body: new URLSearchParams({ eventId: String(eventId) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(String(res.status));
  const json = await res.json();
  return Array.isArray(json?.elements) ? json : null;
}

const sig = (e) => `${e.date} ${e.start}-${e.end} ${e.title} ${e.room} ${e.type}`;

/** Compare l'ancien et le nouvel EDT : seuls les cours d'aujourd'hui et après, sur la période commune, comptent. */
export function diffEvents(prev, next, { today, prevTo, at }) {
  const changes = [];
  const oldById = new Map(prev.map((e) => [e.id, e]));
  const newById = new Map(next.map((e) => [e.id, e]));
  const inScope = (e) => e.date >= today && (!prevTo || e.date <= prevTo);
  for (const e of next) {
    if (!inScope(e)) continue;
    const old = oldById.get(e.id);
    if (!old) changes.push({ at, kind: 'added', date: e.date, start: e.start, end: e.end, title: e.title });
    else if (sig(old) !== sig(e)) {
      changes.push({
        at, kind: 'modified', date: e.date, start: e.start, end: e.end, title: e.title,
        before: `${old.date} ${old.start}–${old.end}${old.room && old.room !== e.room ? ` ${old.room}` : ''}`,
      });
    }
  }
  for (const e of prev) {
    if (inScope(e) && !newById.has(e.id)) changes.push({ at, kind: 'removed', date: e.date, start: e.start, end: e.end, title: e.title });
  }
  return changes.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

async function loadPrevious(path, url) {
  try {
    if (path) return JSON.parse(await readFile(path, 'utf8'));
    if (url) {
      const res = await fetch(`${url}?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return await res.json();
    }
  } catch (e) {
    console.warn(`Pas d'EDT précédent (${e.message})`);
  }
  return null;
}

async function notifyNtfy(topic, changes) {
  const fmt = (c) => {
    const [, m, d] = c.date.split('-');
    const verb = { added: 'Ajout', removed: 'Annulé', modified: 'Modifié' }[c.kind];
    return `${verb} ${d}/${m} ${c.start}-${c.end} : ${c.title}`;
  };
  const body = changes.slice(0, 8).map(fmt).join('\n') + (changes.length > 8 ? `\n… +${changes.length - 8}` : '');
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: 'Emploi du temps modifie', Tags: 'calendar', Priority: '4' },
      body,
    });
  } catch (e) {
    console.warn(`ntfy : ${e.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = opt('--out') || 'edt.json';
  const today = parisToday();
  const from = mondayOf(today);
  const to = addDays(from, WEEKS * 7 - 1);
  const at = new Date().toISOString();
  const prev = await loadPrevious(opt('--prev'), process.env.PREVIOUS_URL);

  let result;
  try {
    const events = await fetchCelcat({ from, to });
    // Changement de groupe ou de lecture : on repart de zéro au lieu de tout signaler comme modifié.
    const comparable = prev?.events?.length && prev.group === GROUP && prev.parserVersion === PARSER_VERSION;
    for (const e of events.slice(0, 12)) console.log(`  ${e.date} ${e.start}-${e.end} [${e.type}] ${e.title} @ ${e.room || '?'} (${e.teachers.join(', ')})`);
    const fresh = comparable
      ? diffEvents(prev.events, events, { today, prevTo: prev.range?.to, at })
      : [];
    const cutoff = addDays(today, -30);
    const changes = [...(comparable ? prev.changes || [] : []).filter((c) => c.at.slice(0, 10) >= cutoff), ...fresh].slice(-60);
    const sameEvents = prev && JSON.stringify(prev.events) === JSON.stringify(events);
    result = {
      group: GROUP, source: BASE, ok: true, error: null, parserVersion: PARSER_VERSION,
      range: { from, to },
      checkedAt: at,
      fetchedAt: at,
      updatedAt: sameEvents ? prev.updatedAt || at : at,
      events, changes,
      ...(await computeTrips(events, { from: today, to: addDays(today, 6) })),
    };
    console.log(`${events.length} cours du ${from} au ${to}, ${fresh.length} changement(s)`);
    for (const c of fresh) console.log(`  ${c.kind} ${c.date} ${c.start}-${c.end} ${c.title}`);
    if (fresh.length && process.env.NTFY_TOPIC) await notifyNtfy(process.env.NTFY_TOPIC, fresh);
  } catch (e) {
    console.error(`Échec de récupération de l'EDT : ${e.message}`);
    result = {
      group: GROUP, source: BASE, range: prev?.range || { from, to }, events: [], changes: [], ...prev,
      ok: false, error: e.message, checkedAt: at,
    };
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result, null, 1)}\n`);
  if (process.env.EDT_STRICT && !result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
