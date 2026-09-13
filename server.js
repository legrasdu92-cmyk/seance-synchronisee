'use strict';
/**
 * Navigateur synchronise - serveur local (zero dependance).
 *
 *   node server.js [--port 7777] [--media "D:\\Films"]
 *
 * Endpoints :
 *   GET  /                     application
 *   GET  /events?room&name     flux SSE (etat de la salle)
 *   POST /send                 evenements client -> salle
 *   POST /time                 synchronisation d'horloge (style NTP)
 *   GET  /media/list           videos disponibles dans le dossier partage
 *   GET  /media/file?p=        streaming avec support des requetes Range
 *   GET  /media/sub?p=         sous-titres convertis en WebVTT
 *   GET  /proxy?url=           navigation partagee (mode web)
 *   GET  /__cobrowse.js        script injecte dans les pages proxifiees
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- config ---

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT || 7777));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEDIA_DIR = path.resolve(arg('media', process.env.MEDIA_DIR || path.join(__dirname, 'media')));

/**
 * Deux facons de faire tourner ce serveur :
 *
 *  - en local (defaut) : tu heberges la seance sur ta machine. Elle diffuse
 *    tes fichiers et sert de navigateur partage. Il faut que ta machine
 *    reste allumee, et une cle d'acces protege le tout.
 *
 *  - en cloud (CLOUD=1) : le serveur ne garde que l'horloge, les salles et le
 *    chat. Aucun disque a servir. Chacun lit sa propre copie du film, et le
 *    code de seance tient lieu de secret. Personne n'a besoin d'etre
 *    "l'hote". La navigation partagee est en option (WEB_PROXY=1, voir plus
 *    bas) : reservee aux participants d'une seance, jamais un relais ouvert.
 */
const CLOUD = !!(process.env.CLOUD || process.env.RENDER);

/**
 * Navigation partagee (proxy) sur le serveur heberge : WEB_PROXY=1.
 * Sans garde-fou ce serait un relais anonyme ; ici il n'est accessible qu'aux
 * participants d'une seance en cours (code + identifiant de client), il
 * refuse les adresses internes et il est limite en debit par salle.
 */
const WEB_PROXY = !CLOUD || /^(1|true|yes|on)$/i.test(String(process.env.WEB_PROXY || ''));
const dns = require('dns');

/**
 * Diffusion du film depuis l'appareil de l'hote (HOST_UPLOAD, actif par
 * defaut). L'hote televerse une fois son fichier ; le serveur le garde dans un
 * dossier temporaire par salle et le diffuse a tout le monde avec support des
 * requetes Range (positionnement instantane). Les autres n'ont rien a
 * telecharger d'avance. Plafonne pour ne pas saturer le disque/le debit d'un
 * hebergement gratuit. */
