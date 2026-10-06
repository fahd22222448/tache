// Trajets en transports en commun via PRIM (Île-de-France Mobilités, API Navitia).
// Pour chaque jour de cours : à quelle heure partir pour arriver avant le premier cours,
// et à quelle heure tu es rentré après le dernier.
//
// Variables d'environnement :
//   PRIM_API_KEY   clé PRIM (secret GitHub)
//   HOME_ADDRESS   ton adresse ou ton arrêt de départ (variable GitHub)
//   IUT_ADDRESS    adresse de l'IUT (défaut : 10 avenue de l'Europe, Vélizy)
//   ARRIVE_MARGIN  minutes d'avance avant le début du cours (défaut 10)
//   LEAVE_MARGIN   minutes entre la fin du cours et le départ de l'IUT (défaut 5)

const PRIM_BASE = process.env.PRIM_BASE || 'https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia';
const IUT_DEFAULT = '10 Avenue de l’Europe 78140 Vélizy-Villacoublay';

async function prim(path, params, key) {
  const url = `${PRIM_BASE}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { apiKey: key, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PRIM ${path} ${res.status} : ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
  return JSON.parse(text);
}

/** Adresse, arrêt ou coordonnées → identifiant Navitia. */
export async function geocode(q, key) {
  const m = String(q).trim().match(/^(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    // En Île-de-France la latitude (~48) est plus grande que la longitude (~2).
    const [lat, lon] = a > b ? [a, b] : [b, a];
    return { id: `${lon};${lat}`, name: `${lat}, ${lon}` };
  }
  const data = await prim('places', { q, count: '1' }, key);
  const p = data.places?.[0];
  if (!p) throw new Error(`Adresse introuvable : « ${q} »`);
  return { id: p.id, name: p.name };
}

const hhmm = (dt) => `${dt.slice(9, 11)}:${dt.slice(11, 13)}`;
const navDate = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
const addMin = (time, n) => {
  const t = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + n;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** Résumé lisible d'un itinéraire Navitia. */
export function simplifyJourney(j) {
  const legs = [];
  let walk = 0;
  for (const s of j.sections || []) {
    if (s.type === 'public_transport') {
      const d = s.display_informations || {};
      legs.push({
        mode: d.commercial_mode || d.physical_mode || 'Transport',
        line: d.code || d.label || d.name || '',
        color: d.color ? `#${d.color}` : null,
        textColor: d.text_color ? `#${d.text_color}` : null,
        direction: d.direction || '',
        from: s.from?.name || '',
        to: s.to?.name || '',
        dep: hhmm(s.departure_date_time),
        arr: hhmm(s.arrival_date_time),
        realtime: s.data_freshness === 'realtime',
      });
    } else if (s.type === 'street_network' || s.type === 'transfer' || s.type === 'crow_fly') {
      walk += Math.round((s.duration || 0) / 60);
    }
  }
  return {
    leave: hhmm(j.departure_date_time),
    arrive: hhmm(j.arrival_date_time),
    duration: Math.round((j.duration || 0) / 60),
    transfers: j.nb_transfers ?? Math.max(0, legs.length - 1),
    walk,
    legs,
    status: j.status || null,
  };
}

async function journey(key, from, to, date, time, represents) {
  const data = await prim('journeys', {
    from, to,
    datetime: navDate(date, time),
    datetime_represents: represents,
    count: '3',
    data_freshness: 'realtime',
  }, key);
  const list = (data.journeys || []).filter((j) => j.departure_date_time?.startsWith(date.replace(/-/g, '')));
  if (!list.length) throw new Error(data.error?.message || 'aucun itinéraire');
  const target = navDate(date, time);
  const pick = represents === 'arrival'
    // arriver à l'heure : le départ le plus tard parmi ceux qui arrivent avant l'heure voulue
    ? list.filter((j) => j.arrival_date_time <= target).sort((a, b) => b.departure_date_time.localeCompare(a.departure_date_time))[0] || list[0]
    // repartir : l'arrivée la plus tôt
    : [...list].sort((a, b) => a.arrival_date_time.localeCompare(b.arrival_date_time))[0];
  return simplifyJourney(pick);
}

/**
 * Calcule les trajets des jours de cours entre `from` et `to` (inclus).
 * Ne jette jamais d'erreur : en cas de souci, renvoie { ok: false, error }.
 */
