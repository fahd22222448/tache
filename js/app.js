import {
  DAY_NAMES, DAY_SHORT, addDays, fmtDate, fmtDuration, iso, toMin, todayISO, weekDates, weekStart, weekday,
} from './dates.js';
import {
  arabicPlan, dayInfo, freeAfter, generateWeek, gymPlan, hardDay, loadOn, nextFreeDay, rebalance, rollover, suggestReplacements, uid,
} from './scheduler.js';
import { CATEGORIES, FREQS, IMPORTANCE, defaultState, exportJSON, importJSON, load, save } from './store.js';
import { computeStats } from './stats.js';
import { buildICS } from './ics.js';
import { fetchEdt, unseenChanges } from './edt.js';
import { icon, modeIcon } from './icons.js';

let state = load();
const ui = { progDate: null, tab: 'today', ws: weekStart(todayISO()), sheet: null, toast: null, edtError: null };
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cat = (k) => CATEGORIES[k] || { label: k || '—', icon: 'list' };
const byId = (id) => state.planned.find((p) => p.id === id);

function commit(fn) {
  if (fn) fn();
  save(state);
  render();
}

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(ui.toast);
  ui.toast = setTimeout(() => $toast.classList.remove('show'), 3200);
}

/* ---------- Maintenance quotidienne ---------- */

/** Remet les jours à venir sous leur plafond (après un changement d'EDT, de réglage…). */
/** Plafond de chaque jour restant de la semaine : s'il change, la répartition n'est plus bonne. */
function capSignature(ws) {
  const today = todayISO();
  return weekDates(ws).filter((d) => d >= today).map((d) => `${d}:${dayInfo(state, d).cap}`).join('|');
}

/**
 * Garde un planning cohérent : si les plafonds de la semaine ont changé (EDT, cours d'arabe,
 * contrôle, réglages…), la semaine est replanifiée à partir d'aujourd'hui (tâches faites et
 * déplacées à la main conservées). Ensuite, aucun jour à venir ne dépasse son plafond.
 */
function keepUnderCap() {
  const today = todayISO();
  const ws = weekStart(today);
  const sig = capSignature(ws);
  const known = state.meta.capSig?.[ws];
  const hasPlan = state.planned.some((p) => p.date >= ws && p.date <= addDays(ws, 6) && !p.locked);
  let msg = null;
  if (hasPlan && known !== sig) {
    state.planned = generateWeek(state, ws, today).planned;
    msg = 'Semaine réajustée selon ton nouveau programme';
  }
  state.meta.capSig = { [ws]: sig };
  const { planned, moved } = rebalance(state, today);
  state.planned = planned;
  save(state);
  if (moved.length && !msg) msg = `${moved.length} tâche(s) déplacée(s) pour ne pas dépasser le plafond`;
  if (msg) toast(msg);
}

function dailyMaintenance() {
  const today = todayISO();
  if (state.meta.lastRollover === today) return;
  const { planned, moved } = rollover(state, today);
  state.planned = planned;
  const old = addDays(today, -60);
  state.hardDays = (state.hardDays || []).filter((d) => d >= old);
  state.rides = Object.fromEntries(Object.entries(state.rides || {}).filter(([k]) => k.slice(0, 10) >= addDays(today, -7)));
  ui.progDate = null;
  state.planned = state.planned.filter((p) => !p.date || p.date >= addDays(today, -120));
  state.meta.lastRollover = today;
  save(state);
  if (moved.length) toast(`${moved.length} tâche(s) en retard reportée(s) au prochain créneau libre`);
}

async function refreshEdt(manual = false) {
  if (!state.settings.useEdt || !state.settings.edtUrl) return;
  try {
    const data = await fetchEdt(state.settings.edtUrl);
    ui.edtError = null;
    const changed = !state.edt || state.edt.fetchedAt !== data.fetchedAt || state.edt.updatedAt !== data.updatedAt;
    state.edt = data;
    save(state);
    if (changed) keepUnderCap();
    const fresh = unseenChanges(data, state.edtSeen, todayISO());
    if (changed && fresh.length && state.settings.notifications) {
      notify('Emploi du temps modifié', fresh.slice(0, 3).map(describeChange).join('\n'), 'edt');
    }
    if (manual) toast('Emploi du temps à jour');
    render();
  } catch (e) {
    ui.edtError = e.message;
    if (manual) toast(e.message);
    render();
  }
}

/* ---------- Notifications ---------- */

function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag, icon: 'icon.svg', badge: 'icon.svg' };
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(() => new Notification(title, opts));
  } else new Notification(title, opts);
}

function departureReminder(now) {
  const today = iso(now);
  const sent = state.meta.lastNotified || (state.meta.lastNotified = {});
  if (sent.leave === today || state.rides?.[`${today}|aller`]) return;
  const aller = dayInfo(state, today).blocks.find((b) => b.dir === 'aller' && b.journey);
  if (!aller) return;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const leave = toMin(aller.journey.leave);
  if (minutes >= leave - 15 && minutes < leave) {
    const l = aller.journey.legs[0];
    notify(`Pars dans ${leave - minutes} min (${aller.journey.leave})`,
      l ? `${l.mode} ${l.line} à ${l.dep} — ${l.from}. Arrivée ${aller.journey.arrive}.` : `Arrivée ${aller.journey.arrive}.`, 'leave');
    sent.leave = today;
    save(state);
  }
}

function tick() {
  dailyMaintenance();
  if (state.settings.notifications) departureReminder(new Date());
  // Le temps libre restant dépend de l'heure : on rafraîchit la page du jour.
  if (ui.tab === 'today' && !ui.sheet && document.visibilityState === 'visible') render();
  if (!state.settings.notifications) return;
  const now = new Date();
  const today = iso(now);
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < toMin(state.settings.reminderTime)) return;
  const sent = state.meta.lastNotified || (state.meta.lastNotified = {});
  if (sent.daily !== today) {
    const left = state.planned.filter((p) => p.date === today && p.status === 'todo');
    if (left.length) {
      notify(`Encore ${left.length} tâche(s) aujourd'hui`, left.map((p) => `• ${p.name} (${p.duration} min)`).join('\n'), 'daily');
    }
    sent.daily = today;
  }
  if (sent.fixed !== today) {
    const tomorrow = addDays(today, 1);
    const fixed = state.planned.filter((p) => p.date === tomorrow && p.locked && p.status === 'todo');
    const todayFixed = state.planned.filter((p) => p.date === today && p.locked && p.status === 'todo');
    const all = [...todayFixed.map((p) => `Aujourd'hui : ${p.name}`), ...fixed.map((p) => `Demain : ${p.name}`)];
    if (all.length) notify('Rappel poubelles', all.join('\n'), 'fixed');
    sent.fixed = today;
  }
  save(state);
}

/* ---------- Actions ---------- */

function generate(ws) {
  const { planned, unplaced } = generateWeek(state, ws, todayISO());
  state.planned = planned;
  if (ws === weekStart(todayISO())) state.meta.capSig = { [ws]: capSignature(ws) };
  state.meta.validated = { ...(state.meta.validated || {}), [ws]: false };
  save(state);
  render();
  toast(unplaced.length
    ? `Semaine générée — ${unplaced.length} tâche(s) ne rentrent pas sous le plafond`
    : 'Semaine générée. Vérifie puis valide.');
}