const HOST_UPLOAD = !/^(0|false|no|off)$/i.test(String(process.env.HOST_UPLOAD || '1'));
const HOST_UPLOAD_MAX = Number(process.env.HOST_UPLOAD_MAX_MB || 800) * 1024 * 1024;
const UPLOAD_DIR = path.join(os.tmpdir(), 'seance-uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}

/** Chemin du film televerse pour une salle (un seul a la fois). */
function hostFilePath(roomId) {
  return path.join(UPLOAD_DIR, roomId.replace(/[^a-z0-9_-]/gi, '') + '.upload');
}
/** Type MIME du film televerse, deduit de l'extension du nom d'origine et
 *  garde a cote du fichier (le fichier temporaire, lui, n'a pas d'extension). */
function hostTypePath(roomId) {
  return hostFilePath(roomId) + '.type';
}
function hostFileType(roomId) {
  try {
    const t = fs.readFileSync(hostTypePath(roomId), 'utf8').trim();
    if (t) return t;
  } catch (_) {}
  return 'video/mp4';
}
function clearHostFile(roomId) {
  try { fs.unlinkSync(hostFilePath(roomId)); } catch (_) {}
  try { fs.unlinkSync(hostTypePath(roomId)); } catch (_) {}
}

// ------------------------------------------------------------ cle d'acces ---
// Le serveur diffuse des fichiers du disque et sait aller chercher n'importe
// quelle page web. Expose sur Internet sans controle, il deviendrait un relais
// ouvert. Une cle stable est donc exigee a chaque requete : elle voyage dans le
// lien d'invitation, puis vit dans un cookie.
const TOKEN_FILE = path.join(__dirname, '.acces');
const PUBLIC_URL_FILE = path.join(__dirname, '.lien-public');

let ACCESS_KEY = (process.env.CB_KEY || arg('key', '')).trim();
if (!ACCESS_KEY) {
  try {
    ACCESS_KEY = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (_) {}
}
if (!ACCESS_KEY) {
  ACCESS_KEY = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
  try {
    fs.writeFileSync(TOKEN_FILE, ACCESS_KEY);
  } catch (_) {}
}

function publicUrl() {
  try {
    return fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim() || null;
  } catch (_) {
    return null;
  }
}

function sameKey(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** @returns {'query'|'cookie'|null} */
function checkAccess(req, url) {
  const k = url.searchParams.get('k');
  if (k && sameKey(k, ACCESS_KEY)) return 'query';
  const m = /(?:^|;\s*)cbk=([^;]+)/.exec(req.headers.cookie || '');
  if (m) {
    let v = m[1];
    try {
      v = decodeURIComponent(v);
    } catch (_) {}
    if (sameKey(v, ACCESS_KEY)) return 'cookie';
  }
  return null;
}

function stripKey(search) {
  const q = new URLSearchParams(search);
  q.delete('k');
  const s = q.toString();
  return s ? '?' + s : '';
}

function denied(res) {
  const body = Buffer.from(
    '<!doctype html><meta charset="utf-8"><title>Acces refuse</title><style>' +
      'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#080b12;color:#e6ebf5;font:15px/1.6 system-ui,Segoe UI,sans-serif;text-align:center}' +
      'div{max-width:420px;padding:32px}h1{font-size:19px;margin:0 0 10px}' +
      'p{color:#8b96ad;font-size:13px}</style>' +
      '<div><h1>Seance privee</h1><p>Ce lien doit contenir la cle d’acces fournie par l’hôte ' +
      'de la séance. Redemande-lui le lien complet.</p></div>',
    'utf8'
  );
  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Avance (ms) entre l'ordre de lecture et le demarrage reel : laisse le temps
 *  a tout le monde de se positionner pour que les lectures partent au meme
 *  instant plutot qu'en cascade. */
const START_LEAD_MS = 600;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** En-tetes d'un vrai Chrome, pour ne pas etre bloque par les filtres qui
 *  rejettent une requete trop nue. Ceci ne resout aucun defi anti-robot
 *  (Cloudflare & co restent hors de portee d'un proxy serveur) : ca aide
 *  seulement les sites a protection legere a nous laisser passer. */
function browserHeaders(u, ctx) {
  ctx = ctx || {};
  const referer = ctx.referer;
  const h = {
    'User-Agent': UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    ...(referer ? { Referer: referer } : {}),
  };
  // Requete Range du lecteur : relayee telle quelle pour un streaming fluide
  // avec positionnement (seek) sur une video/audio proxifiee.
  if (ctx.range) h['Range'] = ctx.range;
  // Porte-cookies : on renvoie au site les cookies qu'il a poses, comme un vrai
  // navigateur - ce qui debloque les sites a etapes (bannieres, redirections,
  // sessions simples). Cloisonne par participant (voir cookieJar).
  const cookies = ctx.jarKey ? getCookies(ctx.jarKey, u) : '';
  if (cookies) h['Cookie'] = cookies;
  return h;
}

// ------------------------------------------------------- porte-cookies ---
// Un jar par participant (cle = who|host en cloud, "local|host" sinon) : sur le
// serveur heberge, les cookies d'un utilisateur ne doivent JAMAIS fuiter vers un
// autre. Volontairement simple : pas de path, expiration approximative.
const cookieJars = new Map(); // jarKey -> Map(name -> {value, expires})
function jarKeyFor(who, u) {
  return (who || 'local') + '|' + u.hostname.replace(/^www\./, '');
}
function storeCookies(jarKey, u, setCookie) {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  let jar = cookieJars.get(jarKey);
  if (!jar) { jar = new Map(); cookieJars.set(jarKey, jar); }
  for (const line of list) {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    const mExp = /expires=([^;]+)/i.exec(line);
    let expires = 0;
    if (mExp) { const t = Date.parse(mExp[1]); if (!Number.isNaN(t)) expires = t; }
    const mMax = /max-age=(\d+)/i.exec(line);
    if (mMax) expires = Date.now() + Number(mMax[1]) * 1000;
    if (/expires=/i.test(line) && expires && expires < Date.now()) { jar.delete(name); continue; }
    jar.set(name, { value, expires });
  }
  // Borne memoire : au-dela on oublie les plus vieux jars.
  if (cookieJars.size > 5000) {
    const k = cookieJars.keys().next().value;
    cookieJars.delete(k);
  }
}
function getCookies(jarKey, u) {
  const jar = cookieJars.get(jarKey);
  if (!jar) return '';
  const now = Date.now();
  const out = [];
  for (const [name, c] of jar) {
    if (c.expires && c.expires < now) { jar.delete(name); continue; }
    out.push(name + '=' + c.value);
  }
  return out.join('; ');
}

const COLORS = ['#f97316', '#22d3ee', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#60a5fa', '#fb7185'];

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.ogg', '.mov', '.mkv']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.opus']);
const SUB_EXT = ['.vtt', '.srt'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.opus': 'audio/ogg',
  '.vtt': 'text/vtt; charset=utf-8',
};

// ----------------------------------------------------------------- salles ---

/** @type {Map<string, Room>} */
const rooms = new Map();

function newRoom(id) {
  return {
    id,
    clients: new Map(),
    host: null,
    chat: [],
    mode: 'cinema', // 'cinema' | 'web'
    waitForAll: true,
    stalled: new Set(),
    media: null, // { kind:'file'|'url'|'youtube', src, title, sub, poster }
    duration: 0, // duree annoncee par les lecteurs, sert a stopper a la fin
    play: { playing: false, position: 0, anchor: Date.now(), rate: 1 },
    web: { history: [], index: -1, nonce: 0, scroll: { x: 0, y: 0 }, free: false },
    rev: 0,
    // Diffusion en direct : l'hote garde le fichier sur son appareil et le
    // serveur ne relaie que les tranches demandees (aucun stockage, aucune
    // limite de taille). `stream` decrit la source vive du moment.
    stream: null, // { by, name, size, mime, token }
    pulls: new Map(), // reqId -> { res, start, end, size, mime, timer }
    pullSeq: 0,
    sharer: null, // clientId qui partage son ecran (WebRTC), le cas echeant
  };
}

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, newRoom(id));
  return rooms.get(id);
}

function pickColor(room) {
  const used = new Set([...room.clients.values()].map((c) => c.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[room.clients.size % COLORS.length];
}

function publicClient(c) {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    ready: c.ready,
    // pourquoi ce participant n'est pas pret, quand son lecteur a echoue
    error: c.error || null,
    drift: c.drift,
    rtt: c.rtt,
    buffered: c.buffered,
    // mode "fichier local" : ce participant a-t-il designe sa copie du film ?
    hasFile: c.hasFile,
  };
}

function snapshot(room) {
  return {
    id: room.id,
    rev: room.rev,
    mode: room.mode,
    host: room.host,
    waitForAll: room.waitForAll,
    pending: !!room.pendingPlay,
    media: room.media,
    play: room.play,
    sharer: room.sharer || null,
    serverTime: Date.now(),
    clients: [...room.clients.values()].map(publicClient),
    chat: room.chat.slice(-60),
    web: {
      url: room.web.history[room.web.index] || null,
      canBack: room.web.index > 0,
      canForward: room.web.index < room.web.history.length - 1,
      nonce: room.web.nonce,
      scroll: room.web.scroll,
      free: room.web.free,
    },
  };
}

function sse(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch (_) {
    /* connexion fermee */
  }
}

/** Fin de la diffusion en direct : la source (l'hote) est partie ou a coupe.
 *  On libere les demandes de tranches en attente et on retire le media vif. */
function endStream(room) {
  if (!room.stream) return;
  for (const [, p] of room.pulls) {
    clearTimeout(p.timer);
    try { p.res.writeHead(504, { 'Content-Type': 'text/plain' }); p.res.end('source partie'); } catch (_) {}
  }
  room.pulls.clear();
  room.stream = null;
  if (room.media && room.media.kind === 'stream') {
    room.media = null;
    setPaused(room, 0);
  }
}

function broadcast(room, event, data, exceptId) {
  for (const c of room.clients.values()) {
    if (exceptId && c.id === exceptId) continue;
    sse(c.res, event, data);
  }
}

function pushState(room) {
  room.rev++;
  broadcast(room, 'state', snapshot(room));
}

function pushPresence(room) {
  broadcast(room, 'presence', {
    clients: [...room.clients.values()].map(publicClient),
    host: room.host,
  });
}

function system(room, text) {
  const msg = { id: 'sys', name: 'systeme', color: '#94a3b8', text, ts: Date.now(), system: true };
  room.chat.push(msg);
  if (room.chat.length > 300) room.chat.shift();
  broadcast(room, 'chat', msg);
}

// ------------------------------------------------------- moteur de lecture ---

/** Position mediatique attendue a l'instant serveur `at`. */
function positionAt(room, at) {
  const p = room.play;
  if (!p.playing) return p.position;
  const elapsed = Math.max(0, at - p.anchor) / 1000;
  return p.position + elapsed * p.rate;
}

function setPaused(room, position) {
  room.play = {
    playing: false,
    position: Math.max(0, position),
    anchor: Date.now(),
    rate: room.play.rate,
  };
}

function setPlaying(room, position, lead) {
  room.play = {
    playing: true,
    position: Math.max(0, position),
    anchor: Date.now() + (lead === undefined ? START_LEAD_MS : lead),
    rate: room.play.rate,
  };
}

function noteDuration(room, d) {
  const v = Number(d);
  if (Number.isFinite(v) && v > 0) room.duration = Math.max(room.duration, v);
}

function everyoneReady(room) {
  for (const c of room.clients.values()) if (!c.ready) return false;
  return true;
}

// ------------------------------------------------------------ evenements ---

function canDrive(room, client) {
  return room.host === client.id || room.web.free || room.mode === 'cinema';
}

function handleEvent(room, client, msg) {
  switch (msg.type) {
    // --- lecture ------------------------------------------------------
    case 'play': {
      let pos = Number.isFinite(msg.position) ? msg.position : positionAt(room, Date.now());
      // Relancer depuis la fin repart du debut plutot que de rester bloque.
      if (room.duration && pos >= room.duration - 0.25) pos = 0;
      if (room.waitForAll && !everyoneReady(room)) {
        setPaused(room, pos);
        room.pendingPlay = true;
        room.pendingSince = Date.now();
        pushState(room);
        system(room, 'En attente du chargement de tout le monde...');
      } else {
        room.pendingPlay = false;
        room.stalled.clear();
        setPlaying(room, pos);
        pushState(room);
      }
      break;
    }
    case 'pause': {
      const pos = Number.isFinite(msg.position) ? msg.position : positionAt(room, Date.now());
      room.pendingPlay = false;
      setPaused(room, pos);
      pushState(room);
      break;
    }
    case 'seek': {
      const pos = Math.max(0, Number(msg.position) || 0);
      const wasPlaying = room.play.playing || room.pendingPlay;
      if (wasPlaying) setPlaying(room, pos);
      else setPaused(room, pos);
      room.stalled.clear();
      pushState(room);
      break;
    }
    case 'rate': {
      const r = Math.min(4, Math.max(0.25, Number(msg.rate) || 1));
      const pos = positionAt(room, Date.now());
      room.play.rate = r;
      if (room.play.playing) setPlaying(room, pos, 250);
      else setPaused(room, pos);
      room.play.rate = r;
      pushState(room);
      break;
    }
    case 'media': {
      const m = msg.media || {};
      if (!m.src || !['file', 'url', 'youtube', 'local', 'hosted'].includes(m.kind)) break;
      // 'hosted' : diffuse par l'hote, seulement si le fichier a bien ete recu.
      if (m.kind === 'hosted') {
        try { if (!fs.statSync(hostFilePath(room.id)).isFile()) break; } catch (_) { break; }
      }
      const next = {
        kind: m.kind,
        src: String(m.src).slice(0, 2000),
        title: String(m.title || m.src).slice(0, 200),
        sub: m.sub ? String(m.sub).slice(0, 2000) : null,
        size: Number(m.size) || 0, // mode local : sert a reperer les copies differentes
      };
      // Recharger le media deja en place ne doit pas invalider l'etat "pret"
      // des clients : eux ne rechargeraient rien et ne le re-annonceraient pas.
      const changed = !room.media || room.media.kind !== next.kind || room.media.src !== next.src;
      room.media = next;
      room.stalled.clear();
      if (changed) {
        room.duration = 0;
        for (const c of room.clients.values()) {
          c.ready = false;
          c.error = null;
          c.hasFile = next.kind !== 'local' ? true : c.id === client.id;
        }
      }
      setPaused(room, 0);
      room.mode = 'cinema';
      pushState(room);
      system(room, client.name + ' a lance : ' + room.media.title);
      break;
    }
    case 'hasFile': {
      // Mode "fichier local" : le participant a designe sa copie du film.
      client.hasFile = !!msg.on;
      pushPresence(room);
      break;
    }
    case 'share': {
      // Partage d'ecran/onglet : le pilote diffuse ce qu'il voit (utile pour
      // les sites que le proxy ne peut pas afficher, comme anime-sama). La
      // video passe en pair-a-pair (WebRTC) ; le serveur ne fait que relayer
      // les messages de signalisation.
      if (!canDrive(room, client)) {
        sse(client.res, 'toast', { text: 'Seul le pilote peut partager son écran.', tone: 'warn' });
        break;
      }
      if (msg.on) {
        room.sharer = client.id;
        room.media = { kind: 'screen', src: String(Date.now()), title: 'Partage de ' + client.name, size: 0 };
        setPaused(room, 0);
        room.mode = 'cinema';
        pushState(room);
        system(room, client.name + ' partage son écran. Lance le direct chez tout le monde.');
      } else if (room.sharer === client.id) {
        room.sharer = null;
        if (room.media && room.media.kind === 'screen') { room.media = null; setPaused(room, 0); }
        pushState(room);
        system(room, client.name + ' a arrêté le partage d\'écran.');
      }
      break;
    }
    case 'rtc': {
      // Relais de signalisation WebRTC vers un participant precis (offre,
      // reponse, candidats ICE). Contenu opaque pour le serveur.
      const to = room.clients.get(String(msg.to || ''));
      if (to) sse(to.res, 'rtc', { from: client.id, name: client.name, data: msg.data });
      break;
    }
    case 'clearMedia': {
      room.media = null;
      room.duration = 0;
      room.pendingPlay = false;
      room.stalled.clear();
      if (room.stream && room.stream.by === client.id) endStream(room);
      for (const c of room.clients.values()) {
        c.ready = false;
        c.error = null;
        c.hasFile = false;
      }
      setPaused(room, 0);
      pushState(room);
      system(room, client.name + ' a ferme la video.');
      break;
    }
    case 'provideFile': {
      // L'hote met a disposition un fichier de son appareil, diffuse en direct
      // tranche par tranche. Aucune limite de taille, rien n'est stocke.
      const name = String(msg.name || 'video').slice(0, 200);
      const size = Number(msg.size) || 0;
      if (!size) break;
      const ext = path.extname(name).toLowerCase();
      const mime = MIME[ext] || 'video/mp4';
      const token = String(Date.now());
      room.stream = { by: client.id, name, size, mime, token };
      room.media = { kind: 'stream', src: token, title: name, size };
      room.duration = 0;
      room.stalled.clear();
      for (const c of room.clients.values()) { c.ready = false; c.error = null; c.hasFile = true; }
      setPaused(room, 0);
      room.mode = 'cinema';
      pushState(room);
      system(room, client.name + ' diffuse ' + name + ' en direct depuis son appareil.');
      break;
    }
    case 'ready': {
      const was = client.ready;
      client.ready = !!msg.ready;
      client.buffered = Number(msg.buffered) || 0;
      noteDuration(room, msg.duration);
      // Echec de lecture (lien mort, format inconnu) : on le retient tant que
      // le participant n'est pas redevenu pret, et on le dit une fois a tous -
      // sinon la salle reste sur "on attend X" sans que personne sache pourquoi.
      if (client.ready) {
        client.error = null;
      } else if (msg.error) {
        const err = String(msg.error).slice(0, 120);
        if (client.error !== err) system(room, client.name + ' ne peut pas lire cette video : ' + err);
        client.error = err;
      }
      if (client.ready && !was) {
        room.stalled.delete(client.id);
        if (room.pendingPlay && everyoneReady(room)) {
          room.pendingPlay = false;
          setPlaying(room, room.play.position);
          pushState(room);
          system(room, 'Tout le monde est pret - lecture !');
          break;
        }
      }
      pushPresence(room);
      break;
    }
    case 'stall': {
      // Quelqu'un bufferise : on gele tout le monde a sa position.
      if (!room.waitForAll || !room.play.playing) {
        client.ready = false;
        pushPresence(room);
        break;
      }
      client.ready = false;
      room.stalled.add(client.id);
      const reported = Number(msg.position);
      const pos = Math.min(positionAt(room, Date.now()), Number.isFinite(reported) ? reported : Infinity);
      setPaused(room, pos);
      room.pendingPlay = true;
      room.pendingSince = Date.now();
      pushState(room);
      broadcast(room, 'toast', { text: client.name + ' charge, on attend...', tone: 'wait' });
      break;
    }
    case 'stat': {
      client.drift = Number(msg.drift) || 0;
      client.rtt = Number(msg.rtt) || 0;
      client.buffered = Number(msg.buffered) || 0;
      noteDuration(room, msg.duration);
      pushPresence(room);
      break;
    }
    case 'waitForAll': {
      room.waitForAll = !!msg.on;
      pushState(room);
      system(room, room.waitForAll ? 'Attente collective activee.' : 'Attente collective desactivee.');
      break;
    }
    case 'resync': {
      broadcast(room, 'toast', { text: client.name + ' a demande une resynchro.', tone: 'info' });
      pushState(room);
      break;
    }

    // --- salle --------------------------------------------------------
    case 'mode': {
      room.mode = msg.mode === 'web' ? 'web' : 'cinema';
      pushState(room);
      break;
    }
    case 'countdown': {
      // Top depart synchronise : pour regarder ensemble sur un site que le
      // proxy ne peut pas piloter (chacun a ouvert l'episode dans son navigateur).
      // On fixe un instant commun sur l'horloge partagee ; tout le monde lance
      // la lecture au meme moment.
      if (!canDrive(room, client)) {
        sse(client.res, 'toast', { text: 'Seul le pilote peut lancer le top départ.', tone: 'warn' });
        break;
      }
      const secs = Math.min(10, Math.max(2, Number(msg.seconds) || 3));
      const at = Date.now() + secs * 1000;
      broadcast(room, 'countdown', { at, by: client.name, label: String(msg.label || '').slice(0, 80) });
      break;
    }
    case 'openTab': {
      // Ouvrir chez tout le monde : pour les sites qu'un proxy ne peut pas
      // servir (anti-robot, connexion...). Chaque participant ouvre le site
      // dans son propre navigateur ; la seance reste horloge et chat.
      if (!canDrive(room, client)) {
        sse(client.res, 'toast', { text: 'Seul le pilote peut proposer un site.', tone: 'warn' });
        break;
      }
      const u = normalizeUrl(msg.url);
      if (!u) break;
      broadcast(room, 'openTab', { url: u, by: client.name }, client.id);
      system(room, client.name + ' propose d\'ouvrir ' + u + ' dans ton navigateur.');
      break;
    }
    case 'host': {
      // Sans cible : on prend la main. Avec cible : on la donne.
      const target = msg.target && room.clients.get(msg.target);
      const next = target || client;
      if (room.host === next.id) break;
      room.host = next.id;
      pushState(room);
      system(
        room,
        target && target.id !== client.id
          ? client.name + ' passe le pilotage a ' + target.name + '.'
          : client.name + ' prend le pilotage.'
      );
      break;
    }
    case 'rename': {
      const old = client.name;
      client.name = String(msg.name || '').trim().slice(0, 24) || old;
      pushPresence(room);
      if (client.name !== old) system(room, old + ' s\'appelle maintenant ' + client.name + '.');
      break;
    }
    case 'chat': {
      const text = String(msg.text || '').trim().slice(0, 500);
      if (!text) break;
      const m = { id: client.id, name: client.name, color: client.color, text, ts: Date.now() };
      room.chat.push(m);
      if (room.chat.length > 300) room.chat.shift();
      broadcast(room, 'chat', m);
      break;
    }
    case 'reaction': {
      broadcast(room, 'reaction', { emoji: String(msg.emoji || '').slice(0, 8), color: client.color, name: client.name });
      break;
    }

    // --- navigation partagee (mode web) --------------------------------
    case 'navigate': {
      if (!canDrive(room, client)) {
        sse(client.res, 'toast', { text: 'Seul le pilote peut naviguer.', tone: 'warn' });
        break;
      }
      const url = normalizeUrl(msg.url);
      if (!url) break;
      const w = room.web;
      if (w.history[w.index] !== url) {
        w.history = w.history.slice(0, w.index + 1);
        w.history.push(url);
        if (w.history.length > 120) w.history.shift();
        w.index = w.history.length - 1;
      }
      w.nonce++;
      w.scroll = { x: 0, y: 0 };
      room.mode = 'web';
      pushState(room);
      break;
    }
    case 'back':
    case 'forward': {
      if (!canDrive(room, client)) break;
      const w = room.web;
      const next = msg.type === 'back' ? w.index - 1 : w.index + 1;
      if (next < 0 || next >= w.history.length) break;
      w.index = next;
      w.nonce++;
      w.scroll = { x: 0, y: 0 };
      pushState(room);
      break;
    }
    case 'reload': {
      if (!canDrive(room, client)) break;
      room.web.nonce++;
      pushState(room);
      break;
    }
    case 'freeBrowsing': {
      room.web.free = !!msg.on;
      pushState(room);
      break;
    }
    case 'scroll': {
      if (room.host !== client.id) break;
      room.web.scroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
      broadcast(room, 'scroll', { x: room.web.scroll.x, y: room.web.scroll.y }, client.id);
      break;
    }
    case 'cursor': {
      broadcast(
        room,
        'cursor',
        { id: client.id, name: client.name, color: client.color, x: Number(msg.x) || 0, y: Number(msg.y) || 0 },
        client.id
      );
      break;
    }
    case 'ping':
      break;
    default:
      break;
  }
}

// -------------------------------------------------------------- utilitaires ---

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeRoom(s) {
  return (String(s || 'salon').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)) || 'salon';
}

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^(javascript|data|file|about|blob):/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(s);
    const host = /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s);
    if (local) s = 'http://' + s;
    else if (host) s = 'https://' + s;
    else return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch (_) {
    return null;
  }
}

