# 🍿 Séance synchronisée

**Deux façons de s'en servir.**

| | Tu héberges (local) | Hébergé en ligne (cloud) |
|---|---|---|
| Ta machine doit être allumée | oui | non |
| Fichiers de ton disque diffusés aux autres | oui | non |
| Navigation web partagée | oui | non (ce serait un relais ouvert) |
| Chacun lit sa copie du film | oui | oui |
| YouTube, lien direct | oui | oui |
| Comment on entre | lien + clé d'accès | **code de séance** |

Le mode cloud est celui que tu veux si tes potes ne sont pas chez toi : ils installent
l'application, tapent le code, et personne n'a besoin d'être « l'hôte ». Voir
[Mettre le service en ligne](#mettre-le-service-en-ligne) plus bas.

---


Une salle de visionnage en localhost : **la même vidéo, à la même seconde, pour tout le monde**.
Zéro dépendance npm, un seul fichier serveur, tout tourne sur ta machine.

## Démarrer

```bash
node server.js
```

La console affiche deux adresses :

```
Local    : http://localhost:7777
Réseau   : http://192.168.1.x:7777   <- à donner aux potes
```

Tes potes ouvrent l'adresse **Réseau** (même Wi-Fi / même LAN), tapent un pseudo, entrent
dans la même salle. Le bouton **Inviter** copie le lien directement.

Options :

```bash
node server.js --port 8080 --media "D:\Films"
```

## Comment la synchro tient la seconde

Trois mécanismes empilés, c'est ce qui évite le décalage qui s'installe au bout de 20 min :

1. **Horloge commune.** Au démarrage, chaque client sonde `/time` sept fois, garde les
   trois aller-retours les plus courts et en déduit son décalage avec l'horloge du
   serveur. Recalibrage toutes les 30 s, lissé pour éviter les à-coups.
2. **Position théorique, pas position copiée.** Le serveur ne diffuse pas « je suis à
   12:31 » — il diffuse *« à l'instant T, la vidéo est à la position P, vitesse V »*.
   Chaque client calcule lui-même où il devrait être. Un retardataire qui rejoint en
   cours de route tombe pile au bon endroit.
3. **Correction continue.** Toutes les 150 ms, chaque lecteur compare sa position réelle
   à la théorique :
   - écart < 22 ms → on ne touche à rien (zone morte volontairement étroite : l'écart
     entre deux clients vaut au pire le double) ;
   - écart < 300 ms → **micro-variation de vitesse**, proportionnelle à l'erreur et
     plafonnée à ±12 %. Inaudible, sans saut d'image, constante de temps ~1 s ;
   - écart > 300 ms → saut sec, avec anticipation du temps de recherche. Au-delà de ce
     seuil, rattraper en douceur prendrait plus de 2,5 s : un micro-saut vaut mieux.

À cela s'ajoute le **départ programmé** : quand quelqu'un appuie sur lecture, le serveur
annonce un départ 600 ms plus tard. Tout le monde se positionne, se pré-charge, puis
démarre au même instant — au lieu de partir en cascade selon la latence de chacun. C'est
ce qui explique le petit délai entre le clic et l'image : il est volontaire.

Et l'**attente collective** (activée par défaut) : si un client bufferise, tout le monde
se met en pause au même point et repart ensemble. Un filet de sécurité relance la séance
si un retardataire ne répond pas au bout de 15 s.

L'indicateur en haut à droite affiche ton écart réel en millisecondes ; le panneau
Participants l'affiche pour chacun.

**Mesures relevées** avec deux clients sur la même machine (aller-retour réseau 2-3 ms),
en comparant les positions horodatées sur l'horloge partagée :

| Situation | Écart entre les deux clients |
|---|---|
| Lecture établie | **< 1 ms** (les deux stabilisés à -14 ms de la cible théorique) |
| 4 s après un déplacement en pleine lecture | **19 ms**, re-convergence sans aucun saut |
| Juste après un départ | ~100 ms, résorbés en 2 à 4 s |

Sur un vrai réseau local la latence est plus élevée, mais elle est absorbée par l'horloge
partagée : c'est la *variation* de latence qui compte, pas sa valeur.

## Les trois sources vidéo

| Source | Ce que ça fait | Qualité de synchro |
|---|---|---|
| **Fichiers de l'hôte** | Le dossier `media/` est diffusé sur le réseau local (streaming avec requêtes Range, donc le déplacement dans la barre est instantané). Chacun lit exactement le même fichier. | La meilleure |
| **Chacun sa copie** | Chaque participant ouvre *son* fichier depuis *son* disque. Aucune vidéo ne transite : seule l'horloge circule. **C'est le mode à utiliser quand vous n'êtes pas sur le même réseau**, ou quand le fichier est trop lourd à diffuser. | Identique à la précédente |
| **Lien direct** | Une URL `.mp4` / `.webm` / `.ogg` publique ; chacun télécharge de son côté. Les sous-titres distants passent par le serveur (conversion `.srt` et contournement CORS). | Très bonne |
| **YouTube** | Lecteur embarqué piloté par la même horloge. | ~0,3 s : l'API YouTube n'accepte pas les micro-ajustements de vitesse, la correction se fait par recalage |

Dans le mode « chacun sa copie », l'appli compare les tailles de fichier et prévient si l'un de vous a
une version différente. Tant que quelqu'un n'a pas désigné son fichier, la lecture ne démarre pas — et
le panneau Participants dit qui manque à l'appel.

Un glisser-déposer de fichier n'importe où dans la fenêtre ouvre ce mode directement ; déposer un
`.srt` ou un `.vtt` charge des sous-titres pour toi seul.

Pour les fichiers partagés : dépose tes vidéos dans `media/` (sous-dossiers acceptés,
3 niveaux). Un sous-titre `.srt` ou `.vtt` portant le même nom que la vidéo est chargé
automatiquement (le `.srt` est converti en WebVTT à la volée).

> Formats : le navigateur lit du **MP4 (H.264/AAC)**, du **WebM** et de l'**Ogg**.
> Le `.mkv` est listé mais grisé — Chrome et Firefox ne le lisent pas. Remuxe-le d'abord :
> `ffmpeg -i film.mkv -c copy film.mp4`

## Le mode « Web partagé »

Le second onglet est un navigateur commun : le pilote navigue, les autres voient la même
page, avec les curseurs de chacun et le défilement synchronisé. Pratique pour choisir
quoi regarder à plusieurs.

Les pages passent par un proxy local qui retire les en-têtes `X-Frame-Options` et `CSP`
et injecte un petit script de relais. Limites assumées :

- les applications lourdes en JavaScript (et tout ce qui est protégé par DRM — Netflix,
  Disney+, Prime Video) ne fonctionnent pas dans ce mode ;
- les formulaires POST ne sont pas relayés ;
- une navigation déclenchée par le JavaScript du site sort de la synchro (un clic sur
  Rafraîchir remet tout le monde d'accord).

Pour ces plateformes-là, le bon usage reste : chacun ouvre son propre onglet Netflix, et
cette appli sert d'horloge commune + chat.

## Raccourcis

| Touche | Action |
|---|---|
| `Espace` / `K` | Lecture / pause pour tout le monde |
| `←` / `→` | Reculer / avancer de 5 s pour tout le monde |
| `F` | Plein écran (local) |
| `M` | Couper le son (local) |

Volume, plein écran et sous-titres sont **locaux** : tu règles ton confort sans imposer
quoi que ce soit aux autres. Lecture, pause, déplacement et vitesse sont **collectifs**.

Le **pilotage** se transfère depuis le panneau Participants : le pilote clique sur ⇄ à côté de
quelqu'un pour lui passer la main, et n'importe qui peut la reprendre avec « Prendre le pilotage ».
En mode Cinéma tout le monde peut agir sur la lecture ; en mode Web partagé, seul le pilote navigue,
sauf si la case « libre » est cochée.

## Notes

- Le serveur est prévu pour un réseau local de confiance : pas d'authentification, et le
  proxy accepte n'importe quelle URL. Ne l'expose pas sur Internet tel quel.
- Les pages proxifiées sont servies sur `127.0.0.1` alors que l'application vit sur
  `localhost` : origines distinctes, donc le contenu externe ne peut pas lire le stockage
  de l'appli ni la scripter. C'est là toute l'isolation du mode web : l'iframe ne porte
  **pas** d'attribut `sandbox`, parce que selon le contexte d'imbrication ses drapeaux
  sont intersectés avec ceux du parent et le script de relais cesse alors de s'exécuter —
  la synchro du mode web tombe en panne sans le moindre message d'erreur.
- Le transport est du SSE (serveur → clients) + `POST /send` (clients → serveur). Sur un
  LAN, les commandes circulent en quelques millisecondes ; le départ programmé absorbe de
  toute façon les écarts de latence.

## Mettre le service en ligne

Le fichier **`seance-a-deployer.zip`** contient exactement ce qu'il faut envoyer (le code,
sans tes vidéos ni tes fichiers d'état). Aucune dépendance à installer, aucune base de
données : le service tient dans un seul fichier Node.

1. Sur **github.com**, crée un dépôt vide (public ou privé, peu importe).
2. Sur la page du dépôt : *Add file → Upload files*, puis glisse le **contenu** du zip
   (`server.js`, `package.json`, `render.yaml`, le dossier `public/`). Pas besoin de git
   installé, tout se fait dans le navigateur.
3. Sur **render.com**, *New → Blueprint*, choisis ce dépôt. Le fichier `render.yaml` déjà
   présent configure tout — y compris `CLOUD=1`, qui désactive la médiathèque et le proxy.
4. Render te donne une adresse en `…onrender.com`. C'est le lien à donner à tes potes.

Sur cette adresse, chacun peut « Installer l'application » (c'est une PWA : icône sur le
bureau ou l'écran d'accueil, fenêtre propre sans barre d'adresse). Ensuite : quelqu'un crée
une séance, partage le code à six caractères, et tout le monde ouvre sa copie du film.

> **Le plan gratuit de Render met le service en veille après ~15 min sans visite.** Le
> premier à se connecter attend alors une trentaine de secondes le temps du réveil. Sans
> conséquence sur la synchro une fois la séance lancée.

Le code de séance est le seul secret : il est tiré au hasard et n'est pas devinable, et un
code inconnu renvoie « séance inconnue » au lieu d'ouvrir une salle vide. Une séance sans
personne dedans expire au bout de 3 heures.

## Fichiers

```
server.js          serveur : salles, horloge, streaming Range, proxy
render.yaml        configuration de déploiement (mode cloud)
public/index.html  interface
public/style.css   thème
public/sync.js     horloge partagée + correcteur de dérive + adaptateurs lecteur
public/app.js      application : salle, lecteur, chat, navigation partagée
public/inject.js   script injecté dans les pages proxifiées
public/sw.js       service worker (installation en application)
public/manifest.webmanifest  identité de l'app installée
media/             tes vidéos (mode local uniquement)
.acces             clé d'accès locale — supprime-le pour en régénérer une
```