function describeChange(c) {
  const when = `${fmtDate(c.date)} ${c.start}–${c.end}`;
  if (c.kind === 'added') return `Ajout : ${c.title} (${when})`;
  if (c.kind === 'removed') return `Annulé : ${c.title} (${when})`;
  const before = c.before?.replace(/^(\d{4}-\d{2}-\d{2})/, (d) => fmtDate(d));
  return `Modifié : ${c.title} → ${when}${before ? ` (avant : ${before})` : ''}`;
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const actions = {
  tab: (el) => { ui.tab = el.dataset.tab; window.scrollTo(0, 0); render(); },
  'week-prev': () => { ui.ws = addDays(ui.ws, -7); render(); },
  'week-next': () => { ui.ws = addDays(ui.ws, 7); render(); },
  'week-today': () => { ui.ws = weekStart(todayISO()); render(); },
  generate: (el) => generate(el.dataset.ws || ui.ws),
  validate: (el) => commit(() => { state.meta.validated = { ...(state.meta.validated || {}), [el.dataset.ws]: true }; toast('Semaine validée'); }),
  'task-menu': (el) => openSheet({ type: 'task', id: el.dataset.id }),
  postpone: (el) => {
    const p = byId(el.dataset.id);
    const d = nextFreeDay(state, p, addDays(p.date || todayISO(), p.date ? 1 : 0));
    commit(() => {
      p.date = d;
      p.pinned = true;
      p.carried = !d;
    });
    closeSheet();
    toast(d ? `Reporté à ${fmtDate(d)}` : 'Aucun créneau libre : la tâche est dans « À placer »');
  },
  'done-by-other': (el) => {
    const p = byId(el.dataset.id);
    const date = p.date || todayISO();
    commit(() => {
      p.status = 'other';
      p.doneAt = new Date().toISOString();
      if (!p.date) p.date = date;
    });
    openSheet({ type: 'replace', date, name: p.name });
  },
  'replace-advance': (el) => {
    const p = byId(el.dataset.id);
    commit(() => { p.date = el.dataset.date; p.pinned = true; p.carried = false; });
    closeSheet();
    toast(`« ${p.name} » avancée à ${el.dataset.date === todayISO() ? 'aujourd’hui' : fmtDate(el.dataset.date)}`);
  },
  'replace-tpl': (el) => {
    const t = state.templates.find((x) => x.id === el.dataset.tpl);
    commit(() => {
      state.planned.push({ id: uid('p'), templateId: t.id, name: t.name, duration: Number(t.duration), category: t.category, status: 'todo', priority: 0, date: el.dataset.date, pinned: true });
    });
    closeSheet();
    toast(`« ${t.name} » ajoutée`);
  },
  'replace-bonus': (el) => {
    commit(() => {
      state.planned.push({ id: uid('p'), templateId: null, name: el.dataset.name, duration: Number(el.dataset.duration), category: 'bonus', status: 'todo', priority: 0, bonus: true, date: el.dataset.date, pinned: true });
    });
    closeSheet();
    toast('Bonus ajouté');
  },
  'replace-none': () => { closeSheet(); toast('OK, ce temps reste libre'); },
  ride: (el) => {
    state.rides ||= {};
    commit(() => {
      if (state.rides[el.dataset.key]) delete state.rides[el.dataset.key];
      else state.rides[el.dataset.key] = true;
    });
  },
  'prog-prev': () => { shiftProg(-1); },
  'prog-next': () => { shiftProg(1); },
  'prog-today': () => { ui.progDate = null; render(); },
  'gym-menu': (el) => openSheet({ type: 'gym', date: el.dataset.date }),
  'gym-pick': (el) => {
    const g = state.settings.gym;
    commit(() => { g.pick = { ...(g.pick || {}), [el.dataset.ws]: Number(el.dataset.day) }; });
    closeSheet();
    keepUnderCap();
    render();
    toast('Séance de sport déplacée');
  },
  'gym-auto': (el) => {
    const g = state.settings.gym;
    commit(() => { const p = { ...(g.pick || {}) }; delete p[el.dataset.ws]; g.pick = p; });
    closeSheet();
    keepUnderCap();
    render();
    toast('Jour choisi automatiquement');
  },
  'move-menu': (el) => openSheet({ type: 'move', id: el.dataset.id }),
  'move-to': (el) => {
    const p = byId(el.dataset.id);
    commit(() => { p.date = el.dataset.date; p.pinned = true; p.carried = false; });
    closeSheet();
    toast(`Déplacé à ${fmtDate(el.dataset.date)}`);
  },
  'swap-menu': (el) => openSheet({ type: 'swap', id: el.dataset.id }),
  'swap-with': (el) => {
    const a = byId(el.dataset.id);
    const b = byId(el.dataset.other);
    commit(() => {
      [a.date, b.date] = [b.date, a.date];
      a.pinned = true;
      b.pinned = true;
    });
    closeSheet();
    toast('Tâches échangées');
  },
  'delete-task': (el) => {
    commit(() => { state.planned = state.planned.filter((p) => p.id !== el.dataset.id); });
    closeSheet();
    toast('Tâche supprimée');
  },
  'hard-day': (el) => {
    const date = el.dataset.date;
    if (!confirm('Alléger cette journée ? Seules les tâches fixes restent, le reste est réparti sur les jours suivants.')) return;
    const r = hardDay(state, date);
    commit(() => { state.planned = r.planned; state.hardDays = r.hardDays; });
    toast(`Journée allégée : ${r.moved.length} tâche(s) déplacée(s)`);
  },
  'undo-hard-day': (el) => commit(() => { state.hardDays = state.hardDays.filter((d) => d !== el.dataset.date); }),
  'edt-refresh': () => refreshEdt(true),
  'edt-seen': () => commit(() => { state.edtSeen = new Date().toISOString(); }),
  'edt-regen': () => { state.edtSeen = new Date().toISOString(); generate(weekStart(todayISO())); },
  'add-event': () => openSheet({ type: 'event' }),
  'edit-event': (el) => openSheet({ type: 'event', id: el.dataset.id }),
  'del-event': (el) => { commit(() => { state.events = state.events.filter((e) => e.id !== el.dataset.id); }); closeSheet(); },
  'add-exam': () => openSheet({ type: 'exam' }),
  'edit-exam': (el) => openSheet({ type: 'exam', id: el.dataset.id }),
  'del-exam': (el) => { commit(() => { state.exams = state.exams.filter((e) => e.id !== el.dataset.id); }); closeSheet(); },
  'add-tpl': () => openSheet({ type: 'tpl' }),
  'edit-tpl': (el) => openSheet({ type: 'tpl', id: el.dataset.id }),
  'del-tpl': (el) => {
    if (!confirm('Supprimer cette tâche du catalogue ?')) return;
    commit(() => {
      state.templates = state.templates.filter((t) => t.id !== el.dataset.id);
      state.planned = state.planned.filter((p) => !(p.templateId === el.dataset.id && p.status === 'todo'));
    });
    closeSheet();
  },
  'set-pref': (el) => commit(() => { state.templates.find((t) => t.id === el.dataset.id).pref = el.dataset.pref; }),
  'notif-on': async () => {
    if (!('Notification' in window)) return toast('Notifications non supportées sur ce navigateur');
    const p = await Notification.requestPermission();
    commit(() => { state.settings.notifications = p === 'granted'; });
    toast(p === 'granted' ? 'Rappels activés' : 'Notifications refusées');
    if (p === 'granted') notify('Rappels activés', `Je te rappellerai tes tâches à ${state.settings.reminderTime}.`, 'test');
  },
  'notif-off': () => commit(() => { state.settings.notifications = false; }),
  'export-ics': () => download('taches.ics', buildICS(state, todayISO()), 'text/calendar'),
  'export-json': () => download(`tache-sauvegarde-${todayISO()}.json`, exportJSON(state), 'application/json'),
  'import-json': () => document.getElementById('import-file').click(),
  reset: () => {
    if (!confirm('Tout effacer et repartir de zéro ?')) return;
    state = defaultState();
    commit();
  },
  'close-sheet': () => closeSheet(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.act];
  if (fn) {
    e.preventDefault();
    fn(el);
  }
});