function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(''));
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --------------------------------------------------------------- mediatheque ---

function listMedia(dir, base, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) {
      if (depth > 0) listMedia(full, rel, depth - 1, out);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) continue;
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch (_) {}
    // sous-titre a cote du fichier ?
    let sub = null;
    for (const se of SUB_EXT) {
      const cand = full.slice(0, full.length - ext.length) + se;
      if (fs.existsSync(cand)) {
        sub = rel.slice(0, rel.length - ext.length) + se;
        break;
      }
    }
    out.push({
      path: rel,
      name: e.name,
      size,
      sub,
      audio: AUDIO_EXT.has(ext),
      playable: ext !== '.mkv' && ext !== '.mov',
    });
  }
  return out;
}

function safeMediaPath(rel) {
  const p = path.resolve(MEDIA_DIR, path.normalize(String(rel || '')).replace(/^([/\\])+/, ''));
  if (p !== MEDIA_DIR && !p.startsWith(MEDIA_DIR + path.sep)) return null;
  return p;
}

function serveMediaFile(req, res, rel) {
  const file = safeMediaPath(rel);
  if (!file) return json(res, 400, { error: 'chemin invalide' });
  return serveFileRange(req, res, file);
}

/** Sert n'importe quel fichier avec support des requetes Range (necessaire
 *  pour que la video se positionne sans tout retelecharger). Reutilise pour
 *  la mediatheque locale et pour le film televerse par l'hote. */