export async function computeTrips(events, { from, to }) {
  const key = process.env.PRIM_API_KEY;
  const homeQ = process.env.HOME_ADDRESS;
  const info = { ok: false, computedAt: new Date().toISOString(), error: null };
  if (!key || !homeQ) {
    return { trips: {}, tripsInfo: { ...info, error: 'Trajets non configurés (PRIM_API_KEY et HOME_ADDRESS)' } };
  }
  const arriveMargin = Number(process.env.ARRIVE_MARGIN || 10);
  const leaveMargin = Number(process.env.LEAVE_MARGIN || 5);
  try {
    const home = await geocode(homeQ, key);
    const iut = await geocode(process.env.IUT_ADDRESS || IUT_DEFAULT, key);
    const byDate = {};
    for (const e of events) {
      if (e.date < from || e.date > to) continue;
      const d = (byDate[e.date] ||= { first: e.start, last: e.end });
      if (e.start < d.first) d.first = e.start;
      if (e.end > d.last) d.last = e.end;
    }
    const trips = {};
    let errors = 0;
    for (const [date, { first, last }] of Object.entries(byDate).sort()) {
      const t = {};
      try {
        t.aller = await journey(key, home.id, iut.id, date, addMin(first, -arriveMargin), 'arrival');
      } catch (e) {
        t.allerError = e.message;
        errors += 1;
      }
      try {
        t.retour = await journey(key, iut.id, home.id, date, addMin(last, leaveMargin), 'departure');
      } catch (e) {
        t.retourError = e.message;
        errors += 1;
      }
      trips[date] = t;
      const a = t.aller ? `départ ${t.aller.leave} → ${t.aller.arrive} (${t.aller.legs.map((l) => `${l.mode} ${l.line}`).join(', ')})` : `aller ✗ ${t.allerError}`;
      const r = t.retour ? `retour ${t.retour.leave} → ${t.retour.arrive}` : `retour ✗ ${t.retourError}`;
      console.log(`  🚌 ${date} (cours ${first}–${last}) : ${a} ; ${r}`);
    }
    return {
      trips,
      tripsInfo: { ...info, ok: errors === 0, error: errors ? `${errors} trajet(s) non calculé(s)` : null, home: home.name, iut: iut.name, arriveMargin, leaveMargin },
    };
  } catch (e) {
    console.error(`Trajets : ${e.message}`);
    return { trips: {}, tripsInfo: { ...info, error: e.message } };
  }
}

const GYM_DEFAULT = 'Basic-Fit Montlhéry';
const weekdayOf = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const datesBetween = (from, to) => {
  const out = [];
  for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

/**
 * Trajets maison ↔ salle de sport (Basic-Fit Montlhéry par défaut) pour chaque jour à venir :
 * week-end → arriver pour l'heure de la séance ; semaine → départ de référence en soirée.
 * Recalculés au plus toutes les 3 h (sinon on réutilise ceux de la dernière fois).
 */
export async function computeGymTrips({ from, to }, prev = null) {
  const key = process.env.PRIM_API_KEY;
  const homeQ = process.env.HOME_ADDRESS;
  const gymQ = process.env.GYM_ADDRESS || GYM_DEFAULT;
  const info = { ok: false, computedAt: new Date().toISOString(), error: null, query: gymQ };
  if (!key || !homeQ) return { gymTrips: {}, gymTripsInfo: { ...info, error: 'Trajets non configurés' } };
  const dates = datesBetween(from, to);
  const fresh = prev?.gymTripsInfo?.ok && prev.gymTripsInfo.query === gymQ
    && Date.now() - Date.parse(prev.gymTripsInfo.computedAt) < 3 * 3600 * 1000
    && dates.every((d) => prev.gymTrips?.[d]);
  if (fresh) {
    console.log('  Salle : trajets réutilisés (calculés il y a moins de 3 h)');
    return { gymTrips: Object.fromEntries(dates.map((d) => [d, prev.gymTrips[d]])), gymTripsInfo: prev.gymTripsInfo };
  }
  const weStart = process.env.GYM_WEEKEND_START || '10:00';
  const duration = Number(process.env.GYM_DURATION || 90);
  try {
    const home = await geocode(homeQ, key);
    const gym = await geocode(gymQ, key);
    console.log(`  Salle : « ${gymQ} » → ${gym.name}`);
    const gymTrips = {};
    let errors = 0;
    for (const date of dates) {
      const weekend = weekdayOf(date) >= 5;
      const t = {};
      try {
        t.aller = weekend
          ? await journey(key, home.id, gym.id, date, addMin(weStart, -5), 'arrival')
          : await journey(key, home.id, gym.id, date, '18:30', 'departure');
      } catch (e) { t.allerError = e.message; errors += 1; }
      try {
        t.retour = weekend
          ? await journey(key, gym.id, home.id, date, addMin(weStart, duration + 5), 'departure')
          : await journey(key, gym.id, home.id, date, '20:15', 'departure');
      } catch (e) { t.retourError = e.message; errors += 1; }
      gymTrips[date] = t;
      console.log(`  🏋 ${date} : aller ${t.aller ? `${t.aller.duration} min` : `✗ ${t.allerError}`} ; retour ${t.retour ? `${t.retour.duration} min` : `✗ ${t.retourError}`}`);
    }
    return { gymTrips, gymTripsInfo: { ...info, ok: errors === 0, error: errors ? `${errors} trajet(s) non calculé(s)` : null, home: home.name, gym: gym.name } };
  } catch (e) {
    console.error(`Trajets salle : ${e.message}`);
    return { gymTrips: prev?.gymTrips || {}, gymTripsInfo: { ...info, error: e.message } };
  }
}
