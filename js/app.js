import {
  DAY_NAMES, DAY_SHORT, addDays, fmtDate, fmtDuration, iso, toMin, todayISO, weekDates, weekStart, weekday,
} from './dates.js';
import { dayInfo, generateWeek, hardDay, loadOn, nextFreeDay, rollover, uid } from './scheduler.js';
import { CATEGORIES, FREQS, IMPORTANCE, defaultState, exportJSON, importJSON, load, save } from './store.js';
import { computeStats } from './stats.js';
import { buildICS } from './ics.js';
import { fetchEdt, unseenChanges } from './edt.js';

let state = load();
const ui = { tab: 'today', ws: weekStart(todayISO()), sheet: null, toast: null, edtError: null };
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cat = (k) => CATEGORIES[k] || { label: k || '—', icon: '•' };
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

function dailyMaintenance() {
  const today = todayISO();
  if (state.meta.lastRollover === today) return;
  const { planned, moved } = rollover(state, today);
  state.planned = planned;
  const old = addDays(today, -60);
  state.hardDays = (state.hardDays || []).filter((d) => d >= old);
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

function tick() {
  dailyMaintenance();
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
    if (all.length) notify('🗑️ Rappel', all.join('\n'), 'fixed');
    sent.fixed = today;
  }
  save(state);
}

/* ---------- Actions ---------- */

function generate(ws) {
  const { planned, unplaced } = generateWeek(state, ws, todayISO());
  state.planned = planned;
  state.meta.validated = { ...(state.meta.validated || {}), [ws]: false };
  save(state);
  render();
  toast(unplaced.length
    ? `Semaine générée — ${unplaced.length} tâche(s) ne rentrent pas sous le plafond`
    : 'Semaine générée ✔ Vérifie puis valide');
}

function describeChange(c) {
  const when = `${fmtDate(c.date)} ${c.start}–${c.end}`;
  if (c.kind === 'added') return `➕ ${c.title} (${when})`;
  if (c.kind === 'removed') return `➖ ${c.title} annulé (${when})`;
  const before = c.before?.replace(/^(\d{4}-\d{2}-\d{2})/, (d) => fmtDate(d));
  return `✏️ ${c.title} modifié → ${when}${before ? ` (avant : ${before})` : ''}`;
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
  validate: (el) => commit(() => { state.meta.validated = { ...(state.meta.validated || {}), [el.dataset.ws]: true }; toast('Semaine validée 👍'); }),
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
  'add-play': () => commit(() => { state.settings.playBlocks.push({ day: -1, start: '20:00', end: '21:00' }); }),
  'del-play': (el) => commit(() => { state.settings.playBlocks.splice(Number(el.dataset.i), 1); }),
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
      toast(left.length ? `Bien joué ! Encore ${left.length}` : 'Tout est fait pour aujourd’hui 🎉');
    }
  } else if (el.dataset.play != null) {
    const b = state.settings.playBlocks[Number(el.dataset.play)];
    b[el.name] = el.name === 'day' ? Number(el.value) : el.value;
    commit();
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
      from: f.repeat === 'weekly' ? todayISO() : null,
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
        maxLoad: Number(f.maxLoad), examCap: Number(f.examCap), hardDayCap: Number(f.hardDayCap),
        dailyRevision: Number(f.dailyRevision), useEdt: f.useEdt === 'on', edtUrl: f.edtUrl.trim(),
        bonusEnabled: f.bonusEnabled === 'on',
      });
      state.bonusIdeas = f.bonusIdeas.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, d] = l.split('|').map((x) => x.trim());
        return { name, duration: Number(d) || 10 };
      });
    });
    toast('Réglages enregistrés');
    refreshEdt();
    return;
  }
  closeSheet();
});

/* ---------- Rendu ---------- */