function serveFileRange(req, res, file, typeOverride) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return json(res, 404, { error: 'fichier introuvable' });
  }
  if (!stat.isFile()) return json(res, 404, { error: 'fichier introuvable' });

  const type = typeOverride || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.end());
      return stream.pipe(res);
    }
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.end());
  stream.pipe(res);
}

function srtToVtt(text) {
  const body = text
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body;
}

function sendVtt(res, text, isSrt) {
  const buf = Buffer.from(isSrt ? srtToVtt(text) : text, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/vtt; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

/** Sous-titre distant : relaye et converti, ce qui evite les blocages CORS. */
function serveRemoteSubtitle(res, rawUrl) {
  const target = normalizeUrl(rawUrl);
  if (!target) return json(res, 400, { error: 'URL invalide' });
  fetchUpstream(target, 0, (err, out) => {
    if (err) return json(res, 502, { error: err.message });
    decodeBody(out.up, (e2, buf) => {
      if (e2) return json(res, 502, { error: e2.message });
      if (buf.length > 8 * 1024 * 1024) return json(res, 413, { error: 'sous-titre trop volumineux' });
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      } catch (_) {
        text = buf.toString('utf8');
      }
      const isSrt = /\.srt(\?|$)/i.test(out.finalUrl) || !/^﻿?WEBVTT/.test(text);
      sendVtt(res, text, isSrt);
    });
  });
}

function serveSubtitle(res, rel) {
  const file = safeMediaPath(rel);
  if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'sous-titre introuvable' });
  let text;
  try {
    text = fs.readFileSync(file);
  } catch (_) {
    return json(res, 500, { error: 'lecture impossible' });
  }
  let out;
  try {
    out = new TextDecoder('utf-8', { fatal: false }).decode(text);
  } catch (_) {
    out = text.toString('utf8');
  }
  sendVtt(res, out, path.extname(file).toLowerCase() === '.srt');
}

// ------------------------------------------------------------------- proxy ---

/** Une adresse IP qui ne doit jamais etre atteinte depuis un serveur public :
 *  boucle locale, reseaux prives, lien local (dont les metadonnees cloud). */
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    return low === '::1' || low === '::' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return true;
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] >= 224
  );
}

/** En cloud, on verifie ou pointe un nom avant d'y aller ; en local, tout est
 *  permis (c'est le reseau de l'utilisateur). */