// Glisser à gauche / à droite sur « Mon programme » pour changer de jour.
let touch = null;
document.addEventListener('touchstart', (e) => {
  if (!e.target.closest('[data-swipe="prog"]')) return;
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftProg(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'toggle') {
    const p = byId(el.dataset.id);
    commit(() => {
      p.status = el.checked ? 'done' : 'todo';
      p.doneAt = el.checked ? new Date().toISOString() : null;
    });
    if (el.checked) {
      const left = state.planned.filter((x) => x.date === p.date && x.status === 'todo' && !x.bonus);
      toast(left.length ? `Bien joué ! Encore ${left.length}` : 'Tout est fait pour aujourd’hui');
    }
  } else if (el.id === 'import-file' && el.files[0]) {
    el.files[0].text().then((t) => {
      try {
        state = importJSON(t);
        commit();
        toast('Sauvegarde importée');
      } catch (err) {
        toast(err.message);
      }
    });
  } else if (el.dataset.toggleShow) {
    const target = document.getElementById(el.dataset.toggleShow);
    if (target) target.hidden = el.value !== el.dataset.showWhen;
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const id = form.dataset.id;
  if (kind === 'event') {
    if (f.end <= f.start) return toast('L’heure de fin doit être après le début');
    const ev = {
      id: id || uid('e'), title: f.title.trim(), start: f.start, end: f.end, repeat: f.repeat === 'weekly',
      date: f.repeat === 'weekly' ? null : f.date, weekday: f.repeat === 'weekly' ? Number(f.weekday) : null,
      from: f.repeat === 'weekly' ? todayISO() : null, commute: f.commute === 'on',
    };
    commit(() => { state.events = id ? state.events.map((x) => (x.id === id ? { ...x, ...ev } : x)) : [...state.events, ev]; });
  } else if (kind === 'exam') {
    const ex = { id: id || uid('x'), subject: f.subject.trim(), date: f.date, importance: Number(f.importance), kind: f.kind };
    commit(() => { state.exams = id ? state.exams.map((x) => (x.id === id ? ex : x)) : [...state.exams, ex]; });
    toast('Pense à régénérer la semaine pour alléger la charge');
  } else if (kind === 'tpl') {
    const months = [...form.querySelectorAll('input[name="months"]:checked')].map((i) => Number(i.value));
    const t = {
      name: f.name.trim(), duration: Number(f.duration), freq: f.freq, category: f.category,
      difficulty: Number(f.difficulty), fixedDay: f.fixedDay === '' ? null : Number(f.fixedDay),
      pref: f.pref, months, every: f.every, active: f.active === 'on',
    };
    commit(() => {
      if (id) state.templates = state.templates.map((x) => (x.id === id ? { ...x, ...t } : x));
      else state.templates.push({ id: uid('t'), ...t });
    });
  } else if (kind === 'settings') {
    const s = state.settings;
    commit(() => {
      Object.assign(s, {
        name: f.name.trim(), wake: f.wake, sleep: f.sleep, reminderTime: f.reminderTime,
        commuteMin: Number(f.commuteMin), commuteMax: Math.max(Number(f.commuteMax), Number(f.commuteMin)),
        commuteMorning: f.commuteMorning === 'on',
        gym: {
          ...s.gym, enabled: f.gymOn === 'on', duration: Number(f.gymDuration), travel: Number(f.gymTravel),
          weekend: f.gymWeekend === 'on', weekendStart: f.gymWeekendStart, weekday: f.gymWeekday === 'on', freeDayFrom: f.gymFreeFrom,
        },
        arabic: {
          ...s.arabic, enabled: f.arabicOn === 'on', start: f.arabicStart, end: f.arabicEnd,
          days: [Number(f.arabicDay1), Number(f.arabicDay2)], tieDay: Number(f.arabicTie),
          lateFrom: f.arabicLate, commute: f.arabicCommute === 'on', cap: Number(f.arabicCap),
        },
        maxLoad: Number(f.maxLoad), weekendLoad: Number(f.weekendLoad), examCap: Number(f.examCap), hardDayCap: Number(f.hardDayCap),
        dailyRevision: Number(f.dailyRevision), useEdt: f.useEdt === 'on', edtUrl: f.edtUrl.trim(),
        bonusEnabled: f.bonusEnabled === 'on',
      });
      state.bonusIdeas = f.bonusIdeas.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, d] = l.split('|').map((x) => x.trim());
        return { name, duration: Number(d) || 10 };
      });
    });
    keepUnderCap();
    toast('Réglages enregistrés');
    refreshEdt();
    return;
  }
  closeSheet();
});

/* ---------- Rendu ---------- */

const ci = (k, size = 16) => icon(cat(k).icon, size);
const chip = (ic, text, cls = '') => `<span class="chip ${cls}">${ic ? icon(ic, 13) : ''}${text}</span>`;
const sectionHead = (title, action = '') => `<div class="sec-head"><h2>${title}</h2>${action}</div>`;

function taskRow(p, { showDate = false } = {}) {
  const tags = [];
  if (p.status === 'other') tags.push(chip('users', 'faite par quelqu’un d’autre', 'ok'));
  if (p.locked) tags.push(chip('lock', 'fixe'));
  if (p.carried || p.from) tags.push(chip('undo', 'rattrapage', 'warn'));
  if (p.bonus) tags.push(chip('star', 'bonus'));
  if (p.pinned && !p.locked) tags.push(chip('move', 'déplacée'));
  if (state.templates.find((t) => t.id === p.templateId)?.pref === 'hate') tags.push(chip('frown', 'pénible'));
  return `<li class="task ${p.status !== 'todo' ? 'done' : ''}">
    <label class="check"><input type="checkbox" data-act="toggle" data-id="${p.id}" ${p.status !== 'todo' ? 'checked' : ''} aria-label="Fait"><span>${icon('check', 14)}</span></label>
    <div class="t-main">
      <div class="t-name">${esc(p.name)}</div>
      <div class="t-meta"><span class="t-cat">${ci(p.category, 13)}${fmtDuration(p.duration)}</span>${showDate && p.date ? `<span>${fmtDate(p.date)}</span>` : ''}${tags.join('')}</div>
    </div>
    <button class="icon-btn" data-act="task-menu" data-id="${p.id}" aria-label="Options">${icon('more', 20)}</button>
  </li>`;
}

function loadBar(load, cap) {
  const pct = cap ? Math.min(100, Math.round((load / cap) * 100)) : load ? 100 : 0;
  const cls = load > cap ? 'over' : pct > 85 ? 'high' : '';
  return `<div class="bar ${cls}"><span style="width:${pct}%"></span></div>`;
}

function edtBanner(today) {
  const fresh = unseenChanges(state.edt, state.edtSeen, today);
  if (!fresh.length) return '';
  return `<section class="card notice">
    <div class="notice-head">${icon('info', 18)}<strong>Ton emploi du temps a changé</strong></div>
    <ul class="changes">${fresh.slice(0, 6).map((c) => `<li>${esc(describeChange(c))}</li>`).join('')}</ul>
    <div class="row">
      <button class="btn primary small" data-act="edt-regen">${icon('refresh', 15)}Replanifier</button>
      <button class="btn ghost small" data-act="edt-seen">OK, vu</button>
    </div>
  </section>`;
}

