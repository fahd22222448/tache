// Chargement de l'emploi du temps publié par la GitHub Action (edt.json).

export async function fetchEdt(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`EDT indisponible (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data.events)) throw new Error('Format EDT inattendu');
  return data;
}

/** Changements que l'utilisateur n'a pas encore vus, uniquement pour aujourd'hui et après. */
export function unseenChanges(edt, seenAt, today) {
  if (!edt?.changes) return [];
  return edt.changes.filter((c) => (!seenAt || c.at > seenAt) && c.date >= today);
}