function checkHost(u, cb) {
  if (!CLOUD) return cb(null);
  const host = u.hostname.replace(/^[|]$/g, '');
  if (/^(localhost|.*.local|.*.internal|.*.localhost)$/i.test(host)) return cb(new Error('adresse interne refusee'));
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(new Error('hote introuvable'));
    for (const a of addrs) if (isPrivateIp(a.address)) return cb(new Error('adresse interne refusee'));
    cb(null);
  });
}

/** Debit par salle : quelques dizaines de pages par minute suffisent
 *  largement a une soiree, et bornent ce qu'un abus pourrait relayer. */
const PROXY_RATE = { perMinute: 40, buckets: new Map() };
function proxyAllowed(key) {
  const now = Date.now();
  const b = PROXY_RATE.buckets.get(key) || { t: now, n: 0 };
  if (now - b.t > 60000) { b.t = now; b.n = 0; }
  b.n++;
  PROXY_RATE.buckets.set(key, b);
  return b.n <= PROXY_RATE.perMinute;
}

function fetchUpstream(rawUrl, depth, cb, ctx) {
  ctx = ctx || {};
  if (depth > 6) return cb(new Error('trop de redirections'));
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    return cb(new Error('URL invalide'));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb(new Error('protocole non supporte'));

  checkHost(u, (herr) => {
    if (herr) return cb(herr);
    fetchChecked(u, depth, cb, ctx);
  });
}

// Connexions reutilisees : eviter de refaire la poignee de main TLS a chaque
// page accelere nettement la navigation vers un meme site.
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 24 });
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 24 });

/** Renvoie un corps en gzip si le client l'accepte (la plupart le font),
 *  sinon tel quel. Gros gain sur les pages HTML volumineuses. */
function sendMaybeGzip(req, res, code, headers, body) {
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (accepts && body.length > 512) {
    zlib.gzip(body, (err, gz) => {
      if (err) {
        headers['Content-Length'] = body.length;
        res.writeHead(code, headers);
        return res.end(body);
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = gz.length;
      res.writeHead(code, headers);
      res.end(gz);
    });
    return;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}

function fetchChecked(u, depth, cb, ctx) {
  const lib = u.protocol === 'https:' ? https : http;
  const r = lib.request(
    u,
    {
      method: 'GET',
      headers: browserHeaders(u, ctx),
      agent: u.protocol === 'https:' ? keepAliveHttps : keepAliveHttp,
    },
    (up) => {
      // On memorise les cookies poses par le site (comme un vrai navigateur).
      if (ctx.jarKey) storeCookies(ctx.jarKey, u, up.headers['set-cookie']);
      const code = up.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && up.headers.location) {
        up.resume();
        let next;
        try {
          next = new URL(up.headers.location, u).href;
        } catch (_) {
          return cb(new Error('redirection invalide'));
        }
        // Le referer devient l'origine d'ou l'on vient ; on garde le jar mais
        // pas la Range (elle ne vaut que pour la ressource initiale).
        return fetchUpstream(next, depth + 1, cb, { referer: u.origin + '/', jarKey: ctx.jarKey });
      }
      cb(null, { up, finalUrl: u.href });
    }
  );
  r.on('error', (e) => cb(e));
  r.setTimeout(20000, () => r.destroy(new Error('delai depasse')));
  r.end();
}

const PROXY_MAX_HTML = 6 * 1024 * 1024;

function decodeBody(up, cb) {
  const enc = String(up.headers['content-encoding'] || '').toLowerCase();
  let stream = up;
  if (enc === 'gzip') stream = up.pipe(zlib.createGunzip());
  else if (enc === 'deflate') stream = up.pipe(zlib.createInflate());
  else if (enc === 'br') stream = up.pipe(zlib.createBrotliDecompress());
  const chunks = [];
  let size = 0;
  stream.on('data', (c) => {
    size += c.length;
    if (size > PROXY_MAX_HTML) {
      up.destroy();
      return cb(new Error('page trop volumineuse'));
    }
    chunks.push(c);
  });
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
  stream.on('error', (e) => cb(e));
}

function charsetOf(contentType, buf) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (m) return m[1].toLowerCase();
  const head = buf.slice(0, 2048).toString('latin1');
  const m2 = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (m2) return m2[1].toLowerCase();
  return 'utf-8';
}

function rewriteHtml(html, finalUrl, appOrigin) {
  let baseHref = finalUrl;
  const bm = /<base\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>/i.exec(html);
  if (bm) {
    try {
      baseHref = new URL(bm[1], finalUrl).href;
    } catch (_) {}
  }
  html = html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/<meta[^>]+charset\s*=\s*["']?[\w-]+["']?[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/gi, '');

  const head =
    '<meta charset="utf-8">' +
    '<base href="' + escapeAttr(baseHref) + '">' +
    '<script src="' + escapeAttr(appOrigin) + '/__cobrowse.js" data-app="' + escapeAttr(appOrigin) + '"></script>';

  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m0) => m0 + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m0) => m0 + '<head>' + head + '</head>');
  return head + html;
}

