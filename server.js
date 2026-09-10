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
 *    chat. Aucun disque a servir, aucun proxy web - ce serait un relais ouvert
 *    sur Internet. Chacun lit sa propre copie du film, et le code de seance
 *    tient lieu de secret. Personne n'a besoin d'etre "l'hote".
 */
const CLOUD = !!(process.env.CLOUD || process.env.RENDER);

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
      if (!m.src || !['file', 'url', 'youtube', 'local'].includes(m.kind)) break;
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
    case 'clearMedia': {
      room.media = null;
      room.duration = 0;
      room.pendingPlay = false;
      room.stalled.clear();
      for (const c of room.clients.values()) {
        c.ready = false;
        c.hasFile = false;
      }
      setPaused(room, 0);
      pushState(room);
      system(room, client.name + ' a ferme la video.');
      break;
    }
    case 'ready': {
      const was = client.ready;
      client.ready = !!msg.ready;
      client.buffered = Number(msg.buffered) || 0;
      noteDuration(room, msg.duration);
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
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return json(res, 404, { error: 'fichier introuvable' });
  }
  if (!stat.isFile()) return json(res, 404, { error: 'fichier introuvable' });

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
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

function fetchUpstream(rawUrl, depth, cb) {
  if (depth > 6) return cb(new Error('trop de redirections'));
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    return cb(new Error('URL invalide'));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb(new Error('protocole non supporte'));

  const lib = u.protocol === 'https:' ? https : http;
  const r = lib.request(
    u,
    {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    },
    (up) => {
      const code = up.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && up.headers.location) {
        up.resume();
        let next;
        try {
          next = new URL(up.headers.location, u).href;
        } catch (_) {
          return cb(new Error('redirection invalide'));
        }
        return fetchUpstream(next, depth + 1, cb);
      }
      cb(null, { up, finalUrl: u.href });
    }
  );
  r.on('error', (e) => cb(e));
  r.setTimeout(20000, () => r.destroy(new Error('delai depasse')));
  r.end();
}

function decodeBody(up, cb) {
  const enc = String(up.headers['content-encoding'] || '').toLowerCase();
  let stream = up;
  if (enc === 'gzip') stream = up.pipe(zlib.createGunzip());
  else if (enc === 'deflate') stream = up.pipe(zlib.createInflate());
  else if (enc === 'br') stream = up.pipe(zlib.createBrotliDecompress());
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
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

function handleProxy(req, res, url, appOrigin) {
  const target = normalizeUrl(url.searchParams.get('url'));
  if (!target) return proxyErrorPage(res, 'URL invalide.', url.searchParams.get('url'));

  fetchUpstream(target, 0, (err, out) => {
    if (err) return proxyErrorPage(res, 'Echec du chargement : ' + err.message, target);
    const { up, finalUrl } = out;
    const ct = String(up.headers['content-type'] || '');
    const isHtml = /text\/html|application\/xhtml/i.test(ct) || !ct;

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
      let text;
      try {
        text = new TextDecoder(charsetOf(ct, buf), { fatal: false }).decode(buf);
      } catch (_) {
        text = buf.toString('utf8');
      }
      const body = Buffer.from(rewriteHtml(text, finalUrl, appOrigin), 'utf8');
      headers['Content-Type'] = 'text/html; charset=utf-8';
      headers['Content-Length'] = body.length;
      res.writeHead(up.statusCode || 200, headers);
      res.end(body);
    });
  });
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
  const appOrigin = 'http://' + (req.headers.host || 'localhost:' + PORT);

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
      if (room.clients.size === 0) {
        // En cloud, une seance vide survit plus longtemps : le code doit
        // rester valable si tout le monde se deconnecte un moment.
        setTimeout(() => {
          if (rooms.get(roomId) && rooms.get(roomId).clients.size === 0) rooms.delete(roomId);
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
      canProxy: !CLOUD,
      canHostFiles: !CLOUD,
    });
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

  // Le proxy reste strictement local : sur un hebergement public, il ferait de
  // ce service un relais anonyme utilisable par n'importe qui.
  if (p === '/proxy') {
    if (CLOUD) return proxyErrorPage(res, 'La navigation partagée est désactivée sur le serveur hébergé.', '');
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
    if (Date.now() - (room.pendingSince || 0) < 15000) continue;
    // Exception : en mode "fichier local", quelqu'un qui n'a pas encore
    // designe sa copie ne bufferise pas, il n'a rien a lire. Demarrer sans
    // lui n'aurait aucun sens, on continue d'attendre.
    if (room.media && room.media.kind === 'local') {
      let missing = false;
      for (const c of room.clients.values()) if (!c.hasFile) missing = true;
      if (missing) continue;
    }
    room.pendingPlay = false;
    setPlaying(room, room.play.position);
    pushState(room);
    system(room, 'Attente trop longue : la lecture repart sans les retardataires.');
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
});