function taskRow(p, { showDate = false } = {}) {
  const c = cat(p.category);
  const tags = [];
  if (p.locked) tags.push('<span class="tag lock">🔒 fixe</span>');
  if (p.carried || p.from) tags.push('<span class="tag late">↻ rattrapage</span>');
  if (p.bonus) tags.push('<span class="tag bonus">⭐ bonus</span>');
  if (p.pinned && !p.locked) tags.push('<span class="tag">✋ déplacée</span>');
  const tplPref = state.templates.find((t) => t.id === p.templateId)?.pref;
  if (tplPref === 'hate') tags.push('<span class="tag">😖</span>');
  return `<li class="task ${p.status === 'done' ? 'done' : ''}">
    <label class="check"><input type="checkbox" data-act="toggle" data-id="${p.id}" ${p.status === 'done' ? 'checked' : ''} aria-label="Fait"><span></span></label>
    <div class="t-main">
      <div class="t-name">${c.icon} ${esc(p.name)}</div>
      <div class="t-meta">${fmtDuration(p.duration)}${showDate && p.date ? ` · ${fmtDate(p.date)}` : ''} ${tags.join(' ')}</div>
    </div>
    <button class="icon-btn" data-act="task-menu" data-id="${p.id}" aria-label="Options">⋯</button>
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
  return `<section class="card banner">
    <strong>📢 Ton emploi du temps a changé</strong>
    <ul class="changes">${fresh.slice(0, 6).map((c) => `<li>${esc(describeChange(c))}</li>`).join('')}</ul>
    <div class="row">
      <button class="btn primary small" data-act="edt-regen">Replanifier ma semaine</button>
      <button class="btn small" data-act="edt-seen">OK, vu</button>
    </div>
  </section>`;
}

function blocksList(info) {
  const items = [
    ...info.blocks.map((b) => `<li class="blk ${b.kind}"><span class="time">${b.start}–${b.end}</span> ${b.kind === 'cours' ? '🎓' : b.kind === 'jeu' ? '🎮' : '📌'} ${esc(b.title)}${b.room ? ` <small>${esc(b.room)}</small>` : ''}</li>`),
    ...info.revisions.map((r) => `<li class="blk rev"><span class="time">${fmtDuration(r.minutes)}</span> 📚 Réviser ${esc(r.subject)}</li>`),
    ...info.exams.map((x) => `<li class="blk exam"><span class="time">!</span> 📝 ${x.kind === 'devoir' ? 'Devoir à rendre' : 'Contrôle'} : ${esc(x.subject)}</li>`),
  ];
  return items.length ? `<ul class="blocks">${items.join('')}</ul>` : '<p class="muted">Rien de prévu.</p>';
}

function viewToday() {
  const today = todayISO();
  const info = dayInfo(state, today);
  const tasks = state.planned.filter((p) => p.date === today && ['todo', 'done'].includes(p.status));
  const load = loadOn(state.planned, today);
  const remaining = tasks.filter((p) => p.status === 'todo').reduce((a, p) => a + Number(p.duration), 0);
  const unplaced = state.planned.filter((p) => p.status === 'todo' && !p.date);
  const tomorrowFixed = state.planned.filter((p) => p.date === addDays(today, 1) && p.locked && p.status === 'todo');
  const isHard = state.hardDays.includes(today);
  const ws = weekStart(today);
  const weekEmpty = !state.planned.some((p) => p.date >= ws && p.date <= addDays(ws, 6));
  const hello = state.settings.name ? `Salut ${esc(state.settings.name)} 👋` : 'Salut 👋';

  return `
  <header class="top"><div><h1>${hello}</h1><p class="muted">${fmtDate(today)}</p></div></header>
  ${edtBanner(today)}
  ${weekEmpty ? `<section class="card banner"><strong>Ta semaine n'est pas encore planifiée.</strong><button class="btn primary" data-act="generate" data-ws="${ws}">✨ Générer ma semaine</button></section>` : ''}
  <section class="card">
    <div class="stats3">
      <div><b>${fmtDuration(Math.max(0, info.free - remaining))}</b><small>temps libre restant</small></div>
      <div><b>${fmtDuration(remaining)}</b><small>de tâches à faire</small></div>
      <div><b>${load}/${info.cap}</b><small>min (plafond)</small></div>
    </div>
    ${loadBar(load, info.cap)}
    ${info.capReason ? `<p class="hint">⚖️ Charge réduite : ${esc(info.capReason)}</p>` : ''}
  </section>
  <section class="card">
    <h2>Mes tâches du jour</h2>
    ${tasks.length ? `<ul class="tasks">${tasks.map((p) => taskRow(p)).join('')}</ul>` : '<p class="muted">Aucune tâche aujourd’hui. Profite ! 🎮</p>'}
    ${tomorrowFixed.length ? `<p class="hint">🔔 Demain : ${tomorrowFixed.map((p) => esc(p.name)).join(', ')} — pense à préparer ce soir.</p>` : ''}
    <div class="row">
      ${isHard
    ? `<button class="btn small" data-act="undo-hard-day" data-date="${today}">Annuler « journée difficile »</button>`
    : `<button class="btn soft" data-act="hard-day" data-date="${today}">😮‍💨 Journée difficile</button>`}
    </div>
  </section>
  ${unplaced.length ? `<section class="card warn"><h2>À placer (${unplaced.length})</h2><p class="hint">Ces tâches ne rentrent pas sous ton plafond. Déplace-les à la main ou supprime-les.</p><ul class="tasks">${unplaced.map((p) => taskRow(p)).join('')}</ul></section>` : ''}
  <section class="card">
    <h2>Mon programme</h2>
    ${blocksList(info)}
  </section>`;
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
    const tasks = state.planned.filter((p) => p.date === d && ['todo', 'done'].includes(p.status));
    const load = loadOn(state.planned, d);
    const cours = info.blocks.filter((b) => b.kind !== 'jeu').length;
    return `<section class="card day ${d === today ? 'is-today' : ''} ${d < today ? 'past' : ''}">
      <div class="day-head">
        <div><strong>${DAY_NAMES[weekday(d)]}</strong> <span class="muted">${fmtDate(d, false)}</span></div>
        <div class="muted small">${load}/${info.cap} min</div>
      </div>
      ${loadBar(load, info.cap)}
      <div class="day-tags">
        ${info.exams.map((x) => `<span class="tag exam">📝 ${esc(x.subject)}</span>`).join('')}
        ${info.capReason ? `<span class="tag">⚖️ ${esc(info.capReason)}</span>` : ''}
        ${cours ? `<span class="tag">📅 ${cours} créneau(x)</span>` : ''}
        ${info.revisionMin ? `<span class="tag">📚 ${fmtDuration(info.revisionMin)} révision</span>` : ''}
        <span class="tag">🕒 ${fmtDuration(info.free)} libres</span>
      </div>
      ${tasks.length ? `<ul class="tasks">${tasks.map((p) => taskRow(p)).join('')}</ul>` : '<p class="muted small">Pas de tâche</p>'}
    </section>`;
  });
  return `
  <header class="top">
    <button class="icon-btn" data-act="week-prev" aria-label="Semaine précédente">‹</button>
    <div class="center"><h1>Semaine du ${fmtDate(ui.ws, false)}</h1>${isCurrent ? '<p class="muted">Cette semaine</p>' : '<button class="link" data-act="week-today">Revenir à cette semaine</button>'}</div>
    <button class="icon-btn" data-act="week-next" aria-label="Semaine suivante">›</button>
  </header>
  ${canGenerate ? `<section class="card row">
    <button class="btn primary" data-act="generate" data-ws="${ui.ws}">✨ ${any ? 'Régénérer' : 'Générer'} ma semaine</button>
    ${any && !validated ? `<button class="btn" data-act="validate" data-ws="${ui.ws}">✔ Valider</button>` : ''}
    ${validated ? '<span class="tag ok">✔ Validée</span>' : ''}
  </section>` : ''}
  ${any && !validated && canGenerate ? '<p class="hint pad">Proposition : touche ⋯ sur une tâche pour la déplacer, l’échanger ou la supprimer, puis valide.</p>' : ''}
  ${days.join('')}`;
}

function viewAgenda() {
  const today = todayISO();
  const edt = state.edt;
  const exams = [...state.exams].sort((a, b) => (a.date < b.date ? -1 : 1));
  const upcoming = exams.filter((x) => x.date >= today);
  const past = exams.filter((x) => x.date < today);
  const events = [...state.events].sort((a, b) => (a.repeat === b.repeat ? (a.weekday ?? 0) - (b.weekday ?? 0) || (a.date || '').localeCompare(b.date || '') : a.repeat ? -1 : 1));
  const evRow = (e) => `<li class="row-item" data-act="edit-event" data-id="${e.id}">
    <div><strong>${esc(e.title)}</strong><div class="muted small">${e.repeat ? `Chaque ${DAY_NAMES[e.weekday].toLowerCase()}` : fmtDate(e.date)} · ${e.start}–${e.end}</div></div><span>›</span></li>`;
  const exRow = (x) => `<li class="row-item" data-act="edit-exam" data-id="${x.id}">
    <div><strong>${x.kind === 'devoir' ? '📄' : '📝'} ${esc(x.subject)}</strong><div class="muted small">${fmtDate(x.date)} · ${IMPORTANCE[x.importance]}</div></div><span class="imp imp${x.importance}">${'!'.repeat(x.importance)}</span></li>`;
  const changes = (edt?.changes || []).slice(-10).reverse();
  return `
  <header class="top"><h1>Planning</h1></header>
  ${edtBanner(today)}
  <section class="card">
    <div class="day-head"><h2>🎓 Emploi du temps IUT</h2><button class="btn small" data-act="edt-refresh">↻</button></div>
    ${!state.settings.useEdt ? '<p class="muted">Synchronisation désactivée (Réglages).</p>'
    : edt ? `<p class="small">Groupe <b>${esc(edt.group)}</b> · ${edt.events.length} cours du ${edt.range ? `${fmtDate(edt.range.from, false)} au ${fmtDate(edt.range.to, false)}` : ''}</p>
      <p class="muted small">Dernière vérification : ${edt.checkedAt ? new Date(edt.checkedAt).toLocaleString('fr-FR') : '—'}${edt.ok === false ? ` · ⚠️ échec : ${esc(edt.error)}` : ''}</p>
      ${changes.length ? `<details><summary>Derniers changements détectés</summary><ul class="changes">${changes.map((c) => `<li><small>${new Date(c.at).toLocaleDateString('fr-FR')}</small> ${esc(describeChange(c))}</li>`).join('')}</ul></details>` : ''}`
      : `<p class="muted">${ui.edtError ? `⚠️ ${esc(ui.edtError)}` : 'Chargement…'}</p>`}
  </section>
  <section class="card">
    <div class="day-head"><h2>Contrôles et devoirs</h2><button class="btn small primary" data-act="add-exam">+ Ajouter</button></div>
    ${upcoming.length ? `<ul class="list">${upcoming.map(exRow).join('')}</ul>` : '<p class="muted">Aucun contrôle à venir.</p>'}
    ${past.length ? `<details><summary>Passés (${past.length})</summary><ul class="list">${past.reverse().map(exRow).join('')}</ul></details>` : ''}
  </section>
  <section class="card">
    <div class="day-head"><h2>Mes activités</h2><button class="btn small primary" data-act="add-event">+ Ajouter</button></div>
    <p class="hint">Sport, sorties, travail… (les cours viennent de l’EDT automatiquement)</p>
    ${events.length ? `<ul class="list">${events.map(evRow).join('')}</ul>` : '<p class="muted">Aucune activité.</p>'}
  </section>`;
}

function viewTasks() {
  const groups = {};
  for (const t of state.templates) (groups[t.category] ||= []).push(t);
  const prefBtn = (t, p, label) => `<button class="pref ${t.pref === p ? 'on' : ''}" data-act="set-pref" data-id="${t.id}" data-pref="${p}" title="${p}">${label}</button>`;
  return `
  <header class="top"><h1>Tâches</h1><button class="btn small primary" data-act="add-tpl">+ Ajouter</button></header>
  <p class="hint pad">Indique ce que tu détestes 😖 (placé les jours où tu as de l’énergie) et ce qui ne te gêne pas 🙂 (placé les jours chargés).</p>
  ${Object.entries(groups).map(([k, list]) => `<section class="card">
    <h2>${cat(k).icon} ${cat(k).label}</h2>
    <ul class="list">${list.map((t) => `<li class="row-item tpl ${t.active === false ? 'off' : ''}">
      <div data-act="edit-tpl" data-id="${t.id}" class="grow"><strong>${esc(t.name)}</strong>
        <div class="muted small">${fmtDuration(t.duration)} · ${FREQS[t.freq]}${t.freq === 'seasonal' ? ` (${FREQS[t.every || 'monthly'].toLowerCase()})` : ''}${t.fixedDay != null ? ` · 🔒 ${DAY_NAMES[t.fixedDay]}` : ''}${t.active === false ? ' · en pause' : ''}</div></div>
      <div class="prefs">${prefBtn(t, 'hate', '😖')}${prefBtn(t, 'neutral', '😐')}${prefBtn(t, 'easy', '🙂')}</div>
    </li>`).join('')}</ul></section>`).join('')}`;
}

function viewStats() {
  const s = computeStats(state.planned, todayISO());
  const max = Math.max(1, ...s.weeks.map((w) => w.total));
  return `
  <header class="top"><h1>Suivi</h1></header>
  <section class="card stats3">
    <div><b>🔥 ${s.streak}</b><small>jour(s) réussi(s) d’affilée</small></div>
    <div><b>${s.percent == null ? '—' : `${s.percent} %`}</b><small>tâches faites (4 sem.)</small></div>
    <div><b>⭐ ${s.bonusTotal}</b><small>bonus réalisés</small></div>
  </section>
  <section class="card">
    <h2>Historique par semaine</h2>
    <ul class="history">${s.weeks.map((w) => `<li>
      <span class="small">${fmtDate(w.ws, false)}</span>
      <div class="hbar"><span style="width:${(w.total / max) * 100}%"><i style="width:${w.total ? (w.done / w.total) * 100 : 0}%"></i></span></div>
      <span class="small">${w.percent == null ? '—' : `${w.percent} %`}${w.bonus ? ' ⭐' : ''}</span>
    </li>`).join('')}</ul>
    <p class="hint">Barre pleine = tâches faites · ${fmtDuration(s.weeks[0].minutes)} de tâches cette semaine.</p>
  </section>`;
}

function viewSettings() {
  const s = state.settings;
  const dayOpts = (sel) => [`<option value="-1" ${sel === -1 ? 'selected' : ''}>Tous les jours</option>`, ...DAY_NAMES.map((n, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${n}</option>`)].join('');
  const notifSupported = 'Notification' in window;
  return `
  <header class="top"><h1>Réglages</h1></header>
  <form data-form="settings" class="card form">
    <label>Prénom <input name="name" value="${esc(s.name)}" placeholder="Ton prénom"></label>
    <div class="grid2">
      <label>Réveil <input type="time" name="wake" value="${s.wake}" required></label>
      <label>Coucher <input type="time" name="sleep" value="${s.sleep}" required></label>
    </div>
    <div class="grid2">
      <label>Charge max / jour (min) <input type="number" name="maxLoad" min="0" max="300" value="${s.maxLoad}"></label>
      <label>Les jours de contrôle (min) <input type="number" name="examCap" min="0" max="300" value="${s.examCap}"></label>
    </div>
    <div class="grid2">
      <label>Journée difficile (min) <input type="number" name="hardDayCap" min="0" max="120" value="${s.hardDayCap}"></label>
      <label>Révision quotidienne (min) <input type="number" name="dailyRevision" min="0" max="240" value="${s.dailyRevision}"></label>
    </div>
    <label>Heure du rappel <input type="time" name="reminderTime" value="${s.reminderTime}"></label>
    <label class="inline"><input type="checkbox" name="useEdt" ${s.useEdt ? 'checked' : ''}> Synchroniser l’emploi du temps de l’IUT</label>
    <label>Adresse des données EDT <input name="edtUrl" value="${esc(s.edtUrl)}"></label>
    <label class="inline"><input type="checkbox" name="bonusEnabled" ${s.bonusEnabled !== false ? 'checked' : ''}> Proposer une tâche bonus chaque semaine</label>
    <label>Idées de bonus <small class="muted">(une par ligne : nom | minutes)</small>
      <textarea name="bonusIdeas" rows="5">${esc(state.bonusIdeas.map((b) => `${b.name} | ${b.duration}`).join('\n'))}</textarea></label>
    <button class="btn primary">Enregistrer</button>
  </form>
  <section class="card">
    <div class="day-head"><h2>🎮 Temps de jeu protégé</h2><button class="btn small" data-act="add-play">+ Ajouter</button></div>
    <p class="hint">Aucune tâche ne sera placée sur ce temps-là.</p>
    ${s.playBlocks.map((b, i) => `<div class="play-row">
      <select name="day" data-play="${i}">${dayOpts(b.day)}</select>
      <input type="time" name="start" value="${b.start}" data-play="${i}">
      <input type="time" name="end" value="${b.end}" data-play="${i}">
      <button class="icon-btn" data-act="del-play" data-i="${i}" aria-label="Supprimer">✕</button>
    </div>`).join('')}
  </section>
  <section class="card">
    <h2>🔔 Rappels</h2>
    ${!notifSupported ? '<p class="muted">Ce navigateur ne gère pas les notifications. Utilise l’export agenda.</p>'
    : s.notifications ? `<p>Activés à ${s.reminderTime}. <button class="link" data-act="notif-off">Désactiver</button></p>`
      : '<button class="btn" data-act="notif-on">Activer les notifications</button>'}
    <p class="hint">Les notifications web marchent quand l’app est ouverte ou en arrière-plan récent. Pour des rappels 100 % fiables (poubelles !), ajoute aussi tes tâches à l’agenda du téléphone :</p>
    <button class="btn" data-act="export-ics">📅 Exporter 2 semaines vers mon agenda (.ics)</button>
  </section>
  <section class="card">
    <h2>💾 Mes données</h2>
    <p class="hint">Tout est stocké sur cet appareil. Fais une sauvegarde de temps en temps.</p>
    <div class="row">
      <button class="btn" data-act="export-json">Sauvegarder</button>
      <button class="btn" data-act="import-json">Restaurer</button>
      <button class="btn danger" data-act="reset">Tout effacer</button>
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

function sheetTask(p) {
  const tpl = state.templates.find((t) => t.id === p.templateId);
  return `<h2>${cat(p.category).icon} ${esc(p.name)}</h2>
    <p class="muted">${fmtDuration(p.duration)}${p.date ? ` · ${fmtDate(p.date)}` : ' · à placer'}${tpl ? ` · ${FREQS[tpl.freq]}` : ''}</p>
    ${p.locked ? '<p class="hint">🔒 Tâche fixe : elle a un jour attitré.</p>' : ''}
    <div class="stack">
      <button class="btn primary" data-act="postpone" data-id="${p.id}">⏭ Reporter au prochain jour libre</button>
      <button class="btn" data-act="move-menu" data-id="${p.id}">📅 Déplacer à un autre jour…</button>
      <button class="btn" data-act="swap-menu" data-id="${p.id}">🔁 Échanger avec une autre tâche…</button>
      <button class="btn danger" data-act="delete-task" data-id="${p.id}">🗑 Supprimer</button>
    </div>`;
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
  return `<h2>Déplacer « ${esc(p.name)} »</h2><div class="day-grid">${days.join('')}</div>`;
}

function sheetSwap(p) {
  const ws = weekStart(p.date || todayISO());
  const from = todayISO() > ws ? todayISO() : ws;
  const list = state.planned.filter((x) => x.id !== p.id && x.status === 'todo' && x.date && x.date !== p.date && x.date >= from && x.date <= addDays(ws, 13));
  return `<h2>Échanger « ${esc(p.name)} » avec…</h2>
    ${list.length ? `<div class="stack">${list.map((x) => `<button class="btn left" data-act="swap-with" data-id="${p.id}" data-other="${x.id}">${cat(x.category).icon} ${esc(x.name)} <small class="muted">· ${fmtDate(x.date)} · ${x.duration} min</small></button>`).join('')}</div>` : '<p class="muted">Aucune autre tâche à échanger.</p>'}`;
}

function sheetEvent(e) {
  const today = todayISO();
  const v = e || { title: '', repeat: true, weekday: weekday(today), date: today, start: '18:00', end: '19:00' };
  return `<h2>${e ? 'Modifier' : 'Nouvelle'} activité</h2>
  <form data-form="event" ${e ? `data-id="${e.id}"` : ''} class="form">
    <label>Titre <input name="title" value="${esc(v.title)}" required placeholder="Foot, travail, sortie…"></label>
    <label>Répétition
      <select name="repeat" data-toggle-show="ev-date" data-show-when="once">
        <option value="weekly" ${v.repeat ? 'selected' : ''}>Se répète chaque semaine</option>
        <option value="once" ${!v.repeat ? 'selected' : ''}>Une seule fois</option>
      </select></label>
    <label>Jour de la semaine <select name="weekday">${DAY_NAMES.map((n, i) => `<option value="${i}" ${v.weekday === i ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label id="ev-date" ${v.repeat ? 'hidden' : ''}>Date <input type="date" name="date" value="${v.date || today}"></label>
    <div class="grid2">
      <label>Début <input type="time" name="start" value="${v.start}" required></label>
      <label>Fin <input type="time" name="end" value="${v.end}" required></label>
    </div>
    <button class="btn primary">Enregistrer</button>
    ${e ? `<button type="button" class="btn danger" data-act="del-event" data-id="${e.id}">Supprimer</button>` : ''}
  </form>`;
}

function sheetExam(x) {
  const v = x || { subject: '', date: addDays(todayISO(), 7), importance: 2, kind: 'controle' };
  return `<h2>${x ? 'Modifier' : 'Nouveau'} contrôle / devoir</h2>
  <form data-form="exam" ${x ? `data-id="${x.id}"` : ''} class="form">
    <label>Matière <input name="subject" value="${esc(v.subject)}" required placeholder="Réseaux, maths…"></label>
    <label>Type <select name="kind"><option value="controle" ${v.kind !== 'devoir' ? 'selected' : ''}>Contrôle</option><option value="devoir" ${v.kind === 'devoir' ? 'selected' : ''}>Devoir à rendre</option></select></label>
    <label>Date <input type="date" name="date" value="${v.date}" required></label>
    <label>Importance <select name="importance">${Object.entries(IMPORTANCE).map(([k, l]) => `<option value="${k}" ${Number(k) === v.importance ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="hint">Normale : 30 min de révision la veille. Importante : 45 min sur 3 jours. Très importante : 60 min sur 5 jours. La charge de tâches baisse automatiquement.</p>
    <button class="btn primary">Enregistrer</button>
    ${x ? `<button type="button" class="btn danger" data-act="del-exam" data-id="${x.id}">Supprimer</button>` : ''}
  </form>`;
}

function sheetTpl(t) {
  const v = t || { name: '', duration: 15, freq: 'weekly', category: 'menage', difficulty: 2, fixedDay: null, pref: 'neutral', months: [], every: 'monthly', active: true };
  const months = ['Janv', 'Févr', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'];
  return `<h2>${t ? 'Modifier' : 'Nouvelle'} tâche</h2>
  <form data-form="tpl" ${t ? `data-id="${t.id}"` : ''} class="form">
    <label>Nom <input name="name" value="${esc(v.name)}" required></label>
    <div class="grid2">
      <label>Durée (min) <input type="number" name="duration" min="1" max="240" value="${v.duration}" required></label>
      <label>Catégorie <select name="category">${Object.entries(CATEGORIES).filter(([k]) => k !== 'bonus').map(([k, c]) => `<option value="${k}" ${v.category === k ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('')}</select></label>
    </div>
    <label>Fréquence <select name="freq" data-toggle-show="season" data-show-when="seasonal">${Object.entries(FREQS).map(([k, l]) => `<option value="${k}" ${v.freq === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <fieldset id="season" ${v.freq === 'seasonal' ? '' : 'hidden'}>
      <legend>Mois de la saison</legend>
      <div class="months">${months.map((m, i) => `<label><input type="checkbox" name="months" value="${i + 1}" ${(v.months || []).includes(i + 1) ? 'checked' : ''}>${m}</label>`).join('')}</div>
      <label>Pendant la saison <select name="every">${['weekly', 'biweekly', 'monthly'].map((k) => `<option value="${k}" ${v.every === k ? 'selected' : ''}>${FREQS[k]}</option>`).join('')}</select></label>
    </fieldset>
    <label>Jour fixe <select name="fixedDay"><option value="">Aucun (l’app choisit)</option>${DAY_NAMES.map((n, i) => `<option value="${i}" ${v.fixedDay === i ? 'selected' : ''}>🔒 ${n}</option>`).join('')}</select></label>
    <div class="grid2">
      <label>Difficulté <select name="difficulty">${[[1, 'Facile'], [2, 'Moyenne'], [3, 'Pénible']].map(([k, l]) => `<option value="${k}" ${v.difficulty === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Ressenti <select name="pref">${[['hate', '😖 Je déteste'], ['neutral', '😐 Neutre'], ['easy', '🙂 Ça me gêne peu']].map(([k, l]) => `<option value="${k}" ${v.pref === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label class="inline"><input type="checkbox" name="active" ${v.active !== false ? 'checked' : ''}> Active</label>
    <button class="btn primary">Enregistrer</button>
    ${t ? `<button type="button" class="btn danger" data-act="del-tpl" data-id="${t.id}">Supprimer</button>` : ''}
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
  else if (s.type === 'event') html = sheetEvent(state.events.find((e) => e.id === s.id));
  else if (s.type === 'exam') html = sheetExam(state.exams.find((e) => e.id === s.id));
  else if (s.type === 'tpl') html = sheetTpl(state.templates.find((t) => t.id === s.id));
  $sheet.innerHTML = `<div class="backdrop" data-act="close-sheet"></div><div class="panel" role="dialog" aria-modal="true"><button class="icon-btn close" data-act="close-sheet" aria-label="Fermer">✕</button>${html}</div>`;
  $sheet.hidden = false;
  document.body.classList.add('locked');
}

const TABS = [
  ['today', '☀️', 'Aujourd’hui', viewToday],
  ['week', '🗓️', 'Semaine', viewWeek],
  ['agenda', '🎓', 'Planning', viewAgenda],
  ['tasks', '🧺', 'Tâches', viewTasks],
  ['stats', '🔥', 'Suivi', viewStats],
  ['settings', '⚙️', 'Réglages', viewSettings],
];

function render() {
  const tab = TABS.find((t) => t[0] === ui.tab) || TABS[0];
  $app.innerHTML = `<main>${tab[3]()}</main>
  <nav class="tabs">${TABS.map(([k, icon, label]) => `<button data-act="tab" data-tab="${k}" class="${k === ui.tab ? 'on' : ''}"><span>${icon}</span><small>${label}</small></button>`).join('')}</nav>`;
  if (ui.sheet) renderSheet();
}

/* ---------- Démarrage ---------- */

dailyMaintenance();
render();
refreshEdt();
setInterval(tick, 60 * 1000);
setInterval(() => refreshEdt(), 30 * 60 * 1000);
setTimeout(tick, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    dailyMaintenance();
    render();
    refreshEdt();
  }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