function proxyErrorPage(res, message, url) {
  const body = Buffer.from(
    '<!doctype html><meta charset="utf-8"><style>' +
      'body{margin:0;font:15px/1.6 system-ui,Segoe UI,sans-serif;background:#0b0f17;color:#e2e8f0;' +
      'display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}' +
      'div{max-width:520px;padding:32px}code{color:#94a3b8;word-break:break-all}' +
      'h1{font-size:19px;margin:0 0 10px}</style>' +
      '<div><h1>Page indisponible</h1><p>' +
      escapeAttr(message) +
      '</p><p><code>' +
      escapeAttr(url || '') +
      '</code></p></div>',
    'utf8'
  );
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

/** Ecran affiche quand un site refuse le proxy (mur anti-robot, connexion
 *  exigee...). Plutot que la page rouge brute du service de protection, on
 *  explique et on propose d'ouvrir le site dans son propre onglet - ou la
 *  seance sert alors d'horloge et de chat. */
function proxyBlockedPage(res, finalUrl, reason) {
  const safe = escapeAttr(finalUrl);
  const body = Buffer.from(
    '<!doctype html><meta charset="utf-8"><style>' +
      'body{margin:0;font:15px/1.6 system-ui,Segoe UI,sans-serif;background:#0b0f17;color:#e2e8f0;' +
      'display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}' +
      '.card{max-width:540px;padding:40px 32px}h1{font-size:20px;margin:0 0 6px}' +
      '.sub{color:#94a3b8;font-size:13px;margin:0 0 22px}code{color:#94a3b8;word-break:break-all;font-size:12px}' +
      'a.btn{display:inline-block;margin:6px 0 18px;padding:11px 20px;border-radius:10px;background:#f97316;' +
      'color:#0b0f17;font-weight:600;text-decoration:none}p.tip{color:#94a3b8;font-size:13px}' +
      '</style><div class="card">' +
      '<div style="font-size:34px;margin-bottom:10px">🛡️</div>' +
      '<h1>Ce site refuse la navigation partagée</h1>' +
      '<p class="sub">' + escapeAttr(reason) + '</p>' +
      '<a class="btn" href="' + safe + '" target="_blank" rel="noopener noreferrer">Ouvrir dans mon onglet ↗</a>' +
      '<div><button id="all" style="margin:0 0 16px;padding:9px 18px;border-radius:10px;border:1px solid rgba(249,115,22,.5);' +
      'background:transparent;color:#f8b26a;font-weight:600;cursor:pointer">Ouvrir chez tout le monde</button></div>' +
      '<p class="tip">Chacun l’ouvre de son côté : la séance reste votre horloge commune et votre chat.</p>' +
      '<p><code>' + safe + '</code></p>' +
      '</div>' +
      '<script>document.getElementById("all").onclick=function(){' +
      'try{parent.postMessage({__cbaction:"openAll",url:' + JSON.stringify(finalUrl) + '},"*");}catch(e){}' +
      'this.textContent="Proposé ✓";this.disabled=true;};<\/script>',
    'utf8'
  );
  // 200 : c'est une page valide dans l'iframe, pas une erreur du proxy.
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Un site nous bloque-t-il activement ? Signatures des murs anti-robot les
 *  plus courants (Cloudflare, etc.) et des refus d'acces. */
function detectBlock(up, buf) {
  const code = up.statusCode || 0;
  const server = String(up.headers['server'] || '').toLowerCase();
  const cfMitigated = up.headers['cf-mitigated'] === 'challenge';
  if (cfMitigated) return 'Protection anti-robot (Cloudflare) : elle exige un test que seul un vrai navigateur peut passer.';
  if (code === 403 || code === 429 || code === 503) {
    const head = buf ? buf.slice(0, 4000).toString('latin1').toLowerCase() : '';
    if (
      server.includes('cloudflare') ||
      /just a moment|attention required|cf-ray|challenge-platform|enable javascript and cookies|checking your browser/.test(head)
    ) {
      return 'Protection anti-robot : ce site bloque les accès qui ne viennent pas d’un navigateur classique.';
    }
    if (code === 403) return 'Accès refusé (403) : ce site n’autorise pas ce type d’accès.';
    if (code === 429) return 'Trop de requêtes (429) : ce site nous limite temporairement.';
    if (code === 503) return 'Service indisponible (503) : ce site est protégé ou surchargé.';
  }
  return null;
}

function handleProxy(req, res, url, appOrigin) {
  const target = normalizeUrl(url.searchParams.get('url'));
  if (!target) return proxyErrorPage(res, 'URL invalide.', url.searchParams.get('url'));

  // Contexte de la requete sortante : Range (streaming/seek) et porte-cookies
  // cloisonne par participant (le 'who' en cloud, sinon un jar local unique).
  let tu; try { tu = new URL(target); } catch (_) {}
  const ctx = {
    range: req.headers.range || null,
    jarKey: tu ? jarKeyFor(url.searchParams.get('who'), tu) : null,
  };

  fetchUpstream(target, 0, onUpstream, ctx);
  function onUpstream(err, out) {
    if (err) return proxyErrorPage(res, 'Echec du chargement : ' + err.message, target);
    const { up, finalUrl } = out;
    const ct = String(up.headers['content-type'] || '');
    const isHtml = /text\/html|application\/xhtml/i.test(ct) || !ct;

    // Blocage detectable avant meme de lire le corps (ex. Cloudflare challenge).
    // (Range/cookies transmis via ctx ci-dessus.)
    const earlyBlock = detectBlock(up, null);
    if (earlyBlock && !isHtml) {
      up.resume();
      return proxyBlockedPage(res, finalUrl, earlyBlock);
    }

    const headers = {
      'Cache-Control': 'no-store',
      'X-Cobrowse-Url': encodeURI(finalUrl),
    };

    if (!isHtml) {
      // Ressource brute : on relaie tel quel en retirant les en-tetes bloquants.
      for (const [k, v] of Object.entries(up.headers)) {
        const key = k.toLowerCase();
        if (
          key === 'content-security-policy' ||
          key === 'content-security-policy-report-only' ||
          key === 'x-frame-options' ||
          key === 'set-cookie' ||
          key.startsWith('cross-origin-')
        )
          continue;
        headers[k] = v;
      }
      res.writeHead(up.statusCode || 200, headers);
      return up.pipe(res);
    }

    decodeBody(up, (e2, buf) => {
      if (e2) return proxyErrorPage(res, 'Reponse illisible : ' + e2.message, finalUrl);
      // Mur anti-robot renvoye en HTML : on montre l'ecran clair, pas la page brute.
      const blocked = detectBlock(up, buf);
      if (blocked) return proxyBlockedPage(res, finalUrl, blocked);
      let text;
      try {
        text = new TextDecoder(charsetOf(ct, buf), { fatal: false }).decode(buf);
      } catch (_) {
        text = buf.toString('utf8');
      }
      const body = Buffer.from(rewriteHtml(text, finalUrl, appOrigin), 'utf8');
      headers['Content-Type'] = 'text/html; charset=utf-8';
      // On renvoie la page recompressee : elle traverse le reseau bien plus
      // vite qu'en clair (une page peut passer de 1 Mo a ~150 Ko).
      sendMaybeGzip(req, res, up.statusCode || 200, headers, body);
    });
  }
}

// ------------------------------------------------------------------ static ---

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('interdit');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('introuvable');
      return;
    }
    // Le script de service worker fait exception : servi avec `no-store`, son
    // enregistrement echoue ("unknown error occurred when fetching the
    // script"). Il lui faut un cache revalidable.
    const isWorker = /(^|[/\\])sw\.js$/i.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      // Ailleurs, no-store et pas no-cache : sans validateur (ETag /
      // Last-Modified), certains navigateurs ressortent quand meme la version
      // en cache et on debogue une interface qui n'est plus celle du disque.
      'Cache-Control': isWorker ? 'no-cache, max-age=0' : 'no-store, must-revalidate',
      ...(isWorker ? { 'Service-Worker-Allowed': '/' } : { Pragma: 'no-cache', Expires: '0' }),
    });
    res.end(buf);
  });
}

