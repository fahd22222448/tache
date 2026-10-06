# Tâche — ma semaine

Tu saisis ta semaine (cours, contrôles, activités) et la liste des tâches de la maison et du jardin. L'app répartit les tâches sur les jours où tu as le plus de temps et d'énergie. Elle garde toujours de la place pour réviser.

- **App web installable (PWA)** : elle marche hors ligne et s'ajoute à l'écran d'accueil. Elle ne demande ni compte ni serveur.
- **Emploi du temps de l'IUT synchronisé automatiquement** : une GitHub Action interroge le Celcat de l'IUT de Vélizy (groupe `RT3-FA-A1`) à heures fixes. Elle détecte les cours ajoutés, déplacés ou annulés et les publie avec l'app.

## Fonctionnalités

| | |
|---|---|
| ☀️ **Aujourd'hui** | Dans l'ordre : programme du jour (glisser à gauche/droite pour voir les autres jours) (cours avec type CM/TD/TP/DS, salle et enseignant, trajets, révisions), tâches à cocher avec bouton « Journée difficile », puis temps libre restant, plafond et heure de retour |
| 🗓️ **Semaine** | « Générer ma semaine », vue des 7 jours avec la charge de chacun, puis validation. Sur chaque tâche, `⋯` permet de reporter, déplacer, échanger ou supprimer (un imprévu se gère en 2 clics) |
| 🎓 **Planning** | État de la synchro EDT et derniers changements, contrôles et devoirs (date, matière, importance), activités ponctuelles ou répétées chaque semaine |
| 🧺 **Tâches** | Catalogue (nom, durée, fréquence, catégorie, difficulté, jour fixe, mois de saison) et ressenti 😖 / 😐 / 🙂 |
| 🔥 **Suivi** | Série de jours réussis, % de tâches faites, historique par semaine, bonus réalisés |
| ⚙️ **Réglages** | Heures de réveil et de coucher, plafonds, trajet, rappels, export agenda `.ics`, sauvegarde et restauration |

### Comment la semaine est générée (`js/scheduler.js`)

