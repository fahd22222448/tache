// État de l'app, sauvegardé dans le navigateur (localStorage).
import { uid } from './scheduler.js';

const KEY = 'tache:v1';

export const CATEGORIES = {
  cuisine: { label: 'Cuisine', icon: '🍳' },
  menage: { label: 'Ménage', icon: '🧹' },
  linge: { label: 'Linge', icon: '👕' },
  poubelles: { label: 'Poubelles', icon: '🗑️' },
  jardin: { label: 'Jardin', icon: '🌿' },
  courses: { label: 'Courses', icon: '🛒' },
  bonus: { label: 'Bonus', icon: '⭐' },
};

export const FREQS = {
  daily: 'Tous les jours',
  weekly: 'Chaque semaine',
  biweekly: 'Tous les 15 jours',
  monthly: 'Chaque mois',
  seasonal: 'Saisonnière',
};

export const IMPORTANCE = { 1: 'Normale', 2: 'Importante', 3: 'Très importante' };

const tpl = (name, duration, freq, category, extra = {}) => ({
  id: uid('t'), name, duration, freq, category, difficulty: 2, fixedDay: null, pref: 'neutral', active: true, ...extra,
});

export function defaultState() {
  return {
    version: 1,
    settings: {
      name: '',
      wake: '07:00',
      sleep: '23:00',
      maxLoad: 45,
      examCap: 20,
      hardDayCap: 10,
      dailyRevision: 0,
      reminderTime: '19:30',
      // Trajet maison ↔ IUT : entre 45 min et 1 h 40. On planifie avec le pire cas (max).
      commuteMin: 45,
      commuteMax: 100,
      commuteMorning: true,
      notifications: false,
      useEdt: true,
      edtUrl: 'edt.json',
      hiddenEdt: [],
      bonusEnabled: true,
      playBlocks: [
        { day: -1, start: '21:00', end: '22:30' },
        { day: 5, start: '14:00', end: '18:00' },
      ],
    },
    events: [],
    exams: [],
    templates: [
      tpl('Vaisselle / lave-vaisselle', 15, 'daily', 'cuisine', { difficulty: 1 }),
      tpl('Sortir la poubelle grise', 5, 'weekly', 'poubelles', { fixedDay: 0, difficulty: 1 }),
      tpl('Sortir la poubelle jaune', 5, 'weekly', 'poubelles', { fixedDay: 2, difficulty: 1 }),
      tpl('Passer l’aspirateur', 30, 'weekly', 'menage'),
      tpl('Nettoyer la salle de bain', 25, 'weekly', 'menage', { difficulty: 3 }),
      tpl('Lancer et étendre une machine', 20, 'weekly', 'linge', { difficulty: 1 }),
      tpl('Plier et ranger le linge', 15, 'weekly', 'linge'),
      tpl('Changer les draps', 15, 'biweekly', 'linge'),
      tpl('Serpillière', 20, 'biweekly', 'menage'),
      tpl('Courses avec la liste', 30, 'weekly', 'courses'),
      tpl('Nettoyer le frigo', 20, 'monthly', 'cuisine', { difficulty: 3 }),
      tpl('Arroser le jardin et les plantes', 10, 'seasonal', 'jardin', { months: [5, 6, 7, 8, 9], every: 'weekly', difficulty: 1 }),
      tpl('Tondre la pelouse', 30, 'seasonal', 'jardin', { months: [4, 5, 6, 7, 8, 9, 10], every: 'biweekly', difficulty: 3 }),
      tpl('Ramasser les feuilles', 30, 'seasonal', 'jardin', { months: [10, 11], every: 'biweekly' }),
    ],
    bonusIdeas: [
      { name: 'Préparer le petit-déj pour tout le monde', duration: 15 },
      { name: 'Vider le lave-vaisselle sans qu’on le demande', duration: 10 },
      { name: 'Ranger l’entrée et les chaussures', duration: 10 },
      { name: 'Nettoyer les vitres d’une pièce', duration: 15 },
      { name: 'Désherber un coin du jardin', duration: 20 },
      { name: 'Faire un dessert pour le repas', duration: 30 },
      { name: 'Nettoyer le micro-ondes', duration: 10 },
    ],
    planned: [],
    hardDays: [],
    edt: null,
    edtSeen: null,
    meta: { lastRollover: null, lastNotified: {} },
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    const def = defaultState();
    return { ...def, ...data, settings: { ...def.settings, ...data.settings }, meta: { ...def.meta, ...data.meta } };
  } catch {
    return defaultState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Sauvegarde impossible', e);
  }
}

export function exportJSON(state) {
  return JSON.stringify(state, null, 2);
}

export function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.templates) || !data.settings) throw new Error('Fichier non reconnu');
  const def = defaultState();
  return { ...def, ...data, settings: { ...def.settings, ...data.settings } };
}