function journeyHtml(b) {
  const j = b.journey;
  const legs = j.legs.map((l) => {
    const style = l.color ? `style="--lc:${l.color};--lc-ink:${l.textColor || '#fff'}"` : '';
    return `<li class="leg">
      <span class="line-badge" ${style}>${icon(modeIcon(l.mode), 13)}${esc(l.line || l.mode)}</span>
      <div class="leg-body"><div><b>${l.dep}</b> ${esc(l.from)}</div><div class="muted">${l.arr} ${esc(l.to)}${l.direction ? ` · dir. ${esc(l.direction)}` : ''}</div></div>
      ${l.realtime ? '<span class="live" title="temps réel"></span>' : ''}
    </li>`;
  }).join('');
  const ti = state.edt?.tripsInfo || {};
  const [o, d] = b.dir === 'aller' ? [ti.home, ti.iut] : [ti.iut, ti.home];
  const maps = o && d ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&travelmode=transit` : null;
  return `<div class="journey">
    <div class="j-summary">${icon('walk', 14)}${b.dir === 'aller' ? `Départ de chez toi <b>${j.leave}</b>` : `Départ <b>${j.leave}</b>`}<span class="dot-sep"></span>arrivée <b>${j.arrive}</b><span class="dot-sep"></span>${fmtDuration(j.duration)}${j.walk ? `, dont ${j.walk} min à pied` : ''}</div>
    <ul class="legs">${legs}</ul>
    <div class="row">${maps ? `<a class="btn ghost small" href="${maps}" target="_blank" rel="noopener">${icon('map', 15)}Itinéraire</a>` : ''}<a class="btn ghost small" href="https://www.iledefrance-mobilites.fr/itineraires" target="_blank" rel="noopener">${icon('external', 15)}IDF Mobilités</a></div>
  </div>`;
}

const tlItem = (kind, start, end, body) => `<li class="tl tl-${kind}">
  <div class="tl-time"><span>${start || ''}</span>${end ? `<span>${end}</span>` : ''}</div>
  <div class="tl-card">${body}</div>
</li>`;

function blockRow(b) {
  if (b.kind === 'trajet') {
    const ic = b.mom ? 'car' : b.journey ? modeIcon(b.journey.legs[0]?.mode) : 'route';
    const sub = b.dir === 'aller' && b.journey
      ? `Pars à <b>${b.journey.leave}</b><span class="dot-sep"></span>arrivée ${b.journey.arrive}`
      : b.homeAt ? `${fmtDuration(b.duration)} · à la maison vers <b>${b.homeAt}</b>` : fmtDuration(b.duration);
    const body = `<div class="tl-row">
        <div class="tl-title">${icon(ic, 16)}${esc(b.title)}</div>
        <button class="toggle ${b.mom ? 'on' : ''}" data-act="ride" data-key="${b.date}|${b.dir}" aria-pressed="${b.mom}">${icon('car', 14)}Avec maman</button>
      </div>
      <div class="tl-sub">${sub}</div>
      ${b.journey ? `<details class="jdetails"${b.dir === 'aller' && b.date === todayISO() ? ' open' : ''}><summary>${icon('down', 14)}Détail du trajet</summary>${journeyHtml(b)}</details>` : ''}`;
    return tlItem(`trajet${b.mom ? ' mom' : ''}`, b.start, b.end, body);
  }
  if (b.kind === 'cours') {
    const type = b.type || 'Cours';
    return tlItem('cours', b.start, b.end, `<div class="tl-title"><span class="ctype ctype-${esc(type.replace(/[^A-Za-zÉé]/g, ''))}">${esc(type)}</span>${esc(b.title)}</div>
      <div class="tl-sub">${icon('pin', 13)}${b.room ? `<b>${esc(b.room)}</b>` : '<i>salle non indiquée</i>'}${b.teachers?.length ? `<span class="dot-sep"></span>${esc(b.teachers.join(', '))}` : ''}</div>`);
  }
  if (b.kind === 'sport') {
    const sub = b.extra
      ? `Séance en plus · ${esc(b.plan.manual ? 'jour choisi par toi' : b.plan.chosen.why.join(', '))}`
      : 'Séance du week-end';
    return tlItem('sport', b.start, b.end, `<div class="tl-row"><div class="tl-title">${icon('dumbbell', 16)}Salle de sport</div>
      ${b.extra ? `<button class="toggle" data-act="gym-menu" data-date="${b.plan.ws}">${icon('calendar', 14)}Changer</button>` : ''}</div>
      <div class="tl-sub">${sub}${b.travel ? `<span class="dot-sep"></span>trajet ${b.travel} min compris` : ''}</div>`);
  }
  const ic = b.arabic ? 'book' : 'event';
  return tlItem(b.arabic ? 'arabe' : 'event', b.start, b.end, `<div class="tl-title">${icon(ic, 16)}${esc(b.title)}</div>${b.room ? `<div class="tl-sub">${esc(b.room)}</div>` : ''}`);
}

function blocksList(info, extra = null) {
  const visible = info.blocks.filter((b) => !b.hidden);
  const rows = visible.map(blockRow);
  if (extra) {
    // Les tâches se placent dans la journée à partir du retour à la maison.
    let i = extra.at ? visible.findIndex((b) => toMin(b.start) >= toMin(extra.at) && b.kind !== 'trajet') : 0;
    if (i < 0) i = rows.length;
    rows.splice(i, 0, extra.html);
  }
  const items = [
    ...rows,
    ...info.revisions.map((r) => tlItem('rev', fmtDuration(r.minutes), '', `<div class="tl-title">${icon('book', 16)}Réviser ${esc(r.subject)}</div>`)),
    ...info.exams.map((x) => tlItem('exam', '', '', `<div class="tl-title">${icon(x.kind === 'devoir' ? 'file' : 'pen', 16)}${x.kind === 'devoir' ? 'Devoir à rendre' : 'Contrôle'} · ${esc(x.subject)}</div>`)),
  ];
  return items.length ? `<ul class="timeline">${items.join('')}</ul>` : '<p class="empty">Rien de prévu.</p>';
}

function shiftProg(n) {
  const cur = ui.progDate || todayISO();
  ui.progDate = addDays(cur, n);
  if (ui.progDate === todayISO()) ui.progDate = null;
  ui.slide = n > 0 ? 'from-right' : 'from-left';
  render();
}

function tasksBlock(date, info) {
  const today = todayISO();
  const tasks = state.planned.filter((p) => p.date === date && ['todo', 'done', 'other'].includes(p.status));
  const left = tasks.filter((p) => p.status === 'todo').reduce((a, p) => a + Number(p.duration), 0);
  const done = tasks.filter((p) => p.status !== 'todo').length;
  const home = info.blocks.find((b) => b.dir === 'retour');
  const at = home?.homeAt || null;
  const tomorrowFixed = state.planned.filter((p) => p.date === addDays(date, 1) && p.locked && p.status === 'todo');
  const isHard = state.hardDays.includes(date);
  const body = `<div class="tl-row">
      <div class="tl-title">${icon('list', 16)}Tâches</div>
      <span class="tl-count">${tasks.length ? `${done}/${tasks.length}${left ? ` · ${fmtDuration(left)}` : ''}` : ''}</span>
    </div>
    ${tasks.length ? `<ul class="tasks">${tasks.map((p) => taskRow(p)).join('')}</ul>` : `<p class="empty">Aucune tâche ${date === today ? 'aujourd’hui' : 'ce jour-là'}.</p>`}
    ${tomorrowFixed.length ? `<p class="hint">${icon('bell', 14)}Le lendemain : ${tomorrowFixed.map((p) => esc(p.name)).join(', ')}</p>` : ''}
    ${date >= today ? `<div class="row">${isHard
    ? `<button class="btn ghost small" data-act="undo-hard-day" data-date="${date}">${icon('undo', 15)}Annuler « journée difficile »</button>`
    : `<button class="btn ghost small" data-act="hard-day" data-date="${date}">${icon('battery', 15)}Journée difficile</button>`}</div>` : ''}`;
  return { html: tlItem('tasks', at ? `${at}` : '', '', body), at };
}

function programCard() {
  const today = todayISO();
  const date = ui.progDate || today;
  const info = dayInfo(state, date);
  const label = `${DAY_NAMES[weekday(date)]} ${Number(date.slice(8, 10))}`;
  const slide = ui.slide || '';
  ui.slide = null;
  return `<section class="card prog" data-swipe="prog">
    <div class="prog-head">
      <button class="icon-btn" data-act="prog-prev" aria-label="Jour précédent">${icon('left', 20)}</button>
      <div class="prog-title"><span class="eyebrow">Mon programme</span><h2>${label}</h2>
        ${date !== today ? `<button class="link" data-act="prog-today">Revenir à aujourd’hui</button>` : '<span class="today-dot">aujourd’hui</span>'}</div>
      <button class="icon-btn" data-act="prog-next" aria-label="Jour suivant">${icon('right', 20)}</button>
    </div>
    <div class="prog-body ${slide}">${blocksList(info, tasksBlock(date, info))}</div>
  </section>`;
}

function viewToday() {
  const today = todayISO();
  // Le bilan suit le jour affiché dans « Mon programme ».
  const day = ui.progDate || today;
  const info = dayInfo(state, day);
  const tasks = state.planned.filter((p) => p.date === day && ['todo', 'done', 'other'].includes(p.status));
  const load = loadOn(state.planned, day);
  const remaining = tasks.filter((p) => p.status === 'todo').reduce((a, p) => a + Number(p.duration), 0);
  const unplaced = state.planned.filter((p) => p.status === 'todo' && !p.date);
  const homeBack = info.blocks.find((b) => b.title === 'Trajet retour');
  const now = new Date();
  const free = day === today ? freeAfter(state, info, now.getHours() * 60 + now.getMinutes()) : day > today ? info.free : 0;
  const freeLeft = Math.max(0, free - remaining);
  const dayLabel = day === today ? '' : ` · ${DAY_NAMES[weekday(day)].toLowerCase()} ${Number(day.slice(8, 10))}`;
  const ws = weekStart(today);
  const weekEmpty = !state.planned.some((p) => p.date >= ws && p.date <= addDays(ws, 6));

  return `
  <header class="top"><h1>Tâches</h1></header>
  ${edtBanner(today)}
  ${weekEmpty ? `<section class="card notice"><div class="notice-head">${icon('calendar', 18)}<strong>Ta semaine n’est pas encore planifiée</strong></div><button class="btn primary" data-act="generate" data-ws="${ws}">${icon('sparkles', 16)}Générer ma semaine</button></section>` : ''}
  ${programCard()}
  <section class="card">
    <div class="kpis">
      <div class="kpi"><span class="kpi-v">${fmtDuration(freeLeft)}</span><span class="kpi-l">temps libre ${day === today ? 'restant' : 'après tâches'}${dayLabel}</span></div>
      <div class="kpi"><span class="kpi-v">${fmtDuration(remaining)}</span><span class="kpi-l">de tâches à faire</span></div>
      <div class="kpi"><span class="kpi-v">${load}<small>/${info.cap}</small></span><span class="kpi-l">min · plafond</span></div>
    </div>
    ${loadBar(load, info.cap)}
    ${info.capReason ? `<p class="hint">${icon('scale', 14)}${esc(info.capReason)}</p>` : ''}
    ${homeBack ? `<p class="hint">${icon('home', 14)}Retour à la maison vers ${homeBack.homeAt}${homeBack.mom ? ' (avec maman)' : ''}${dayLabel}</p>` : ''}
  </section>
  ${unplaced.length ? `<section class="card">${sectionHead(`À placer · ${unplaced.length}`)}<p class="hint">${icon('alert', 14)}Ces tâches ne rentrent pas sous ton plafond. Déplace-les ou supprime-les.</p><ul class="tasks">${unplaced.map((p) => taskRow(p)).join('')}</ul></section>` : ''}`;
}

function viewWeek() {
  const today = todayISO();
  const dates = weekDates(ui.ws);
  const isCurrent = ui.ws === weekStart(today);
  const validated = state.meta.validated?.[ui.ws];
  const any = state.planned.some((p) => p.date >= dates[0] && p.date <= dates[6]);
  const canGenerate = dates[6] >= today;
  const days = dates.map((d) => {
    const info = dayInfo(state, d);
    const tasks = state.planned.filter((p) => p.date === d && ['todo', 'done', 'other'].includes(p.status));
    const load = loadOn(state.planned, d);
    const cours = info.blocks.filter((b) => b.kind === 'cours' || b.kind === 'event').length;
    const home = info.blocks.find((b) => b.title === 'Trajet retour');
    return `<section class="card day ${d === today ? 'is-today' : ''} ${d < today ? 'past' : ''}">
      <div class="day-head">
        <div class="day-name"><strong>${DAY_NAMES[weekday(d)]}</strong><span>${fmtDate(d, false)}</span></div>
        <span class="day-load">${load}<small>/${info.cap} min</small></span>
      </div>
      ${loadBar(load, info.cap)}
      <div class="chips">
        ${info.exams.map((x) => chip('pen', esc(x.subject), 'exam')).join('')}
        ${cours ? chip('school', `${cours} cours`) : ''}
        ${info.revisionMin ? chip('book', `${fmtDuration(info.revisionMin)} révision`) : ''}
        ${home ? chip('home', home.homeAt) : ''}
        ${chip('clock', `${fmtDuration(info.free)} libres`)}
        ${info.capReason ? chip('scale', esc(info.capReason)) : ''}
      </div>
      ${tasks.length ? `<ul class="tasks">${tasks.map((p) => taskRow(p)).join('')}</ul>` : '<p class="empty">Pas de tâche</p>'}
    </section>`;
  });
  return `
  <header class="top week-top">
    <button class="icon-btn" data-act="week-prev" aria-label="Semaine précédente">${icon('left', 22)}</button>
    <div class="center"><span class="eyebrow">${isCurrent ? 'Cette semaine' : 'Semaine'}</span><h1>${fmtDate(ui.ws, false)} – ${fmtDate(dates[6], false)}</h1>${isCurrent ? '' : '<button class="link" data-act="week-today">Revenir à cette semaine</button>'}</div>
    <button class="icon-btn" data-act="week-next" aria-label="Semaine suivante">${icon('right', 22)}</button>
  </header>
  ${canGenerate ? `<div class="actions">
    <button class="btn primary" data-act="generate" data-ws="${ui.ws}">${icon('sparkles', 16)}${any ? 'Régénérer' : 'Générer'} ma semaine</button>
    ${any && !validated ? `<button class="btn" data-act="validate" data-ws="${ui.ws}">${icon('check', 16)}Valider</button>` : ''}
    ${validated ? chip('done', 'Validée', 'ok') : ''}
  </div>` : ''}
  ${any && !validated && canGenerate ? `<p class="hint pad">${icon('info', 14)}Touche ${icon('more', 14)} sur une tâche pour la déplacer, l’échanger ou la supprimer, puis valide.</p>` : ''}
  ${days.join('')}`;
}

function arabicCard(today) {
  const a = state.settings.arabic;
  if (!a?.enabled) return '';
  const row = (label, ws) => {
    const p = arabicPlan(state, ws);
    const what = p.date ? `${fmtDate(p.date)} · ${a.start}–${a.end}` : 'Pas de cours cette semaine';
    return `<li class="row-item static"><div class="grow"><span class="eyebrow">${label}</span><div class="ri-title">${what}</div>
      <div class="ri-sub">${esc(p.why)} — ${esc(p.reason)}${p.known ? '' : ' · EDT pas encore publié'}</div></div></li>`;
  };
  const ws = weekStart(today);
  return `<section class="card">
    ${sectionHead(`${icon('book', 18)}${esc(a.title)}`)}
    <ul class="list">${row('Cette semaine', ws)}${row('Semaine prochaine', addDays(ws, 7))}</ul>
    <p class="hint">Recalculé à chaque mise à jour de l’emploi du temps.</p>
  </section>`;
}

function gymCard(today) {
  const g = state.settings.gym;
  if (!g?.enabled) return '';
  const ws = weekStart(today);
  const row = (label, w) => {
    const p = gymPlan(state, w);
    const c = p?.chosen;
    const what = c ? `${fmtDate(c.date)} · ${c.slot.start}–${c.slot.end}` : 'Pas de créneau cette semaine';
    return `<li class="row-item" data-act="gym-menu" data-date="${w}"><div class="grow"><span class="eyebrow">${label}</span><div class="ri-title">${what}</div>
      <div class="ri-sub">${c ? esc(p.manual ? 'choisi par toi' : c.why.join(', ')) : 'aucun jour n’a 1 h 30 de libre'}</div></div>${icon('right', 18, 'muted')}</li>`;
  };
  const we = g.weekend !== false ? `Samedi et dimanche · ${g.weekendStart}, ${fmtDuration(g.duration)}` : 'Pas de séance le week-end';
  return `<section class="card">
    ${sectionHead(`${icon('dumbbell', 18)}Salle de sport`)}
    <ul class="list">
      <li class="row-item static"><div class="grow"><span class="eyebrow">Week-end</span><div class="ri-title">${we}</div></div></li>
      ${g.weekday !== false ? `${row('Séance en plus cette semaine', ws)}${row('Semaine prochaine', addDays(ws, 7))}` : ''}
    </ul>
    <p class="hint">Le meilleur jour est recalculé chaque semaine selon tes cours, ton retour à la maison, le cours d’arabe et tes contrôles.</p>
  </section>`;
}

function viewAgenda() {
  const today = todayISO();
  const edt = state.edt;
  const exams = [...state.exams].sort((a, b) => (a.date < b.date ? -1 : 1));
  const upcoming = exams.filter((x) => x.date >= today);
  const past = exams.filter((x) => x.date < today);
  const events = [...state.events].sort((a, b) => (a.repeat === b.repeat ? (a.weekday ?? 0) - (b.weekday ?? 0) || (a.date || '').localeCompare(b.date || '') : a.repeat ? -1 : 1));
  const evRow = (e) => `<li class="row-item" data-act="edit-event" data-id="${e.id}">
    <span class="ri-icon">${icon('event', 18)}</span>
    <div class="grow"><div class="ri-title">${esc(e.title)}</div><div class="ri-sub">${e.repeat ? `Chaque ${DAY_NAMES[e.weekday].toLowerCase()}` : fmtDate(e.date)} · ${e.start}–${e.end}</div></div>${icon('right', 18, 'muted')}</li>`;
  const exRow = (x) => `<li class="row-item" data-act="edit-exam" data-id="${x.id}">
    <span class="ri-icon">${icon(x.kind === 'devoir' ? 'file' : 'pen', 18)}</span>
    <div class="grow"><div class="ri-title">${esc(x.subject)}</div><div class="ri-sub">${fmtDate(x.date)} · ${IMPORTANCE[x.importance]}</div></div><span class="imp imp${x.importance}">${'<i></i>'.repeat(x.importance)}</span></li>`;
  const changes = (edt?.changes || []).slice(-10).reverse();
  const tripsN = Object.keys(edt?.trips || {}).length;
  return `
  <header class="top"><h1>Planning</h1></header>
  ${edtBanner(today)}
  <section class="card">
    ${sectionHead(`${icon('school', 18)}Emploi du temps IUT`, `<button class="icon-btn" data-act="edt-refresh" aria-label="Actualiser">${icon('refresh', 18)}</button>`)}
    ${!state.settings.useEdt ? '<p class="empty">Synchronisation désactivée (Réglages).</p>'
    : edt ? `<dl class="facts">
        <div><dt>Groupe</dt><dd>${esc(edt.group)}</dd></div>
        <div><dt>Cours</dt><dd>${edt.events.length}${edt.range ? ` · du ${fmtDate(edt.range.from, false)} au ${fmtDate(edt.range.to, false)}` : ''}</dd></div>
        <div><dt>Vérifié</dt><dd>${edt.checkedAt ? new Date(edt.checkedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—'}${edt.ok === false ? ` · échec : ${esc(edt.error)}` : ''}</dd></div>
        <div><dt>Trajets</dt><dd>${tripsN ? `${tripsN} jour(s) calculé(s)${edt.tripsInfo?.home ? ` · depuis ${esc(edt.tripsInfo.home)}` : ''}` : esc(edt.tripsInfo?.error || 'non configurés')}</dd></div>
      </dl>
      ${changes.length ? `<details class="more"><summary>${icon('down', 14)}Derniers changements</summary><ul class="changes">${changes.map((c) => `<li><span class="muted">${new Date(c.at).toLocaleDateString('fr-FR')}</span> ${esc(describeChange(c))}</li>`).join('')}</ul></details>` : ''}`
      : `<p class="empty">${ui.edtError ? esc(ui.edtError) : 'Chargement…'}</p>`}
  </section>
  <section class="card">
    ${sectionHead(`${icon('pen', 18)}Contrôles et devoirs`, `<button class="btn small" data-act="add-exam">${icon('plus', 15)}Ajouter</button>`)}
    ${upcoming.length ? `<ul class="list">${upcoming.map(exRow).join('')}</ul>` : '<p class="empty">Aucun contrôle à venir.</p>'}
    ${past.length ? `<details class="more"><summary>${icon('down', 14)}Passés (${past.length})</summary><ul class="list">${past.reverse().map(exRow).join('')}</ul></details>` : ''}
  </section>
  ${gymCard(today)}
  ${arabicCard(today)}
  <section class="card">
    ${sectionHead(`${icon('calendar', 18)}Mes activités`, `<button class="btn small" data-act="add-event">${icon('plus', 15)}Ajouter</button>`)}
    ${events.length ? `<ul class="list">${events.map(evRow).join('')}</ul>` : '<p class="empty">Aucune activité. Les cours viennent de l’EDT automatiquement.</p>'}
  </section>`;
}

const dayOptions = (sel) => DAY_NAMES.map((n, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${n}</option>`).join('');