1. Les **tâches fixes** sont placées en premier : poubelle grise le lundi, jaune le mercredi (🔒).
2. **Temps libre** d'un jour = heures éveillées − cours (EDT) − activités − **trajets** − révisions automatiques. Les jours de cours, tout le temps passé hors de la maison compte comme occupé : le trajet aller, les cours, les trous entre deux cours et le trajet retour. Chaque trajet aller ou retour a un bouton **« Avec maman »** : coché, il dure 45 min, sinon 1 h 40 (durées réglables).
3. **Plafond de charge** par jour : 45 min par défaut, 20 min le jour et la veille d'un contrôle, réduit 2 à 3 jours avant pour un contrôle important. Le plafond n'est jamais dépassé : ce qui ne rentre pas va dans « À placer ».
4. **Ordre de placement** : tâches en retard, puis urgence, puis préférence (les tâches détestées vont sur les jours avec le plus d'énergie), puis les plus longues.
5. **Répartition** : chaque tâche va sur le jour le moins chargé, et l'app évite de placer la même tâche deux jours de suite.
6. Tu modifies la proposition si besoin, puis tu la **valides**.

**Révisions automatiques** : un contrôle normal ajoute 30 min la veille, un important 45 min sur 3 jours, un très important 60 min sur 5 jours.

**Rattrapage** : chaque jour, les tâches non faites passent au prochain créneau libre avec une priorité plus haute. Les tâches quotidiennes manquées, comme la vaisselle, ne sont pas cumulées.

**Cours d'arabe (20h–23h)** : chaque semaine, l'app compare l'heure de fin des cours du mardi et du mercredi dans l'EDT. Tu vas au cours le jour où tu finis le plus tôt. Si tu finis pareil, c'est le mercredi. Si l'un des deux jours finit à 18h ou plus, c'est l'autre jour. Si les deux finissent à 18h ou plus, il n'y a pas de cours cette semaine. Le jour est recalculé à chaque mise à jour de l'EDT ; jours et seuil sont réglables.

**Déjà faite par quelqu'un d'autre** : dans le menu `⋯` d'une tâche. Elle compte comme faite (elle ne revient pas avant sa prochaine échéance) sans entrer dans tes statistiques. L'app propose ensuite quoi faire à la place avec le temps libéré : avancer une tâche des jours suivants, ajouter une tâche du catalogue qui n'est pas prévue prochainement, ou faire une idée bonus. Tu peux aussi garder ce temps libre.

**Week-end** : plafond plus haut (90 min par défaut, réglable). Les grosses tâches (20 min ou plus, ou pénibles) y sont placées en priorité.

**Tâche bonus** : une petite action en plus est proposée chaque semaine, s'il reste de la place sous le plafond.

## Mise en ligne (une seule fois)

1. Pousse ce dépôt sur GitHub. Il doit être **public** pour utiliser GitHub Pages avec un compte gratuit.
2. Dans **Settings → Pages**, règle *Build and deployment → Source* sur **GitHub Actions**.
3. Dans **Actions**, lance *« Publier l'app et synchroniser l'EDT »* avec *Run workflow*.
4. Ouvre `https://<ton-pseudo>.github.io/tache/` sur ton téléphone, puis *Ajouter à l'écran d'accueil*.

### Synchronisation de l'emploi du temps

Le workflow `.github/workflows/pages.yml` tourne à **6h00, 12h00 et 18h30** (heure d'hiver de Paris, une heure de plus en été). Il tourne aussi à chaque push et à la demande. Pour changer les heures, modifie les lignes `cron` (elles sont en UTC).

- L'app recharge `edt.json` à chaque ouverture et toutes les 30 min. Si un cours a bougé, un bandeau 📢 s'affiche avec un bouton *Replanifier ma semaine*.
- **Notification push quand l'EDT change**, même si l'app est fermée : installe l'app [ntfy](https://ntfy.sh) et abonne-toi à un nom de sujet secret (par exemple `edt-rt3-xxxx`). Ajoute ensuite ce nom dans **Settings → Secrets and variables → Actions** sous le secret `NTFY_TOPIC`.
- Pour un autre groupe, crée la variable `EDT_GROUP` (même endroit, onglet *Variables*).
- GitHub met en pause les tâches planifiées après 60 jours sans activité sur le dépôt. Un commit ou un *Run workflow* les relance.

### Trajets en transports (IDF Mobilités / PRIM)

Pour chaque jour de cours des 7 prochains jours, la même GitHub Action calcule :
- **l'aller** : heure de départ de chez toi pour arriver 10 min avant le premier cours ;
- **le retour** : départ 5 min après le dernier cours, et heure d'arrivée à la maison.

Le calcul passe par l'API Navitia de [PRIM](https://prim.iledefrance-mobilites.fr), avec les données temps réel.

Dans l'app, le trajet affiche les lignes, les arrêts et les horaires, avec un bouton d'itinéraire. Une notification « Pars dans 15 min » arrive avant le départ, et l'export `.ics` contient les départs avec une alarme. Si « Avec maman » est coché, le trajet calculé est remplacé par 45 min.

À configurer dans **Settings → Secrets and variables → Actions** :

| Nom | Où | Valeur |
|---|---|---|
| `PRIM_API_KEY` | *Secrets* | ta clé PRIM |
| `HOME_ADDRESS` | *Variables* | ton adresse, ton arrêt de départ ou `lat,lon` |
| `IUT_ADDRESS` | *Variables* (optionnel) | par défaut 10 avenue de l'Europe, Vélizy |
| `ARRIVE_MARGIN` | *Variables* (optionnel) | minutes d'avance avant le cours (10) |

Test en local : `npm run edt` écrit `edt.json` à la racine.

## Développement

```bash
npm test     # tests du moteur de planification et du parseur EDT (node --test)
npm start    # serveur local sur http://localhost:8080
```

Le projet n'a aucune dépendance et aucune étape de build : HTML, CSS et modules JavaScript natifs.

```
index.html, styles.css, sw.js, manifest.webmanifest
js/
  app.js        interface (vues, actions, rappels)
  scheduler.js  génération de la semaine, rattrapage, journée difficile
  store.js      données (localStorage), catalogue par défaut
  stats.js      série, pourcentage, historique
  ics.js        export vers l'agenda du téléphone
  edt.js        chargement de edt.json
scripts/fetch-edt.mjs   récupération Celcat + détection des changements
tests/                  tests node:test
```

### Données stockées

- **Réglages** : prénom, heures de réveil et de coucher, plafonds, trajet, heure du rappel
- **Événement** : titre, date ou jour de la semaine, début, fin, répétition
- **Contrôle ou devoir** : matière, date, importance
- **Tâche modèle** : nom, durée, fréquence, catégorie, difficulté, jour fixe, ressenti, mois de saison
- **Tâche planifiée** : tâche, jour, statut (`todo`, `done`, `postponed`, `missed`, `skipped`), date de réalisation, priorité

### Limites connues

- Les notifications web s'affichent quand l'app est ouverte ou a été utilisée récemment. Pour un rappel garanti (les poubelles !), utilise *Exporter vers mon agenda (.ics)* : les tâches arrivent dans l'agenda du téléphone avec une alarme.
- Les données restent sur l'appareil. Pense à *Sauvegarder* de temps en temps.
