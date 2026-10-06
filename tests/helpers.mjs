// store.js utilise localStorage : on fournit un faux stockage pour les tests Node.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
const { defaultState } = await import('../js/store.js');

export function defaultStateForTests() {
  const s = defaultState();
  s.settings.useEdt = false;
  s.settings.gym.enabled = false;
  return s;
}