/** Minutes de tâches par semaine en moyenne pour ce mois-ci, à comparer au plafond. */
function weeklyDemand(date) {
  const per = { daily: 7, weekly: 1, biweekly: 0.5, monthly: 0.23 };
  let total = 0;
  for (const t of state.templates) {
    if (t.active === false) continue;
    let f = t.freq;
    if (f === 'seasonal') f = (t.months || []).includes(Number(date.slice(5, 7))) ? t.every || 'monthly' : null;
    if (f) total += Number(t.duration) * (t.fixedDay != null && f === 'daily' ? 1 : per[f]);
  }
  return Math.round(total);
}

function viewTasks() {
  const groups = {};
  const demand = weeklyDemand(todayISO());
  const s = state.settings;
  const capacity = s.maxLoad * 5 + (s.weekendLoad ?? 90) * 2;
  for (const t of state.templates) (groups[t.category] ||= []).push(t);
  const prefBtn = (t, p, ic, label) => `<button class="pref ${t.pref === p ? 'on' : ''}" data-act="set-pref" data-id="${t.id}" data-pref="${p}" aria-label="${label}" title="${label}">${icon(ic, 17)}</button>`;
  return `
  <header class="top"><h1>Tâches</h1><button class="btn small" data-act="add-tpl">${icon('plus', 15)}Ajouter</button></header>
  <section class="card">
    <div class="sec-head"><h2>Charge du mois</h2><span class="muted small">${fmtDuration(demand / 7)} / jour en moyenne</span></div>
    ${loadBar(demand, capacity)}
    <p class="hint">${demand > capacity
    ? `${icon('alert', 14)}Plus que tes plafonds : certaines tâches attendront ou iront dans « À placer ». Mets-en en pause ou augmente le plafond.`
    : `${icon('done', 14)}Ça rentre dans tes plafonds de la semaine.`}</p>
  </section>
  <p class="hint pad">${icon('frown', 14)}pénible : placée les jours où tu as de l’énergie · ${icon('smile', 14)}facile : placée les jours chargés</p>
  ${Object.entries(groups).map(([k, list]) => `<section class="card">
    ${sectionHead(`${ci(k, 18)}${cat(k).label}`, `<span class="muted small">${list.length}</span>`)}
    <ul class="list">${list.map((t) => `<li class="row-item tpl ${t.active === false ? 'off' : ''}">
      <div data-act="edit-tpl" data-id="${t.id}" class="grow"><div class="ri-title">${esc(t.name)}</div>
        <div class="ri-sub">${fmtDuration(t.duration)} · ${FREQS[t.freq]}${t.freq === 'seasonal' ? ` (${FREQS[t.every || 'monthly'].toLowerCase()})` : ''}${t.fixedDay != null ? ` · ${icon('lock', 12)} ${DAY_NAMES[t.fixedDay]}` : ''}${t.active === false ? ' · en pause' : ''}</div></div>
      <div class="prefs">${prefBtn(t, 'hate', 'frown', 'Je déteste')}${prefBtn(t, 'neutral', 'meh', 'Neutre')}${prefBtn(t, 'easy', 'smile', 'Ça me gêne peu')}</div>
    </li>`).join('')}</ul></section>`).join('')}`;
}