// ------------------------------------------------------------------ serveur ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost:' + PORT));
  const p = url.pathname;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const appOrigin = proto + '://' + (req.headers.host || 'localhost:' + PORT);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    });
    return res.end();
  }

  // --- controle d'acces (avant tout le reste) ---
  // En cloud, c'est le code de seance qui fait office de secret : imposer en
  // plus une cle globale obligerait a partager deux choses au lieu d'une.
  const access = CLOUD ? 'cookie' : checkAccess(req, url);
  if (!access) return denied(res);
  if (access === 'query') {
    // La cle est deposee en cookie puis retiree de l'adresse : elle ne traine
    // plus dans la barre d'URL ni dans l'historique. Le fragment (#salle) est
    // conserve par le navigateur a travers la redirection.
    res.writeHead(302, {
      'Set-Cookie':
        'cbk=' + encodeURIComponent(ACCESS_KEY) +
        '; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly',
      Location: url.pathname === '/' ? '/' : url.pathname + stripKey(url.search),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }

  // --- synchronisation d'horloge (le plus court chemin possible) ---
  if (p === '/time') {
    return json(res, 200, { t: Date.now() });
  }

  if (p === '/events') {
    const roomId = sanitizeRoom(url.searchParams.get('room'));
    const name = (url.searchParams.get('name') || 'Invite').trim().slice(0, 24) || 'Invite';

    // En cloud on ne cree pas de salle a la volee : une faute de frappe dans
    // le code doit dire "seance inconnue", pas ouvrir une salle vide dans
    // laquelle on attendrait ses amis pour rien.
    if (CLOUD && !rooms.has(roomId)) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      sse(res, 'nosession', { code: roomId });
      return res.end();
    }
    const room = getRoom(roomId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': ok\n\n');

    // Identite stable : le navigateur renvoie le meme `cid` a chaque
    // reconnexion (coupure reseau, mise en veille, rechargement). Sans cela
    // chaque reprise creait un participant fantome, remettait les compteurs a
    // zero et polluait le chat de "X a rejoint la salle".
    const cid = String(url.searchParams.get('cid') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    let client = null;
    if (cid) {
      for (const c of room.clients.values()) {
        if (c.cid === cid) {
          client = c;
          break;
        }
      }
    }

    const rejoining = !client;
    if (client) {
      // On remplace le flux : l'ancien sera ferme, son handler de fermeture
      // verra que `client.res` a change et ne supprimera pas le participant.
      const old = client.res;
      client.res = res;
      client.name = name;
      try {
        old.end();
      } catch (_) {}
    } else {
      client = {
        id: randomId(),
        cid: cid || randomId(),
        name,
        color: pickColor(room),
        res,
        ready: false,
        error: null,
        drift: 0,
        rtt: 0,
        buffered: 0,
        hasFile: false,
      };
      room.clients.set(client.id, client);
    }
    if (!room.host || !room.clients.has(room.host)) room.host = client.id;

    sse(res, 'welcome', { you: publicClient(client), state: snapshot(room) });
    broadcast(room, 'state', snapshot(room), client.id);
    if (rejoining) system(room, name + ' a rejoint la salle.');

    req.on('close', () => {
      // Flux deja remplace par une reconnexion : rien a nettoyer.
      if (client.res !== res) return;
      room.clients.delete(client.id);
      room.stalled.delete(client.id);
      // La source d'une diffusion en direct s'en va : on coupe proprement et on
      // previent, plutot que de laisser les autres tourner dans le vide.
      if (room.stream && room.stream.by === client.id) {
        endStream(room);
        pushState(room);
        system(room, name + ' a quitté : la diffusion en direct est arrêtée.');
      }
      if (room.sharer === client.id) {
        room.sharer = null;
        if (room.media && room.media.kind === 'screen') { room.media = null; setPaused(room, 0); }
        pushState(room);
        system(room, name + ' a quitté : le partage d\'écran est arrêté.');
      }
      if (room.clients.size === 0) {
        // En cloud, une seance vide survit plus longtemps : le code doit
        // rester valable si tout le monde se deconnecte un moment.
        setTimeout(() => {
          if (rooms.get(roomId) && rooms.get(roomId).clients.size === 0) {
            rooms.delete(roomId);
            clearHostFile(roomId); // le film televerse part avec la salle
          }
        }, (CLOUD ? 180 : 10) * 60 * 1000);
        return;
      }
      if (room.host === client.id) {
        room.host = room.clients.keys().next().value;
        system(room, 'Le pilote a quitte, ' + (room.clients.get(room.host) || {}).name + ' reprend la main.');
      }
      system(room, client.name + ' a quitte la salle.');
      pushState(room);
    });
    return;
  }

  if (p === '/send' && req.method === 'POST') {
    return readBody(req, 64 * 1024, (body) => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (_) {
        return json(res, 400, { error: 'json invalide' });
      }
      const room = rooms.get(sanitizeRoom(msg.room));
      const client = room && room.clients.get(msg.clientId);
      if (!room || !client) return json(res, 409, { error: 'session inconnue' });
      try {
        handleEvent(room, client, msg);
      } catch (e) {
        console.error('[evenement]', e.message);
      }
      return json(res, 200, { ok: true, t: Date.now() });
    });
  }

  // Ce que cette instance sait faire : le client adapte son interface.
  if (p === '/config') {
    return json(res, 200, {
      cloud: CLOUD,
      canProxy: WEB_PROXY,
      canHostFiles: !CLOUD,
      // Diffusion du film depuis l'appareil de l'hote (les autres n'ont rien
      // a fournir). En local c'est inutile (la mediatheque le fait deja).
      canHostUpload: CLOUD && HOST_UPLOAD,
      hostUploadMaxMb: Math.round(HOST_UPLOAD_MAX / 1024 / 1024),
      // Diffusion en direct depuis l'appareil de l'hote : aucune limite de
      // taille, rien n'est stocke (l'hote garde l'onglet ouvert).
      canHostStream: CLOUD,
    });
  }

  // L'hote televerse son film : stocke dans un fichier temporaire de la salle,
  // puis diffuse a tous via /host-file avec support des Range.
  if (p === '/host-upload' && req.method === 'POST') {
    if (!(CLOUD && HOST_UPLOAD)) return json(res, 403, { error: 'diffusion desactivee' });
    const roomId = sanitizeRoom(url.searchParams.get('room'));
    const who = String(url.searchParams.get('who') || '');
    const room = rooms.get(roomId);
    if (!room || !who || !room.clients.has(who)) return json(res, 403, { error: 'hors seance' });
    const declared = Number(url.searchParams.get('size') || 0);
    if (declared && declared > HOST_UPLOAD_MAX) {
      return json(res, 413, { error: 'fichier trop volumineux', maxMb: Math.round(HOST_UPLOAD_MAX / 1024 / 1024) });
    }
    const dest = hostFilePath(roomId);
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let received = 0;
    let aborted = false;
    req.on('data', (c) => {
      received += c.length;
      if (received > HOST_UPLOAD_MAX && !aborted) {
        aborted = true;
        out.destroy();
        try { fs.unlinkSync(tmp); } catch (_) {}
        req.destroy();
        json(res, 413, { error: 'fichier trop volumineux', maxMb: Math.round(HOST_UPLOAD_MAX / 1024 / 1024) });
      }
    });
    req.pipe(out);
    out.on('error', () => { if (!aborted) json(res, 500, { error: 'ecriture impossible' }); });
    out.on('finish', () => {
      if (aborted) return;
      try { fs.renameSync(tmp, dest); } catch (_) { return json(res, 500, { error: 'finalisation impossible' }); }
      // Type MIME deduit du nom d'origine, pour que le lecteur accepte la video.
      const ext = path.extname(String(url.searchParams.get('name') || '')).toLowerCase();
      const type = MIME[ext] || 'video/mp4';
      try { fs.writeFileSync(hostTypePath(roomId), type); } catch (_) {}
      json(res, 200, { ok: true, size: received });
    });
    return;
  }

  // Diffusion du film televerse par l'hote de la salle.
  if (p === '/host-file') {
    const roomId = sanitizeRoom(url.searchParams.get('room'));
    return serveFileRange(req, res, hostFilePath(roomId), hostFileType(roomId));
  }

  // Diffusion EN DIRECT : le lecteur d'un participant demande une tranche ; le
  // serveur la reclame a l'hote (source vive) et relaie sa reponse. Rien n'est
  // stocke, aucune limite de taille. Chaque tranche est bornee pour rester
  // "petit a petit".
  if (p === '/host-stream') {
    const room = rooms.get(sanitizeRoom(url.searchParams.get('room')));
    if (!room || !room.stream) return json(res, 404, { error: 'pas de diffusion en direct' });
    const { size, mime } = room.stream;
    const SLICE = 4 * 1024 * 1024; // 4 Mo par tranche relayee
    let start = 0, end = size - 1;
    const rh = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
    if (rh) {
      start = rh[1] ? parseInt(rh[1], 10) : 0;
      end = rh[2] ? parseInt(rh[2], 10) : size - 1;
    }
    if (Number.isNaN(start) || start >= size || start < 0) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + size });
      return res.end();
    }
    end = Math.min(end, size - 1, start + SLICE - 1); // borne la tranche
    const headers = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': end - start + 1,
      'Access-Control-Allow-Origin': '*',
    };
    if (req.method === 'HEAD') { res.writeHead(206, headers); return res.end(); }

    const provider = room.clients.get(room.stream.by);
    if (!provider) { endStream(room); return json(res, 502, { error: 'source indisponible' }); }
    const reqId = 'p' + (++room.pullSeq);
    const timer = setTimeout(() => {
      if (room.pulls.has(reqId)) {
        room.pulls.delete(reqId);
        try { res.writeHead(504, { 'Content-Type': 'text/plain' }); res.end('tranche non fournie a temps'); } catch (_) {}
      }
    }, 25000);
    room.pulls.set(reqId, { res, headers, timer });
    // Si le lecteur abandonne cette requete (seek), on oublie la tranche.
    req.on('close', () => { if (room.pulls.has(reqId)) { clearTimeout(timer); room.pulls.delete(reqId); } });
    sse(provider.res, 'pull', { reqId, start, end });
    return;
  }

  // L'hote renvoie les octets d'une tranche demandee (corps binaire brut).
  if (p === '/host-chunk' && req.method === 'POST') {
    const room = rooms.get(sanitizeRoom(url.searchParams.get('room')));
    const reqId = String(url.searchParams.get('id') || '');
    if (!room) { req.resume(); return json(res, 404, { error: 'salle inconnue' }); }
    const pull = room.pulls.get(reqId);
    if (!pull) { req.resume(); return json(res, 200, { ok: false }); } // demande deja abandonnee
    room.pulls.delete(reqId);
    clearTimeout(pull.timer);
    try {
      pull.res.writeHead(206, pull.headers);
    } catch (_) {
      req.resume();
      return json(res, 200, { ok: false });
    }
    req.pipe(pull.res);
    req.on('end', () => { try { json(res, 200, { ok: true }); } catch (_) {} });
    req.on('error', () => { try { pull.res.end(); } catch (_) {} });
    return;
  }

  // Cree une seance avec un code non devinable (mode cloud).
  if (p === '/session' && req.method === 'POST') {
    let code;
    do {
      code = crypto.randomBytes(6).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6);
    } while (code.length < 6 || rooms.has(code));
    getRoom(code);
    return json(res, 200, { code: code });
  }

  // Le code existe-t-il ? Evite de creer une salle vide sur une faute de frappe.
  if (p === '/session/check') {
    const code = sanitizeRoom(url.searchParams.get('code'));
    return json(res, 200, { exists: rooms.has(code), code: code });
  }

  if (p === '/net') {
    return json(res, 200, {
      addresses: localAddresses(),
      port: PORT,
      key: ACCESS_KEY,
      public: publicUrl(),
    });
  }

  if (p === '/media/list') {
    if (CLOUD) return json(res, 200, { dir: null, items: [], disabled: true });
    const items = listMedia(MEDIA_DIR, '', 3, []);
    items.sort((a, b) => a.path.localeCompare(b.path, 'fr'));
    return json(res, 200, { dir: MEDIA_DIR, items });
  }
  if (p === '/media/file') {
    if (CLOUD) return json(res, 404, { error: 'pas de mediatheque en mode cloud' });
    return serveMediaFile(req, res, url.searchParams.get('p'));
  }
  if (p === '/media/sub') {
    const remote = url.searchParams.get('url');
    if (remote) return serveRemoteSubtitle(res, remote);
    return serveSubtitle(res, url.searchParams.get('p'));
  }

  // En local le proxy est libre (cle d'acces deja verifiee). Sur le serveur
  // heberge, il faut etre dans une seance en cours : sans cela, ce serait un
  // relais anonyme utilisable par n'importe qui.
  if (p === '/proxy') {
    if (!WEB_PROXY) return proxyErrorPage(res, 'La navigation partagée est désactivée sur ce serveur.', '');
    if (CLOUD) {
      const room = rooms.get(sanitizeRoom(url.searchParams.get('room')));
      const who = String(url.searchParams.get('who') || '');
      if (!room || !who || !room.clients.has(who)) {
        return proxyErrorPage(res, 'Il faut être dans une séance pour naviguer.', '');
      }
      if (!proxyAllowed(room.id)) {
        return proxyErrorPage(res, 'Trop de pages en une minute pour cette séance, réessaie dans un instant.', '');
      }
    }
    return handleProxy(req, res, url, appOrigin);
  }

  if (p === '/__cobrowse.js') {
    return fs.readFile(path.join(PUBLIC_DIR, 'inject.js'), (err, buf) => {
      if (err) {
        res.writeHead(404).end('');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  }

  if (p === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  return serveStatic(res, p);
});

// battement de coeur SSE (evite les coupures des proxies / du navigateur)
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.clients.values()) {
      try {
        c.res.write(': hb\n\n');
      } catch (_) {}
    }
  }
}, 20000);

