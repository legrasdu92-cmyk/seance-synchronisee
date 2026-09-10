/* Service worker : rend l'application installable et tolerante a une coupure.
   Strategie "reseau d'abord" volontaire - une seance se joue en direct, mieux
   vaut une seconde d'attente qu'une interface perimee. Le cache ne sert que de
   filet quand le reseau ne repond pas. */
var CACHE = 'seance-v1';
var SHELL = ['/', '/style.css', '/app.js', '/sync.js', '/icone.svg', '/icone.png', '/manifest.webmanifest'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Tout ce qui est vivant (flux d'evenements, horloge, medias) ne doit jamais
  // passer par le cache.
  if (/^\/(events|send|time|media|proxy|net|session|config)/.test(url.pathname)) return;

  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('/');
        });
      })
  );
});