function viewStats() {
  const s = computeStats(state.planned, todayISO());
  const max = Math.max(1, ...s.weeks.map((w) => w.total));
  return `
  <header class="top"><h1>Suivi</h1></header>
  <section class="card">
    <div class="kpis">
      <div class="kpi"><span class="kpi-ic">${icon('flame', 18)}</span><span class="kpi-v">${s.streak}</span><span class="kpi-l">jour(s) réussi(s) d’affilée</span></div>
      <div class="kpi"><span class="kpi-ic">${icon('done', 18)}</span><span class="kpi-v">${s.percent == null ? '—' : `${s.percent}<small>%</small>`}</span><span class="kpi-l">tâches faites · 4 sem.</span></div>
      <div class="kpi"><span class="kpi-ic">${icon('star', 18)}</span><span class="kpi-v">${s.bonusTotal}</span><span class="kpi-l">bonus réalisés</span></div>
    </div>
  </section>
  <section class="card">
    ${sectionHead('Historique par semaine')}
    <ul class="history">${s.weeks.map((w) => `<li>
      <span class="small muted">${fmtDate(w.ws, false)}</span>
      <div class="hbar"><span style="width:${(w.total / max) * 100}%"><i style="width:${w.total ? (w.done / w.total) * 100 : 0}%"></i></span></div>
      <span class="small">${w.percent == null ? '—' : `${w.percent} %`}${w.bonus ? icon('star', 12) : ''}</span>
    </li>`).join('')}</ul>
    <p class="hint">${fmtDuration(s.weeks[0].minutes)} de tâches faites cette semaine.</p>
  </section>`;
}