// Arret propre en fin de video : sans cela la position theorique depasse la
// duree et les lecteurs repartent de zero en boucle.
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.play.playing || !room.duration) continue;
    if (positionAt(room, Date.now()) < room.duration - 0.05) continue;
    setPaused(room, room.duration);
    room.pendingPlay = false;
    pushState(room);
    system(room, 'Fin de la video.');
  }
}, 400);

// Filet de securite : si quelqu'un ne se declare jamais pret (format illisible,
// onglet en veille...), on ne bloque pas la seance indefiniment.
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.pendingPlay) continue;
    const clients = [...room.clients.values()];
    // Ceux qui manquent ont-ils tous echoue (lien mort, format inconnu) ?
    // Alors attendre 15 s n'apporte rien : on sait deja qu'ils ne viendront pas.
    const onlyFailures = clients.every((c) => c.ready || c.error);
    if (!onlyFailures && Date.now() - (room.pendingSince || 0) < 15000) continue;
    // Et si personne ne peut lire, demarrer reviendrait a faire tourner le
    // compteur devant des ecrans noirs : on laisse le voile expliquer le
    // probleme jusqu'a ce que le pilote change de source.
    if (onlyFailures && !clients.some((c) => c.ready)) continue;
    // Exception : en mode "fichier local", quelqu'un qui n'a pas encore
    // designe sa copie ne bufferise pas, il n'a rien a lire. Demarrer sans
    // lui n'aurait aucun sens, on continue d'attendre.
    if (room.media && room.media.kind === 'local') {
      let missing = false;
      for (const c of clients) if (!c.hasFile) missing = true;
      if (missing) continue;
    }
    room.pendingPlay = false;
    setPlaying(room, room.play.position);
    pushState(room);
    const stuck = clients.filter((c) => !c.ready).map((c) => c.name);
    system(
      room,
      onlyFailures
        ? 'La lecture demarre sans ' + stuck.join(', ') + ' (lecture impossible chez eux).'
        : 'Attente trop longue : la lecture repart sans les retardataires.'
    );
  }
}, 2000);

function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

try {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
} catch (_) {}

server.listen(PORT, () => {
  const q = '/?k=' + ACCESS_KEY;
  const lines = [
    '',
    '  Navigateur synchronise - seance ouverte',
    '  ---------------------------------------',
    '  Local    : http://localhost:' + PORT + q,
  ];
  for (const a of localAddresses()) {
    lines.push('  Reseau   : http://' + a + ':' + PORT + q + '   <- a donner aux potes');
  }
  const pub = publicUrl();
  if (pub) lines.push('  Internet : ' + pub.replace(/\/$/, '') + q);
  lines.push('  Videos   : ' + MEDIA_DIR);
  lines.push('  Cle      : ' + ACCESS_KEY + '   (fichier .acces, supprime-le pour en generer une autre)');
  lines.push('');
  console.log(lines.join('\n'));

  // Le raccourci du Bureau passe --ouvrir : le serveur connait sa cle, il est
  // donc le mieux place pour ouvrir la bonne adresse du premier coup.
  if (argv.includes('--ouvrir')) {
    const target = 'http://localhost:' + PORT + '/?k=' + ACCESS_KEY;
    const { spawn } = require('child_process');
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
      } else {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (_) {}
  }

  // Anti-mise en veille : sur un hebergement gratuit, le service s'endort apres
  // ~15 min sans visite et la premiere ouverture suivante attend ~30 s. En se
  // pingeant lui-meme toutes les 10 min via son URL publique (le trafic sortant
  // revient en entrant, ce qui compte comme une visite), il reste chaud et se
  // charge tout de suite. RENDER_EXTERNAL_URL est fourni par Render.
  const self = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_WARM_URL;
  if (CLOUD && self) {
    const base = self.replace(/\/$/, '');
    setInterval(() => {
      try { https.get(base + '/config', (r) => r.resume()).on('error', () => {}); } catch (_) {}
    }, 10 * 60 * 1000);
    console.log('  Anti-veille actif : ping ' + base + '/config toutes les 10 min');
  }
});
