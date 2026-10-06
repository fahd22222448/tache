// État de l'app, sauvegardé dans le navigateur (localStorage).
import { uid } from './scheduler.js';

const KEY = 'tache:v1';
const VERSION = 2;
// Tâches retirées du catalogue par défaut (supprimées aussi des données déjà enregistrées).
const REMOVED = ['Serpillière', 'Passer l’aspirateur'];

export const CATEGORIES = {
  cuisine: { label: 'Cuisine', icon: 'cuisine' },
  menage: { label: 'Ménage', icon: 'menage' },
  linge: { label: 'Linge', icon: 'linge' },
  poubelles: { label: 'Poubelles', icon: 'poubelles' },
  jardin: { label: 'Jardin', icon: 'jardin' },
  courses: { label: 'Courses', icon: 'courses' },
  bonus: { label: 'Bonus', icon: 'star' },
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

// « Saisonnière » + mois espacés de 3 = une fois par trimestre.
const QUARTERLY = { freq: 'seasonal', every: 'monthly' };

function defaultTemplates() {
  return [
    // Cuisine
    tpl('Vaisselle / lave-vaisselle', 15, 'daily', 'cuisine', { difficulty: 1 }),
    tpl('Trier le frigo (jeter les périmés)', 5, 'weekly', 'cuisine', { difficulty: 1 }),
    tpl('Nettoyer plaques de cuisson et plan de travail à fond', 10, 'biweekly', 'cuisine'),
    tpl('Nettoyer le frigo', 20, 'monthly', 'cuisine', { difficulty: 3 }),
    tpl('Nettoyer le micro-ondes', 10, 'monthly', 'cuisine'),
    tpl('Nettoyer le filtre du lave-vaisselle', 5, 'monthly', 'cuisine', { difficulty: 1 }),
    tpl('Détartrer la bouilloire / cafetière', 10, 'monthly', 'cuisine', { difficulty: 1 }),
    tpl('Nettoyer le four', 25, 'seasonal', 'cuisine', { ...QUARTERLY, months: [1, 4, 7, 10], difficulty: 3 }),
    tpl('Nettoyer la hotte et son filtre', 15, 'seasonal', 'cuisine', { ...QUARTERLY, months: [2, 5, 8, 11], difficulty: 3 }),
    // Poubelles : jours fixes, verrouillés
    tpl('Sortir la poubelle grise', 5, 'weekly', 'poubelles', { fixedDay: 0, difficulty: 1 }),
    tpl('Rentrer la poubelle grise', 2, 'weekly', 'poubelles', { fixedDay: 0, difficulty: 1 }),
    tpl('Sortir la poubelle jaune', 5, 'weekly', 'poubelles', { fixedDay: 2, difficulty: 1 }),
    tpl('Rentrer la poubelle jaune', 2, 'weekly', 'poubelles', { fixedDay: 2, difficulty: 1 }),
    tpl('Laver les bacs à poubelle', 15, 'seasonal', 'poubelles', { ...QUARTERLY, months: [3, 6, 9, 12], difficulty: 3 }),
    // Aspirateur : une tâche par pièce
    tpl('Aspirateur : cuisine', 10, 'weekly', 'menage'),
    tpl('Aspirateur : salon', 10, 'weekly', 'menage'),
    tpl('Aspirateur : salle de bain du bas', 5, 'weekly', 'menage'),
    tpl('Aspirateur : salle de bain du haut', 5, 'weekly', 'menage'),
    tpl('Aspirateur : ma chambre', 10, 'weekly', 'menage'),
    tpl('Aspirateur : escalier et couloirs', 10, 'weekly', 'menage'),
    // Ménage
    tpl('Nettoyer la salle de bain', 25, 'weekly', 'menage', { difficulty: 3 }),
    tpl('Nettoyer les toilettes', 10, 'weekly', 'menage', { difficulty: 3 }),
    tpl('Nettoyer les miroirs', 10, 'biweekly', 'menage', { difficulty: 1 }),
    tpl('Dépoussiérer les meubles et étagères', 15, 'biweekly', 'menage'),
    tpl('Essuyer poignées de porte et interrupteurs', 10, 'monthly', 'menage', { difficulty: 1 }),
    tpl('Aspirer le canapé (sous les coussins)', 10, 'monthly', 'menage'),
    tpl('Secouer / aspirer les tapis', 10, 'monthly', 'menage'),
    tpl('Laver les vitres', 30, 'seasonal', 'menage', { months: [4, 9], every: 'monthly', difficulty: 3 }),
    // Linge
    tpl('Lancer et étendre une machine', 20, 'weekly', 'linge', { difficulty: 1 }),
    tpl('Plier et ranger le linge', 15, 'weekly', 'linge'),
    tpl('Changer les draps', 15, 'biweekly', 'linge'),
    tpl('Nettoyer le lave-linge (filtre et joint)', 15, 'seasonal', 'linge', { ...QUARTERLY, months: [3, 6, 9, 12] }),
    tpl('Aérer et retourner le matelas', 10, 'seasonal', 'linge', { ...QUARTERLY, months: [1, 4, 7, 10] }),
    // Courses
    tpl('Faire la liste et les courses', 30, 'weekly', 'courses'),
    // Jardin
    tpl('Arroser le jardin et les plantes', 10, 'seasonal', 'jardin', { months: [5, 6, 7, 8, 9], every: 'weekly', difficulty: 1 }),
    tpl('Tondre la pelouse', 30, 'seasonal', 'jardin', { months: [4, 5, 6, 7, 8, 9, 10], every: 'biweekly', difficulty: 3 }),
    tpl('Désherber', 20, 'seasonal', 'jardin', { months: [4, 5, 6, 7, 8, 9], every: 'biweekly' }),
    tpl('Tailler la haie', 30, 'seasonal', 'jardin', { months: [5, 9], every: 'monthly', difficulty: 3 }),
    tpl('Nettoyer la terrasse', 20, 'seasonal', 'jardin', { months: [4, 7], every: 'monthly' }),
    tpl('Ramasser les feuilles', 30, 'seasonal', 'jardin', { months: [10, 11], every: 'biweekly' }),
  ];
}

/** Met à jour des données enregistrées par une ancienne version de l'app. */
export function migrate(data) {
  if ((data.version || 1) < 2) {
    const gone = new Set(data.templates.filter((t) => REMOVED.includes(t.name)).map((t) => t.id));
    data.templates = data.templates.filter((t) => !gone.has(t.id));
    data.planned = (data.planned || []).filter((p) => !(gone.has(p.templateId) && p.status === 'todo'));
    const names = new Set(data.templates.map((t) => t.name));
    for (const t of defaultTemplates()) if (!names.has(t.name)) data.templates.push(t);
    if (data.settings) delete data.settings.playBlocks;
    data.version = 2;
  }
  return data;
}

export function defaultState() {
  return {
    version: VERSION,
    settings: {
      name: '',
      wake: '07:00',
      sleep: '23:00',
      maxLoad: 45,
      weekendLoad: 90,
      examCap: 20,
      hardDayCap: 10,
      dailyRevision: 0,
      reminderTime: '19:30',
      // Trajet maison – IUT : 45 min avec maman, 1 h 40 sinon (remplacé par le trajet IDF Mobilités s'il est calculé).
      commuteMin: 45,
      commuteMax: 100,
      commuteMorning: true,
      notifications: false,
      useEdt: true,
      edtUrl: 'edt.json',
      hiddenEdt: [],
      bonusEnabled: true,
      // Cours d'arabe 20h–23h : mardi ou mercredi selon l'heure de fin des cours (voir arabicPlan)
      arabic: {
        enabled: true, title: 'Cours d’arabe', start: '20:00', end: '23:00',
        days: [1, 2], tieDay: 2, lateFrom: '18:00', commute: false, cap: 20,
      },
    },
    events: [],
    exams: [],
    templates: [
      ...defaultTemplates(),
    ],
    bonusIdeas: [
      { name: 'Préparer le petit-déj pour tout le monde', duration: 15 },
      { name: 'Vider le lave-vaisselle sans qu’on le demande', duration: 10 },
      { name: 'Ranger l’entrée et les chaussures', duration: 10 },
      { name: 'Nettoyer les vitres d’une pièce', duration: 15 },
      { name: 'Désherber un coin du jardin', duration: 20 },
      { name: 'Faire un dessert pour le repas', duration: 30 },
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
    const data = migrate(JSON.parse(raw));
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
  migrate(data);
  const def = defaultState();
  return { ...def, ...data, settings: { ...def.settings, ...data.settings } };
}