function viewSettings() {
  const s = state.settings;
  const notifSupported = 'Notification' in window;
  return `
  <header class="top"><h1>Réglages</h1></header>
  <form data-form="settings" class="form">
    <section class="card">
      ${sectionHead(`${icon('user', 18)}Ma journée`)}
      <label>Prénom <input name="name" value="${esc(s.name)}" placeholder="Ton prénom"></label>
      <div class="grid2">
        <label>Réveil <input type="time" name="wake" value="${s.wake}" required></label>
        <label>Coucher <input type="time" name="sleep" value="${s.sleep}" required></label>
      </div>
      <label>Heure du rappel <input type="time" name="reminderTime" value="${s.reminderTime}"></label>
    </section>
    <section class="card">
      ${sectionHead(`${icon('scale', 18)}Plafonds de tâches (min)`)}
      <div class="grid2">
        <label>En semaine <input type="number" name="maxLoad" min="0" max="300" value="${s.maxLoad}"></label>
        <label>Le week-end <input type="number" name="weekendLoad" min="0" max="300" value="${s.weekendLoad ?? 90}"></label>
        <label>Jour et veille de contrôle <input type="number" name="examCap" min="0" max="300" value="${s.examCap}"></label>
        <label>Journée difficile <input type="number" name="hardDayCap" min="0" max="120" value="${s.hardDayCap}"></label>
      </div>
      <label>Révision quotidienne <input type="number" name="dailyRevision" min="0" max="240" value="${s.dailyRevision}"></label>
    </section>
    <section class="card">
      ${sectionHead(`${icon('route', 18)}Trajet maison – IUT`)}
      <div class="grid2">
        <label>Avec maman (min) <input type="number" name="commuteMin" min="0" max="300" value="${s.commuteMin}"></label>
        <label>Sans maman (min) <input type="number" name="commuteMax" min="0" max="300" value="${s.commuteMax}"></label>
      </div>
      <label class="switch"><input type="checkbox" name="commuteMorning" ${s.commuteMorning !== false ? 'checked' : ''}><span></span>Compter le trajet aller le matin</label>
      <p class="hint">Quand IDF Mobilités a calculé le trajet, c’est lui qui compte. « Avec maman » le remplace par la durée courte.</p>
    </section>
    <section class="card">
      ${sectionHead(`${icon('dumbbell', 18)}Salle de sport`)}
      <label class="switch"><input type="checkbox" name="gymOn" ${s.gym?.enabled !== false ? 'checked' : ''}><span></span>Je vais à la salle</label>
      <div class="grid2">
        <label>Durée d’une séance (min) <input type="number" name="gymDuration" min="15" max="240" value="${s.gym?.duration ?? 90}"></label>
        <label>Trajet aller (min) <input type="number" name="gymTravel" min="0" max="120" value="${s.gym?.travel ?? 0}"></label>
      </div>
      <label class="switch"><input type="checkbox" name="gymWeekend" ${s.gym?.weekend !== false ? 'checked' : ''}><span></span>Samedi et dimanche</label>
      <label>Heure le week-end <input type="time" name="gymWeekendStart" value="${s.gym?.weekendStart || '10:00'}"></label>
      <label class="switch"><input type="checkbox" name="gymWeekday" ${s.gym?.weekday !== false ? 'checked' : ''}><span></span>Une séance en plus en semaine (meilleur jour calculé)</label>
      <label>Les jours sans cours, pas avant <input type="time" name="gymFreeFrom" value="${s.gym?.freeDayFrom || '10:00'}"></label>
    </section>
    <section class="card">
      ${sectionHead(`${icon('book', 18)}Cours d’arabe`)}
      <label class="switch"><input type="checkbox" name="arabicOn" ${s.arabic?.enabled ? 'checked' : ''}><span></span>Cours d’arabe chaque semaine</label>
      <div class="grid2">
        <label>Début <input type="time" name="arabicStart" value="${s.arabic?.start || '20:00'}"></label>
        <label>Fin <input type="time" name="arabicEnd" value="${s.arabic?.end || '23:00'}"></label>
        <label>Jour possible <select name="arabicDay1">${dayOptions(s.arabic?.days?.[0] ?? 1)}</select></label>
        <label>ou <select name="arabicDay2">${dayOptions(s.arabic?.days?.[1] ?? 2)}</select></label>
        <label>Jour préféré <select name="arabicTie">${dayOptions(s.arabic?.tieDay ?? 2)}</select></label>
        <label>Trop tard dès <input type="time" name="arabicLate" value="${s.arabic?.lateFrom || '18:00'}"></label>
        <label>Tâches ce soir-là (min) <input type="number" name="arabicCap" min="0" max="120" value="${s.arabic?.cap ?? 20}"></label>
      </div>
      <label class="switch"><input type="checkbox" name="arabicCommute" ${s.arabic?.commute ? 'checked' : ''}><span></span>Compter un trajet pour y aller</label>
      <p class="hint">Le cours a lieu le jour préféré si tes cours y finissent avant l’heure limite, sinon l’autre jour s’ils y finissent avant, sinon pas de cours cette semaine.</p>
    </section>
    <section class="card">
      ${sectionHead(`${icon('school', 18)}Emploi du temps et bonus`)}
      <label class="switch"><input type="checkbox" name="useEdt" ${s.useEdt ? 'checked' : ''}><span></span>Synchroniser l’emploi du temps de l’IUT</label>
      <label>Adresse des données EDT <input name="edtUrl" value="${esc(s.edtUrl)}"></label>
      <label class="switch"><input type="checkbox" name="bonusEnabled" ${s.bonusEnabled !== false ? 'checked' : ''}><span></span>Proposer une tâche bonus chaque semaine</label>
      <label>Idées de bonus <small class="muted">une par ligne : nom | minutes</small>
        <textarea name="bonusIdeas" rows="5">${esc(state.bonusIdeas.map((b) => `${b.name} | ${b.duration}`).join('\n'))}</textarea></label>
    </section>
    <button class="btn primary block">Enregistrer</button>
  </form>
  <section class="card">
    ${sectionHead(`${icon('bell', 18)}Rappels`)}
    ${!notifSupported ? '<p class="empty">Ce navigateur ne gère pas les notifications. Utilise l’export agenda.</p>'
    : s.notifications ? `<p class="small">Activés à ${s.reminderTime}. <button class="link" data-act="notif-off">Désactiver</button></p>`
      : `<button class="btn" data-act="notif-on">${icon('bell', 16)}Activer les notifications</button>`}
    <p class="hint">Les notifications marchent quand l’app a été ouverte récemment. Pour des rappels fiables, ajoute tes tâches et tes départs à l’agenda du téléphone.</p>
    <button class="btn" data-act="export-ics">${icon('calendar', 16)}Exporter 2 semaines (.ics)</button>
  </section>
  <section class="card">
    ${sectionHead(`${icon('download', 18)}Mes données`)}
    <p class="hint">Tout est stocké sur cet appareil.</p>
    <div class="row">
      <button class="btn" data-act="export-json">${icon('download', 16)}Sauvegarder</button>
      <button class="btn" data-act="import-json">${icon('upload', 16)}Restaurer</button>
      <button class="btn ghost danger" data-act="reset">${icon('trash', 16)}Tout effacer</button>
    </div>
    <input type="file" id="import-file" accept="application/json" hidden>
  </section>`;
}

/* ---------- Feuilles (modales) ---------- */

function openSheet(sheet) {
  ui.sheet = sheet;
  renderSheet();
}

function closeSheet() {
  ui.sheet = null;
  renderSheet();
}

const action = (act, ic, label, attrs = '', cls = '') => `<button class="action ${cls}" data-act="${act}" ${attrs}>${icon(ic, 18)}<span>${label}</span></button>`;

function sheetTask(p) {
  const tpl = state.templates.find((t) => t.id === p.templateId);
  const id = `data-id="${p.id}"`;
  return `<div class="sheet-head"><span class="sheet-ic">${ci(p.category, 20)}</span><div><h2>${esc(p.name)}</h2>
    <p class="muted small">${fmtDuration(p.duration)}${p.date ? ` · ${fmtDate(p.date)}` : ' · à placer'}${tpl ? ` · ${FREQS[tpl.freq]}` : ''}${p.locked ? ' · jour fixe' : ''}</p></div></div>
    <div class="actions-list">
      ${p.status === 'todo' ? action('done-by-other', 'users', 'Déjà faite par quelqu’un d’autre', id) : ''}
      ${action('postpone', 'skip', 'Reporter au prochain jour libre', id)}
      ${action('move-menu', 'calendar', 'Déplacer à un autre jour', id)}
      ${action('swap-menu', 'swap', 'Échanger avec une autre tâche', id)}
      ${action('delete-task', 'trash', 'Supprimer', id, 'danger')}
    </div>`;
}

function sheetReplace(s) {
  const { room, items } = suggestReplacements(state, s.date);
  const when = s.date === todayISO() ? 'aujourd’hui' : fmtDate(s.date).toLowerCase();
  const btn = (it) => {
    const label = `${esc(it.name)}<small>${fmtDuration(it.duration)}${it.kind === 'advance' ? ` · prévue ${fmtDate(it.from).toLowerCase()}` : it.kind === 'bonus' ? ' · bonus' : ''}</small>`;
    if (it.kind === 'advance') return action('replace-advance', 'arrow', label, `data-id="${it.id}" data-date="${s.date}"`);
    if (it.kind === 'template') return action('replace-tpl', 'plus', label, `data-tpl="${it.tplId}" data-date="${s.date}"`);
    return action('replace-bonus', 'star', label, `data-name="${esc(it.name)}" data-duration="${it.duration}" data-date="${s.date}"`);
  };
  return `<div class="sheet-head"><span class="sheet-ic">${icon('users', 20)}</span><div><h2>« ${esc(s.name)} » est déjà faite</h2>
    <p class="muted small">${items.length ? `Il te reste ${fmtDuration(room)} sous ton plafond ${when}. Faire autre chose à la place ?` : `Rien d’autre ne rentre ${when} sous ton plafond.`}</p></div></div>
    <div class="actions-list">${items.map(btn).join('')}${action('replace-none', 'close', 'Non merci, je garde ce temps libre')}</div>`;
}

function sheetGym(s) {
  const plan = gymPlan(state, s.date);
  if (!plan) return '<p class="empty">Séance en semaine désactivée.</p>';
  const items = plan.ranked.map((o, i) => {
    const label = `${DAY_NAMES[o.day]} ${Number(o.date.slice(8, 10))}${o.slot ? ` · ${o.slot.start}–${o.slot.end}` : ''}<small>${i === 0 && o.slot ? 'conseillé · ' : ''}${esc(o.why.join(', '))}</small>`;
    const on = plan.chosen?.date === o.date;
    return o.slot
      ? action('gym-pick', on ? 'done' : 'dumbbell', label, `data-ws="${plan.ws}" data-day="${o.day}"`, on ? 'current' : '')
      : `<div class="action disabled">${icon('close', 18)}<span>${label}</span></div>`;
  }).join('');
  return `<div class="sheet-head"><span class="sheet-ic">${icon('dumbbell', 20)}</span><div><h2>Séance de sport en plus</h2>
    <p class="muted small">Semaine du ${fmtDate(plan.ws, false)} · classement du meilleur au moins bon jour.</p></div></div>
    <div class="actions-list">${items}${plan.manual ? action('gym-auto', 'sparkles', 'Revenir au choix automatique', `data-ws="${plan.ws}"`) : ''}</div>`;
}

function sheetMove(p) {
  const today = todayISO();
  const others = state.planned.filter((x) => x.id !== p.id);
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i)).map((d) => {
    const info = dayInfo(state, d);
    const load = loadOn(others, d);
    const fits = load + Number(p.duration) <= info.cap;
    return `<button class="day-pick ${fits ? '' : 'full'} ${d === p.date ? 'current' : ''}" data-act="move-to" data-id="${p.id}" data-date="${d}">
      <span>${DAY_SHORT[weekday(d)]} ${fmtDate(d, false)}</span><small>${load}/${info.cap} min${fits ? '' : ' · dépasse'}</small></button>`;
  });
  return `<div class="sheet-head"><span class="sheet-ic">${icon('calendar', 20)}</span><div><h2>Déplacer « ${esc(p.name)} »</h2></div></div><div class="day-grid">${days.join('')}</div>`;
}

function sheetSwap(p) {
  const ws = weekStart(p.date || todayISO());
  const from = todayISO() > ws ? todayISO() : ws;
  const list = state.planned.filter((x) => x.id !== p.id && x.status === 'todo' && x.date && x.date !== p.date && x.date >= from && x.date <= addDays(ws, 13));
  return `<div class="sheet-head"><span class="sheet-ic">${icon('swap', 20)}</span><div><h2>Échanger « ${esc(p.name)} » avec…</h2></div></div>
    ${list.length ? `<div class="actions-list">${list.map((x) => action('swap-with', cat(x.category).icon, `${esc(x.name)}<small>${fmtDate(x.date)} · ${x.duration} min</small>`, `data-id="${p.id}" data-other="${x.id}"`)).join('')}</div>` : '<p class="empty">Aucune autre tâche à échanger.</p>'}`;
}

function sheetEvent(e) {
  const today = todayISO();
  const v = e || { title: '', repeat: true, weekday: weekday(today), date: today, start: '18:00', end: '19:00' };
  return `<h2>${e ? 'Modifier l’activité' : 'Nouvelle activité'}</h2>
  <form data-form="event" ${e ? `data-id="${e.id}"` : ''} class="form">
    <label>Titre <input name="title" value="${esc(v.title)}" required placeholder="Foot, travail, sortie…"></label>
    <label>Répétition
      <select name="repeat" data-toggle-show="ev-date" data-show-when="once">
        <option value="weekly" ${v.repeat ? 'selected' : ''}>Chaque semaine</option>
        <option value="once" ${!v.repeat ? 'selected' : ''}>Une seule fois</option>
      </select></label>
    <label>Jour de la semaine <select name="weekday">${dayOptions(v.weekday)}</select></label>
    <label id="ev-date" ${v.repeat ? 'hidden' : ''}>Date <input type="date" name="date" value="${v.date || today}"></label>
    <div class="grid2">
      <label>Début <input type="time" name="start" value="${v.start}" required></label>
      <label>Fin <input type="time" name="end" value="${v.end}" required></label>
    </div>
    <label class="switch"><input type="checkbox" name="commute" ${v.commute ? 'checked' : ''}><span></span>Loin de chez moi : compter le trajet</label>
    <button class="btn primary block">Enregistrer</button>
    ${e ? `<button type="button" class="btn ghost danger block" data-act="del-event" data-id="${e.id}">${icon('trash', 16)}Supprimer</button>` : ''}
  </form>`;
}

function sheetExam(x) {
  const v = x || { subject: '', date: addDays(todayISO(), 7), importance: 2, kind: 'controle' };
  return `<h2>${x ? 'Modifier' : 'Nouveau'} contrôle ou devoir</h2>
  <form data-form="exam" ${x ? `data-id="${x.id}"` : ''} class="form">
    <label>Matière <input name="subject" value="${esc(v.subject)}" required placeholder="Réseaux, maths…"></label>
    <div class="grid2">
      <label>Type <select name="kind"><option value="controle" ${v.kind !== 'devoir' ? 'selected' : ''}>Contrôle</option><option value="devoir" ${v.kind === 'devoir' ? 'selected' : ''}>Devoir à rendre</option></select></label>
      <label>Date <input type="date" name="date" value="${v.date}" required></label>
    </div>
    <label>Importance <select name="importance">${Object.entries(IMPORTANCE).map(([k, l]) => `<option value="${k}" ${Number(k) === v.importance ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="hint">Normale : 30 min de révision la veille. Importante : 45 min sur 3 jours. Très importante : 60 min sur 5 jours. La charge de tâches baisse automatiquement.</p>
    <button class="btn primary block">Enregistrer</button>
    ${x ? `<button type="button" class="btn ghost danger block" data-act="del-exam" data-id="${x.id}">${icon('trash', 16)}Supprimer</button>` : ''}
  </form>`;
}

function sheetTpl(t) {
  const v = t || { name: '', duration: 15, freq: 'weekly', category: 'menage', difficulty: 2, fixedDay: null, pref: 'neutral', months: [], every: 'monthly', active: true };
  const months = ['Janv', 'Févr', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'];
  return `<h2>${t ? 'Modifier la tâche' : 'Nouvelle tâche'}</h2>
  <form data-form="tpl" ${t ? `data-id="${t.id}"` : ''} class="form">
    <label>Nom <input name="name" value="${esc(v.name)}" required></label>
    <div class="grid2">
      <label>Durée (min) <input type="number" name="duration" min="1" max="240" value="${v.duration}" required></label>
      <label>Catégorie <select name="category">${Object.entries(CATEGORIES).filter(([k]) => k !== 'bonus').map(([k, c]) => `<option value="${k}" ${v.category === k ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
    </div>
    <label>Fréquence <select name="freq" data-toggle-show="season" data-show-when="seasonal">${Object.entries(FREQS).map(([k, l]) => `<option value="${k}" ${v.freq === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <fieldset id="season" ${v.freq === 'seasonal' ? '' : 'hidden'}>
      <legend>Mois de la saison</legend>
      <div class="months">${months.map((m, i) => `<label><input type="checkbox" name="months" value="${i + 1}" ${(v.months || []).includes(i + 1) ? 'checked' : ''}><span>${m}</span></label>`).join('')}</div>
      <label>Pendant la saison <select name="every">${['weekly', 'biweekly', 'monthly'].map((k) => `<option value="${k}" ${v.every === k ? 'selected' : ''}>${FREQS[k]}</option>`).join('')}</select></label>
    </fieldset>
    <label>Jour fixe <select name="fixedDay"><option value="">Aucun (l’app choisit)</option>${DAY_NAMES.map((n, i) => `<option value="${i}" ${v.fixedDay === i ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <div class="grid2">
      <label>Difficulté <select name="difficulty">${[[1, 'Facile'], [2, 'Moyenne'], [3, 'Pénible']].map(([k, l]) => `<option value="${k}" ${v.difficulty === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Ressenti <select name="pref">${[['hate', 'Je déteste'], ['neutral', 'Neutre'], ['easy', 'Ça me gêne peu']].map(([k, l]) => `<option value="${k}" ${v.pref === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label class="switch"><input type="checkbox" name="active" ${v.active !== false ? 'checked' : ''}><span></span>Active</label>
    <button class="btn primary block">Enregistrer</button>
    ${t ? `<button type="button" class="btn ghost danger block" data-act="del-tpl" data-id="${t.id}">${icon('trash', 16)}Supprimer</button>` : ''}
  </form>`;
}

function renderSheet() {
  const s = ui.sheet;
  if (!s) {
    $sheet.hidden = true;
    $sheet.innerHTML = '';
    document.body.classList.remove('locked');
    return;
  }
  let html = '';
  if (s.type === 'task') html = sheetTask(byId(s.id));
  else if (s.type === 'move') html = sheetMove(byId(s.id));
  else if (s.type === 'swap') html = sheetSwap(byId(s.id));
  else if (s.type === 'replace') html = sheetReplace(s);
  else if (s.type === 'gym') html = sheetGym(s);
  else if (s.type === 'event') html = sheetEvent(state.events.find((e) => e.id === s.id));
  else if (s.type === 'exam') html = sheetExam(state.exams.find((e) => e.id === s.id));
  else if (s.type === 'tpl') html = sheetTpl(state.templates.find((t) => t.id === s.id));
  $sheet.innerHTML = `<div class="backdrop" data-act="close-sheet"></div><div class="panel" role="dialog" aria-modal="true"><div class="grabber"></div><button class="icon-btn close" data-act="close-sheet" aria-label="Fermer">${icon('close', 20)}</button>${html}</div>`;
  $sheet.hidden = false;
  document.body.classList.add('locked');
}

const TABS = [
  ['today', 'today', 'Aujourd’hui', viewToday],
  ['week', 'calendar', 'Semaine', viewWeek],
  ['agenda', 'school', 'Planning', viewAgenda],
  ['tasks', 'list', 'Tâches', viewTasks],
  ['stats', 'chart', 'Suivi', viewStats],
  ['settings', 'sliders', 'Réglages', viewSettings],
];

function render() {
  const tab = TABS.find((t) => t[0] === ui.tab) || TABS[0];
  $app.innerHTML = `<main>${tab[3]()}</main>
  <nav class="tabs">${TABS.map(([k, ic, label]) => `<button data-act="tab" data-tab="${k}" class="${k === ui.tab ? 'on' : ''}" aria-label="${label}">${icon(ic, 22)}<small>${label}</small></button>`).join('')}</nav>`;
  if (ui.sheet) renderSheet();
}

/* ---------- Démarrage ---------- */

dailyMaintenance();
keepUnderCap();
render();
refreshEdt();
setInterval(tick, 60 * 1000);
setInterval(() => refreshEdt(), 5 * 60 * 1000);
setTimeout(tick, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    dailyMaintenance();
    render();
    refreshEdt();
  }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
