/* Navigateur synchronise - application client. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Clock = window.Sync.Clock;

  var S = {
    room: 'salon',
    name: '',
    cid: null, // identite stable entre deux reconnexions
    clientId: null,
    state: null,
    es: null,
    connecting: false,
    mediaKey: null,
    frameKey: null,
    corrector: null,
    adapter: null,
    yt: null,
    duration: 0,
    seeking: false,
    lastReady: null,
    lastStall: 0,
    stallTimer: null,
    cursors: {},
    volume: 1,
    muted: false,
    localFile: null, // { key, url, name, size } - mode "chacun sa copie"
    unread: 0,
  };

  // ------------------------------------------------------------- outils --

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  function bytes(n) {
    if (!n) return '';
    var u = ['o', 'Ko', 'Mo', 'Go'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
  }

  function toast(text, tone, ms) {
    var el = document.createElement('div');
    el.className = 'toast' + (tone ? ' ' + tone : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function () { el.remove(); }, 320);
    }, ms || 2800);
  }

  function send(msg) {
    if (!S.clientId) return Promise.resolve();
    msg.room = S.room;
    msg.clientId = S.clientId;
    return fetch('/send', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }).catch(function () {});
  }

  /** Conversion SubRip -> WebVTT, la seule que le navigateur ne sait pas faire. */
  function srtToVtt(text) {
    return (
      'WEBVTT\n\n' +
      String(text)
        .replace(/\r\n/g, '\n')
        .replace(/^﻿/, '')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    );
  }

  // ---------------------------------------------------------- connexion --

  function connect() {
    if (S.connecting) return;
    S.connecting = true;
    if (S.es) {
      try { S.es.close(); } catch (e) {}
      S.es = null;
    }

    var url =
      '/events?room=' + encodeURIComponent(S.room) +
      '&name=' + encodeURIComponent(S.name) +
      '&cid=' + encodeURIComponent(S.cid);
    var es = new EventSource(url);
    S.es = es;

    es.addEventListener('welcome', function (e) {
      S.connecting = false;
      $('offline').classList.add('hidden');
      var d = JSON.parse(e.data);
      S.clientId = d.you.id;
      applyState(d.state);
      renderChat(d.state.chat, true);
      // Le serveur ignore notre etat "pret" apres une reprise : on le redit.
      S.lastReady = null;
    });
    es.addEventListener('state', function (e) { applyState(JSON.parse(e.data)); });
    es.addEventListener('presence', function (e) {
      var d = JSON.parse(e.data);
      if (S.state) { S.state.clients = d.clients; S.state.host = d.host; }
      renderPeople();
    });
    es.addEventListener('chat', function (e) { renderMsg(JSON.parse(e.data), true); });
    es.addEventListener('toast', function (e) {
      var d = JSON.parse(e.data);
      toast(d.text, d.tone);
    });
    es.addEventListener('reaction', function (e) { popReaction(JSON.parse(e.data)); });
    es.addEventListener('openTab', function (e) {
      var d = JSON.parse(e.data);
      if (window.__onOpenTab) window.__onOpenTab(d.url, d.by);
    });
    es.addEventListener('pull', function (e) {
      var d = JSON.parse(e.data);
      if (window.__answerPull) window.__answerPull(d.reqId, d.start, d.end);
    });
    es.addEventListener('cursor', function (e) {
      var d = JSON.parse(e.data);
      S.cursors[d.id] = { x: d.x, y: d.y, name: d.name, color: d.color, ts: Date.now() };
    });
    es.addEventListener('scroll', function (e) {
      var d = JSON.parse(e.data);
      postToFrame({ type: 'scrollTo', x: d.x, y: d.y });
    });

    es.addEventListener('nosession', function (e) {
      // Code inconnu : on repasse par l'accueil plutot que d'attendre dans une
      // salle qui n'existe pas.
      try { es.close(); } catch (err) {}
      S.es = null;
      S.connecting = false;
      S.clientId = null;
      $('app').classList.add('hidden');
      $('join').classList.remove('hidden');
      $('offline').classList.add('hidden');
      S.hintLocked = true; // que la calibration d'horloge n'efface pas l'erreur
      $('joinHint').textContent = 'Séance « ' + JSON.parse(e.data).code + ' » inconnue ou expirée.';
      $('joinRoom').select();
      $('joinRoom').focus();
    });

    es.onerror = function () {
      $('offline').classList.remove('hidden');
      if (es.readyState === 2) {
        // Flux definitivement ferme : EventSource ne reprendra pas seul.
        S.connecting = false;
        setTimeout(connect, 1200);
      }
    };
  }

  // ------------------------------------------------------------- l'etat --

  function applyState(st) {
    var first = !S.state;
    S.state = st;

    $('roomName').textContent = st.id;
    document.title = 'Salle ' + st.id + ' · Navigateur synchronisé';
    if (document.activeElement !== $('waitAll')) $('waitAll').checked = !!st.waitForAll;
    if (document.activeElement !== $('freeBrowse')) $('freeBrowse').checked = !!st.web.free;

    setMode(st.mode, true);

    // media
    var key = st.media ? st.media.kind + '|' + st.media.src : null;
    if (key !== S.mediaKey) {
      S.mediaKey = key;
      loadMedia(st.media);
    }

    // lecture
    if (S.corrector) S.corrector.setState(st.play);
    $('btnPlay').textContent = st.play.playing ? '❚❚' : '▶';
    if (document.activeElement !== $('rate')) $('rate').value = String(st.play.rate);
    $('btnCloseMedia').classList.toggle('hidden', !st.media);

    // navigation web
    var w = st.web;
    $('btnWebBack').disabled = !w.canBack;
    $('btnWebFwd').disabled = !w.canForward;
    if (document.activeElement !== $('urlInput')) $('urlInput').value = w.url || '';
    var frameKey = w.url ? w.url + '#' + w.nonce : null;
    if (frameKey !== S.frameKey) {
      S.frameKey = frameKey;
      $('webEmpty').classList.toggle('hidden', !!w.url);
      if (w.url) $('frame').src = proxyOrigin() + '/proxy?url=' + encodeURIComponent(w.url) + '&n=' + w.nonce + proxyAuth();
    }

    renderPeople();
    if (first) renderChat(st.chat, true);
  }

  function setMode(mode, silent) {
    var cinema = mode !== 'web';
    $('cinema').classList.toggle('hidden', !cinema);
    $('web').classList.toggle('hidden', cinema);
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.dataset.mode === (cinema ? 'cinema' : 'web'));
    });
    if (!silent) send({ type: 'mode', mode: cinema ? 'cinema' : 'web' });
  }

  // ------------------------------------------------------------- media ---

  function srcFor(media) {
    if (media.kind === 'file') return '/media/file?p=' + encodeURIComponent(media.src);
    if (media.kind === 'local') return S.localFile ? S.localFile.url : null;
    if (media.kind === 'hosted') return '/host-file?room=' + encodeURIComponent(S.room) + '&v=' + encodeURIComponent(media.src);
    if (media.kind === 'stream') {
      if (S.streamFile && S.streamUrl) return S.streamUrl; // l'hôte : sa copie locale
      return '/host-stream?room=' + encodeURIComponent(S.room) + '&v=' + encodeURIComponent(media.src);
    }
    return media.src;
  }

  function subFor(media) {
    if (!media || !media.sub) return null;
    if (media.kind === 'file') return '/media/sub?p=' + encodeURIComponent(media.sub);
    // Les sous-titres distants passent par le serveur : conversion .srt et
    // contournement des blocages CORS d'un seul coup.
    return '/media/sub?url=' + encodeURIComponent(media.sub);
  }

  function metaFor(media) {
    if (media.kind === 'file') return 'fichier partagé par l’hôte';
    if (media.kind === 'local') return 'chacun sa copie · ' + bytes(media.size);
    if (media.kind === 'hosted') return 'diffusé par l\'hôte · ' + bytes(media.size);
    if (media.kind === 'stream') return 'en direct depuis l\'hôte · ' + bytes(media.size);
    if (media.kind === 'youtube') return 'YouTube';
    return 'lien direct';
  }

  function loadMedia(media) {
    var video = $('video');
    if (S.corrector) S.corrector.stop();
    S.corrector = null;
    S.adapter = null;
    destroyYt();
    S.duration = 0;
    S.lastReady = null;
    $('unmute').classList.add('hidden');
    $('localPick').classList.add('hidden');

    if (!media) {
      video.removeAttribute('src');
      video.load();
      $('emptyState').classList.remove('hidden');
      $('mediaTitle').textContent = '—';
      $('mediaMeta').textContent = '';
      refreshSubs();
      return;
    }

    $('emptyState').classList.add('hidden');
    $('mediaTitle').textContent = media.title;
    $('mediaMeta').textContent = metaFor(media);

    if (media.kind === 'youtube') {
      video.classList.add('hidden');
      video.removeAttribute('src');
      video.load();
      $('ytHolder').classList.remove('hidden');
      createYt(media.src);
      return;
    }

    $('ytHolder').classList.add('hidden');
    video.classList.remove('hidden');

    // Mode "chacun sa copie" : sans fichier designe, on affiche le selecteur
    // et on s'arrete la - il n'y a rien a lire pour l'instant.
    if (media.kind === 'local' && (!S.localFile || S.localFile.key !== media.src)) {
      video.removeAttribute('src');
      video.load();
      $('pickName').textContent = media.title + (media.size ? ' · ' + bytes(media.size) : '');
      $('localPick').classList.remove('hidden');
      send({ type: 'hasFile', on: false });
      return;
    }

    Array.prototype.forEach.call(video.querySelectorAll('track'), function (t) { t.remove(); });
    var src = srcFor(media);
    if (!src) return;
    video.src = src;

    var sub = subFor(media);
    if (sub) addTrack(sub, 'Sous-titres');

    video.load();
    applyVolume();

    S.adapter = new window.Sync.HtmlAdapter(video);
    S.adapter.play = function () { tryPlay(video); };
    S.corrector = new window.Sync.Corrector(S.adapter);
    S.corrector.enabled = $('autoSync').checked;
    if (S.state) S.corrector.setState(S.state.play);
    S.corrector.start();
    if (media.kind === 'local') send({ type: 'hasFile', on: true });
  }

  function tryPlay(video) {
    var p = video.play();
    if (p && p.catch) {
      p.catch(function () {
        // Lecture automatique refusee : on demarre en sourdine pour rester
        // synchrone, et on propose de rendre le son.
        video.muted = true;
        $('unmute').classList.remove('hidden');
        var p2 = video.play();
        if (p2 && p2.catch) p2.catch(function () {});
      });
    }
  }

  // --- mode « chacun sa copie » ----------------------------------------

  function fileKey(file) {
    return file.name + '|' + file.size;
  }

  /** Désigne un fichier local comme étant notre copie du média courant. */
  function useLocalFile(file) {
    var media = S.state && S.state.media;
    if (S.localFile && S.localFile.url) {
      try { URL.revokeObjectURL(S.localFile.url); } catch (e) {}
    }
    S.localFile = { key: fileKey(file), url: URL.createObjectURL(file), name: file.name, size: file.size };

    if (media && media.kind === 'local' && media.src !== S.localFile.key) {
      if (media.size && Math.abs(media.size - file.size) > 1024) {
        toast('Attention : ta copie fait ' + bytes(file.size) + ', celle de la salle ' + bytes(media.size) + '.', 'warn');
      }
      // On accepte quand meme : la synchro reste valable si c'est le meme
      // montage. On aligne la cle pour que le lecteur demarre.
      S.localFile.key = media.src;
    }

    if (media && media.kind === 'local') {
      loadMedia(media);
    } else {
      // Personne n'a encore lance ce film : on le propose a la salle.
      send({
        type: 'media',
        media: { kind: 'local', src: S.localFile.key, title: file.name, size: file.size },
      });
    }
  }

  // --- YouTube ---------------------------------------------------------

  function ytId(input) {
    var s = String(input || '').trim();
    var m = /(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/.exec(s);
    if (m) return m[1];
    if (/^[\w-]{11}$/.test(s)) return s;
    return null;
  }

  function destroyYt() {
    if (S.yt) {
      try { S.yt.destroy(); } catch (e) {}
      S.yt = null;
    }
    var holder = $('ytHolder');
    if (holder && !holder.querySelector('#ytPlayer')) {
      var d = document.createElement('div');
      d.id = 'ytPlayer';
      holder.insertBefore(d, holder.firstChild);
    }
  }

  function createYt(id) {
    function build() {
      destroyYt();
      S.yt = new window.YT.Player('ytPlayer', {
        videoId: id,
        playerVars: {
          controls: 0, disablekb: 1, modestbranding: 1, rel: 0, fs: 0,
          iv_load_policy: 3, playsinline: 1, origin: location.origin,
        },
        events: {
          onReady: function () {
            S.adapter = new window.Sync.YtAdapter(S.yt);
            S.corrector = new window.Sync.Corrector(S.adapter);
            S.corrector.enabled = $('autoSync').checked;
            if (S.state) S.corrector.setState(S.state.play);
            S.corrector.start();
            applyVolume();
            reportReady(true, 10);
          },
          onStateChange: function (e) {
            if (e.data === 3) reportStall();
            else if (e.data === 1 || e.data === 2 || e.data === 5) reportReady(true, 10);
          },
          onError: function () {
            toast('Vidéo YouTube indisponible (privée, supprimée ou non intégrable).', 'warn');
          },
        },
      });
    }
    if (window.YT && window.YT.Player) return build();
    window.onYouTubeIframeAPIReady = build;
    if (!document.getElementById('ytapi')) {
      var s = document.createElement('script');
      s.id = 'ytapi';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  }

  // ------------------------------------------------------- sous-titres ---

  function addTrack(src, label) {
    var video = $('video');
    var tr = document.createElement('track');
    tr.kind = 'subtitles';
    tr.label = label;
    tr.srclang = 'fr';
    tr.src = src;
    tr.addEventListener('load', refreshSubs);
    video.appendChild(tr);
    setTimeout(refreshSubs, 120);
  }

  function refreshSubs() {
    var sel = $('subSel');
    var v = $('video');
    var previous = sel.value;
    sel.innerHTML = '<option value="-1">ST off</option>';
    for (var i = 0; i < v.textTracks.length; i++) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = v.textTracks[i].label || 'Piste ' + (i + 1);
      sel.appendChild(o);
    }
    var keep = sel.querySelector('option[value="' + previous + '"]');
    sel.value = keep ? previous : v.textTracks.length ? '0' : '-1';
    $('subSel').parentNode.classList.toggle('faded', v.textTracks.length === 0);
    applySubs();
  }

  function applySubs() {
    var v = $('video');
    var idx = Number($('subSel').value);
    for (var i = 0; i < v.textTracks.length; i++) {
      v.textTracks[i].mode = i === idx ? 'showing' : 'disabled';
    }
  }

  // -------------------------------------------------- pret / bufferisation --

  function reportReady(ready, buffered, error) {
    // Un echec est toujours transmis, meme si on etait deja "pas pret" : c'est
    // lui qui explique aux autres pourquoi la salle attend.
    if (S.lastReady === ready && !error) return;
    S.lastReady = ready;
    send({
      type: 'ready',
      ready: ready,
      buffered: buffered || 0,
      duration: S.adapter && S.adapter.duration ? S.adapter.duration() : 0,
      error: error || undefined,
    });
  }

  /** Le lecteur local a-t-il de quoi lire tout de suite ? */
  function localReady() {
    if (!S.adapter || !S.adapter.isReady()) return false;
    if (S.yt) {
      try { return S.yt.getPlayerState() !== 3; } catch (e) { return false; }
    }
    return $('video').readyState >= 3;
  }

  /**
   * Un `waiting` se declenche aussi pour un simple repositionnement, qui se
   * resout en quelques dizaines de millisecondes. On confirme avant d'alerter
   * la salle, sinon chaque deplacement dans la barre imposerait a tout le
   * monde une pause inutile.
   */
  function reportStall() {
    if (S.stallTimer) return;
    S.stallTimer = setTimeout(function () {
      S.stallTimer = null;
      if (localReady()) return;
      if (Date.now() - S.lastStall < 1500) return;
      S.lastStall = Date.now();
      S.lastReady = false;
      send({ type: 'stall', position: S.adapter ? S.adapter.getTime() : 0 });
    }, 450);
  }

  // ------------------------------------------------------------- volume --

  function applyVolume() {
    var v = $('video');
    v.muted = S.muted;
    v.volume = S.volume;
    if (S.yt) {
      try {
        S.yt.setVolume(Math.round(S.volume * 100));
        if (S.muted) S.yt.mute(); else S.yt.unMute();
      } catch (e) {}
    }
    $('volume').value = String(S.volume);
    $('btnMute').textContent = S.muted || S.volume === 0 ? '🔇' : S.volume < 0.5 ? '🔉' : '🔊';
    try {
      localStorage.setItem('cb.vol', String(S.volume));
      localStorage.setItem('cb.muted', S.muted ? '1' : '0');
    } catch (e) {}
  }

  // ----------------------------------------------------------- interface --

  function renderPeople() {
    if (!S.state) return;
    var ul = $('people');
    var local = S.state.media && S.state.media.kind === 'local';
    var iAmHost = S.state.host === S.clientId;
    ul.innerHTML = '';

    S.state.clients.forEach(function (c) {
      var li = document.createElement('li');
      li.className = 'person' + (c.id === S.clientId ? ' me' : '');
      var d = Math.abs(c.drift || 0);
      var cls = d < 0.12 ? 'g' : d < 0.5 ? 'w' : 'b';
      var stat;
      if (local && !c.hasFile) stat = '<span class="w">n’a pas encore ouvert son fichier</span>';
      else if (c.error) stat = '<span class="b" title="' + esc(c.error) + '">lecture impossible</span>';
      else if (!c.ready) stat = '<span class="w">chargement…</span>';
      else stat = '<span class="' + cls + '">écart ' + (d * 1000).toFixed(0) + ' ms</span> · ping ' + Math.round(c.rtt || 0) + ' ms';

      li.innerHTML =
        '<div class="avatar" style="background:' + esc(c.color) + '">' +
        esc((c.name[0] || '?').toUpperCase()) + '</div>' +
        '<div class="person-main">' +
        '<div class="person-name"><b>' + esc(c.name) + '</b>' +
        (c.id === S.state.host ? '<span class="badge host">pilote</span>' : '') +
        (c.id === S.clientId ? '<span class="badge">toi</span>' : '') +
        '</div><div class="person-stat">' + stat + '</div></div>';

      if (iAmHost && c.id !== S.clientId) {
        var give = document.createElement('button');
        give.className = 'ghost tiny';
        give.textContent = '⇄';
        give.title = 'Passer le pilotage à ' + c.name;
        give.onclick = function () { send({ type: 'host', target: c.id }); };
        li.appendChild(give);
      }
      ul.appendChild(li);
    });

    $('btnTakeHost').classList.toggle('hidden', iAmHost);
  }

  function renderMsg(m, live) {
    var box = $('chat');
    var div = document.createElement('div');
    if (m.system) {
      div.className = 'msg sys';
      div.textContent = m.text;
    } else {
      div.className = 'msg';
      div.innerHTML = '<b style="color:' + esc(m.color) + '">' + esc(m.name) + '</b> ' + esc(m.text);
    }
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.appendChild(div);
    if (atBottom) box.scrollTop = box.scrollHeight;
    while (box.children.length > 200) box.removeChild(box.firstChild);

    if (live && !m.system && m.id !== S.clientId && $('chatPane').classList.contains('hidden')) {
      S.unread++;
      var u = $('unread');
      u.textContent = String(S.unread);
      u.classList.remove('hidden');
    }
  }

  function renderChat(list, reset) {
    if (reset) $('chat').innerHTML = '';
    (list || []).forEach(function (m) { renderMsg(m, false); });
    $('chat').scrollTop = $('chat').scrollHeight;
  }

  function popReaction(d) {
    var el = document.createElement('div');
    el.className = 'reaction';
    el.style.left = (10 + Math.random() * 78) + '%';
    el.innerHTML = esc(d.emoji) + '<small style="color:' + esc(d.color) + '">' + esc(d.name) + '</small>';
    $('reactions').appendChild(el);
    setTimeout(function () { el.remove(); }, 2700);
  }

  // boucle d'affichage (barre de progression, indicateurs)
  setInterval(function () {
    if (!S.state) return;
    var a = S.adapter;
    var cor = S.corrector;
    var target = cor ? cor.target() : 0;
    var ready = a && a.isReady();
    var cur = ready ? a.getTime() : target;
    var dur = ready ? a.duration() : 0;
    if (dur) S.duration = dur;

    if (!S.seeking) {
      var pct = S.duration ? Math.min(100, (cur / S.duration) * 100) : 0;
      $('seekFill').style.width = pct + '%';
      $('seekKnob').style.left = pct + '%';
      $('curTime').textContent = fmt(cur);
      $('durTime').textContent = fmt(S.duration);
      if (a && a.buffered && S.duration) {
        var b = Math.min(100, ((cur + Math.max(0, a.buffered())) / S.duration) * 100);
        $('seekBuffer').style.width = b + '%';
      }
    }

    // pastille de synchro
    var drift = cor ? Math.abs(cor.drift) : 0;
    var pill = $('syncPill');
    pill.classList.remove('good', 'warn', 'bad');
    if (!Clock.calibrated) {
      $('syncText').textContent = 'synchro…';
    } else {
      pill.classList.add(drift < 0.12 ? 'good' : drift < 0.5 ? 'warn' : 'bad');
      $('syncText').textContent = (drift * 1000).toFixed(0) + ' ms · ping ' + Math.round(Clock.rtt) + ' ms';
    }

    // voile d'attente : uniquement quand la salle cherche vraiment a lire
    var isLocal = S.state.media && S.state.media.kind === 'local';
    var notReady = S.state.clients.filter(function (c) {
      return isLocal && !c.hasFile ? true : !c.ready;
    });
    var picking = !$('localPick').classList.contains('hidden');
    var waiting = !!S.state.media && S.state.pending && notReady.length > 0 && !picking;
    var starting = cor && cor.startsIn() > 120;
    // Echecs de lecture : ceux qu'on attend en vain, ou moi-meme si mon
    // lecteur a echoue (meme si la salle a fini par demarrer sans moi).
    var iPilot = S.state.host === S.clientId;
    var failed = waiting ? notReady.filter(function (c) { return c.error; }) : [];
    if (!failed.length && S.state.media) {
      S.state.clients.forEach(function (c) { if (c.id === S.clientId && c.error) failed = [c]; });
    }
    $('waitOverlay').classList.toggle('hidden', !(waiting || starting || failed.length));
    $('waitOverlay').classList.toggle('failed', failed.length > 0);
    $('waitAction').classList.toggle('hidden', !(failed.length > 0 && iPilot));
    if (failed.length) {
      // Attendre ne sert plus a rien : la video ne se chargera pas chez eux.
      $('waitText').textContent =
        'Lecture impossible chez ' + failed.map(function (c) { return c.id === S.clientId ? 'toi' : c.name; }).join(', ') +
        ' : ' + failed[0].error + '.' + (iPilot ? '' : ' Le pilote peut choisir une autre source.');
    } else if (waiting) {
      $('waitText').textContent = 'On attend ' + notReady.map(function (c) { return c.name; }).join(', ') + '…';
    } else if (starting) {
      $('waitText').textContent = 'Départ dans ' + (cor.startsIn() / 1000).toFixed(1) + ' s';
    }

    // le bouton "activer le son" disparait des que la lecture repart
    if (a && !a.isPaused() && !$('video').muted) $('unmute').classList.add('hidden');

    if (cor) {
      $('diag').innerHTML =
        'horloge : ' + (Clock.offset >= 0 ? '+' : '') + Clock.offset.toFixed(0) + ' ms<br>' +
        'aller-retour : ' + Math.round(Clock.rtt) + ' ms<br>' +
        'écart lecteur : ' + (cor.drift * 1000).toFixed(0) + ' ms<br>' +
        'rattrapages doux : ' + cor.corrections + ' · sauts : ' + cor.jumps;
    }
  }, 120);

  // rapport periodique au serveur
  setInterval(function () {
    if (!S.clientId || !S.corrector || !S.adapter || !S.state) return;

    // Reconciliation : si la vision du serveur ne correspond plus a l'etat
    // reel du lecteur, on le reannonce. Sans ce filet, une salle peut rester
    // bloquee sur "on attend quelqu'un" alors que tout le monde est pret.
    var lr = localReady();
    var mine = null;
    for (var i = 0; i < S.state.clients.length; i++) {
      if (S.state.clients[i].id === S.clientId) mine = S.state.clients[i];
    }
    if (mine && mine.ready !== lr) {
      S.lastReady = null;
      reportReady(lr, S.adapter.buffered ? S.adapter.buffered() : 0);
    }
    if (mine && S.state.media && S.state.media.kind === 'local') {
      var have = !!(S.localFile && S.localFile.key === S.state.media.src);
      if (mine.hasFile !== have) send({ type: 'hasFile', on: have });
    }

    send({
      type: 'stat',
      drift: S.corrector.drift,
      rtt: Clock.rtt,
      buffered: S.adapter.buffered ? S.adapter.buffered() : 0,
      duration: S.adapter.duration ? S.adapter.duration() : 0,
    });
  }, 2000);

  setInterval(function () { Clock.calibrate(5); }, 30000);

  // ------------------------------------------------------- mode web ------

  /** Sur le serveur heberge, le proxy n'accepte que les participants d'une
   *  seance en cours : on lui donne le code et notre identifiant. */
  function proxyAuth() {
    if (!(S.cfg && S.cfg.cloud)) return '';
    return '&room=' + encodeURIComponent(S.room || '') + '&who=' + encodeURIComponent(S.clientId || '');
  }

  function proxyOrigin() {
    var h = location.hostname;
    if (h === 'localhost') return location.protocol + '//127.0.0.1:' + location.port;
    if (h === '127.0.0.1') return location.protocol + '//localhost:' + location.port;
    return location.origin;
  }

  function postToFrame(msg) {
    var f = $('frame');
    if (!f || !f.contentWindow) return;
    msg.__cbdown = 1;
    try { f.contentWindow.postMessage(msg, '*'); } catch (e) {}
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__cb !== 1) return;
    if (d.type === 'navigate') send({ type: 'navigate', url: d.url });
    else if (d.type === 'scroll') send({ type: 'scroll', x: d.x, y: d.y });
    else if (d.type === 'cursor') send({ type: 'cursor', x: d.x, y: d.y });
    else if (d.type === 'notice') toast(d.text, 'warn');
    else if (d.type === 'title' && d.url && document.activeElement !== $('urlInput')) {
      $('urlInput').value = d.url;
    }
  });

  setInterval(function () {
    if (!S.state || S.state.mode !== 'web') return;
    var now = Date.now();
    var list = [];
    Object.keys(S.cursors).forEach(function (id) {
      var c = S.cursors[id];
      if (now - c.ts > 4000) { delete S.cursors[id]; return; }
      list.push({ id: id, x: c.x, y: c.y, name: c.name, color: c.color });
    });
    postToFrame({ type: 'cursors', list: list });
  }, 70);

  // ---------------------------------------------------------- commandes --

  function currentPosition() {
    if (S.corrector && S.adapter && S.adapter.isReady()) return S.corrector.target();
    return S.state ? S.state.play.position : 0;
  }

  function togglePlay() {
    if (!S.state || !S.state.media) return;
    if (S.state.play.playing) send({ type: 'pause', position: currentPosition() });
    else send({ type: 'play', position: currentPosition() });
  }

  function seekTo(t) {
    var max = S.duration ? S.duration - 0.15 : Infinity;
    send({ type: 'seek', position: Math.max(0, Math.min(t, max)) });
  }

  $('btnPlay').onclick = togglePlay;
  $('btnBack10').onclick = function () { seekTo(currentPosition() - 10); };
  $('btnFwd10').onclick = function () { seekTo(currentPosition() + 10); };
  $('rate').onchange = function () { send({ type: 'rate', rate: Number(this.value) }); };
  $('btnCloseMedia').onclick = function () { send({ type: 'clearMedia' }); };
  $('btnTakeHost').onclick = function () { send({ type: 'host' }); };

  $('btnResync').onclick = function () {
    Clock.calibrate(9).then(function () {
      if (S.corrector) S.corrector.apply(true);
      toast('Horloge recalée (aller-retour ' + Math.round(Clock.rtt) + ' ms).');
    });
    send({ type: 'resync' });
  };

  // Le plein ecran porte sur le bloc complet : sur la seule vidéo, la barre de
  // commandes disparaitrait et on ne pourrait plus rien piloter.
  $('btnFull').onclick = function () {
    var el = $('cinema');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
  };

  $('btnUnmute').onclick = function () {
    // Ce clic redonne au navigateur l'autorisation de lire avec le son
    // (l'activation utilisateur se propage jusqu'a l'iframe YouTube).
    S.muted = false;
    if (S.volume === 0) S.volume = 1;
    applyVolume();
    if (S.yt) { try { S.yt.playVideo(); } catch (e) {} }
    else tryPlay($('video'));
    $('unmute').classList.add('hidden');
    if (S.corrector) S.corrector.apply(true);
  };

  $('volume').oninput = function () {
    S.volume = Number(this.value);
    S.muted = S.volume === 0;
    applyVolume();
  };
  $('btnMute').onclick = function () {
    S.muted = !S.muted;
    if (!S.muted && S.volume === 0) S.volume = 1;
    applyVolume();
  };

  $('subSel').onchange = applySubs;
  $('subInput').onchange = function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result);
      if (!/^﻿?WEBVTT/.test(text)) text = srtToVtt(text);
      var url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      addTrack(url, f.name.replace(/\.[^.]+$/, ''));
      toast('Sous-titres chargés (visibles par toi seul).');
    };
    reader.readAsText(f, 'utf-8');
    this.value = '';
  };

  $('waitAll').onchange = function () { send({ type: 'waitForAll', on: this.checked }); };
  $('autoSync').onchange = function () { if (S.corrector) S.corrector.enabled = this.checked; };

  // barre de progression
  (function () {
    var bar = $('seek');
    function ratio(e) {
      var r = bar.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    }
    function paint(p) {
      $('seekFill').style.width = p + '%';
      $('seekKnob').style.left = p + '%';
      $('curTime').textContent = fmt((p / 100) * S.duration);
    }
    bar.addEventListener('pointerdown', function (e) {
      if (!S.duration) return;
      S.seeking = true;
      try { bar.setPointerCapture(e.pointerId); } catch (err) {}
      paint(ratio(e) * 100);
    });
    bar.addEventListener('pointermove', function (e) {
      if (S.seeking) paint(ratio(e) * 100);
    });
    function end(e) {
      if (!S.seeking) return;
      S.seeking = false;
      seekTo(ratio(e) * S.duration);
    }
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', function () { S.seeking = false; });
  })();

  // onglets
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.onclick = function () { setMode(b.dataset.mode); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (x) {
        x.classList.remove('active');
      });
      b.classList.add('active');
      var chat = b.dataset.panel === 'chat';
      $('peoplePane').classList.toggle('hidden', chat);
      $('chatPane').classList.toggle('hidden', !chat);
      if (chat) {
        S.unread = 0;
        $('unread').classList.add('hidden');
        $('chat').scrollTop = $('chat').scrollHeight;
      }
    };
  });
  $('btnPanel').onclick = function () { $('panel').classList.toggle('closed'); };

  // chat
  $('chatForm').onsubmit = function (e) {
    e.preventDefault();
    var v = $('chatInput').value.trim();
    if (!v) return;
    send({ type: 'chat', text: v });
    $('chatInput').value = '';
  };
  $('emojis').onclick = function (e) {
    var t = (e.target.textContent || '').trim();
    if (t && t.length <= 4) send({ type: 'reaction', emoji: t });
  };

  // navigation web
  $('urlForm').onsubmit = function (e) {
    e.preventDefault();
    send({ type: 'navigate', url: $('urlInput').value });
    $('urlInput').blur();
  };
  $('btnWebBack').onclick = function () { send({ type: 'back' }); };
  $('btnWebFwd').onclick = function () { send({ type: 'forward' }); };
  $('btnWebReload').onclick = function () { send({ type: 'reload' }); };

  // Ouvrir chez tout le monde : pour les sites qu'un proxy ne peut pas servir
  // (anti-robot, connexion). Chacun ouvre le site dans son vrai navigateur.
  $('btnOpenAll').onclick = function () {
    var u = (S.state && S.state.web && S.state.web.url) || $('urlInput').value;
    u = (u || '').trim();
    if (!u) { toast('Ouvre d\'abord un site, puis propose-le à tous.', 'warn'); return; }
    // Le clic du pilote sert d'autorisation : sa fenetre s'ouvre tout de suite.
    window.open(u, '_blank', 'noopener');
    send({ type: 'openTab', url: u });
    toast('Proposé à tout le monde : chacun a un bouton pour l\'ouvrir.');
  };

  (function () {
    var timer = null;
    function hide() { $('openBanner').classList.add('hidden'); }
    $('openBannerClose').onclick = hide;
    $('openBannerBtn').onclick = function () { setTimeout(hide, 100); };
    // Chaque participant recoit la proposition : un clic (= geste utilisateur,
    // requis par le navigateur) ouvre le site dans son propre onglet.
    window.__onOpenTab = function (url, by) {
      var host = url;
      try { host = new URL(url).host; } catch (e) {}
      $('openBannerText').textContent = (by ? by + ' propose : ' : 'À ouvrir : ') + host;
      $('openBannerBtn').href = url;
      $('openBanner').classList.remove('hidden');
      clearTimeout(timer);
      timer = setTimeout(hide, 30000);
    };
  })();
  $('freeBrowse').onchange = function () { send({ type: 'freeBrowsing', on: this.checked }); };
  Array.prototype.forEach.call(document.querySelectorAll('.quick button'), function (b) {
    b.onclick = function () { send({ type: 'navigate', url: b.dataset.url }); };
  });

  // ------------------------------------------------------- bibliotheque --

  function loadLibrary() {
    fetch('/media/list')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $('libDir').textContent = 'Dossier : ' + d.dir;
        var ul = $('files');
        ul.innerHTML = '';
        if (!d.items.length) {
          ul.innerHTML = '<li class="off"><span class="fname">Aucune vidéo dans ce dossier.</span></li>';
          return;
        }
        d.items.forEach(function (it) {
          var li = document.createElement('li');
          if (!it.playable) li.className = 'off';
          li.innerHTML =
            '<span class="fname">' + esc(it.name) + '</span>' +
            '<span class="fmeta">' + (it.sub ? 'ST · ' : '') +
            (it.playable ? bytes(it.size) : 'format illisible par le navigateur') + '</span>';
          if (it.playable) {
            li.onclick = function () {
              send({ type: 'media', media: { kind: 'file', src: it.path, title: it.name, sub: it.sub } });
              closeLib();
            };
          } else {
            li.title = 'Chrome et Firefox ne lisent pas ce conteneur. Remuxe-le en .mp4.';
          }
          ul.appendChild(li);
        });
      })
      .catch(function () { toast('Bibliothèque inaccessible.', 'warn'); });
  }

  function openLib() {
    $('library').classList.remove('hidden');
    loadLibrary();
  }
  function closeLib() { $('library').classList.add('hidden'); }

  $('btnLib').onclick = openLib;
  $('btnOpenLib').onclick = openLib;
  $('waitAction').onclick = openLib;
  $('btnCloseLib').onclick = closeLib;
  $('btnRefreshLib').onclick = loadLibrary;
  $('library').onclick = function (e) { if (e.target === $('library')) closeLib(); };

  Array.prototype.forEach.call(document.querySelectorAll('.lib-tab'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.lib-tab'), function (x) {
        x.classList.remove('active');
      });
      b.classList.add('active');
      $('libFiles').classList.toggle('hidden', b.dataset.lib !== 'files');
      $('libLocal').classList.toggle('hidden', b.dataset.lib !== 'local');
      $('libUrl').classList.toggle('hidden', b.dataset.lib !== 'url');
      $('libYt').classList.toggle('hidden', b.dataset.lib !== 'yt');
    };
  });

  $('btnLoadUrl').onclick = function () {
    var u = $('urlMedia').value.trim();
    if (!u) return;
    var name = u.split('/').pop().split('?')[0] || u;
    try { name = decodeURIComponent(name); } catch (e) {}
    send({
      type: 'media',
      media: { kind: 'url', src: u, title: name, sub: $('urlSub').value.trim() || null },
    });
    closeLib();
  };
  $('btnLoadYt').onclick = function () {
    var id = ytId($('ytUrl').value);
    if (!id) return toast('Lien YouTube non reconnu.', 'warn');
    send({ type: 'media', media: { kind: 'youtube', src: id, title: 'YouTube · ' + id } });
    closeLib();
  };

  $('localInput').onchange = function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    useLocalFile(f);
    closeLib();
  };
  $('pickInput').onchange = function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (f) useLocalFile(f);
  };

  // Diffuser le film depuis l'appareil de l'hote : un seul envoi, puis le
  // serveur le sert a tout le monde (les autres n'ont rien a fournir).
  if ($('hostInput')) $('hostInput').onchange = function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (f) uploadHostFile(f);
  };

  // Diffusion en direct : l'hôte garde le fichier et répond aux demandes de
  // tranches. Aucune limite de taille, rien n'est envoyé d'avance.
  if ($('hostStreamInput')) $('hostStreamInput').onchange = function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (S.streamUrl) { try { URL.revokeObjectURL(S.streamUrl); } catch (e) {} }
    S.streamFile = file;
    S.streamUrl = URL.createObjectURL(file);
    send({ type: 'provideFile', name: file.name, size: file.size });
    toast('Diffusion en direct lancée. Garde cet onglet ouvert.', null, 5000);
    closeLib();
  };

  // Réponse à une demande de tranche : on lit le morceau du fichier et on le
  // renvoie tel quel au serveur, qui le relaie au participant qui l'attend.
  function answerPull(reqId, start, end) {
    if (!S.streamFile) return;
    var blob = S.streamFile.slice(start, end + 1);
    blob.arrayBuffer().then(function (buf) {
      return fetch('/host-chunk?room=' + encodeURIComponent(S.room) + '&id=' + encodeURIComponent(reqId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
    }).catch(function () {});
  }
  window.__answerPull = answerPull;

  function uploadHostFile(file) {
    var maxMb = (S.cfg && S.cfg.hostUploadMaxMb) || 800;
    if (file.size > maxMb * 1024 * 1024) {
      toast('Fichier trop lourd pour la diffusion (max ' + maxMb + ' Mo). Utilise « chacun sa copie ».', 'warn', 6000);
      return;
    }
    $('hostProgress').classList.remove('hidden');
    $('hostProgressFill').style.width = '0%';
    $('hostProgressText').textContent = 'Envoi… 0 %';
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/host-upload?room=' + encodeURIComponent(S.room) +
      '&who=' + encodeURIComponent(S.clientId) + '&size=' + file.size +
      '&name=' + encodeURIComponent(file.name));
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round((e.loaded / e.total) * 100);
      $('hostProgressFill').style.width = pct + '%';
      $('hostProgressText').textContent = 'Envoi… ' + pct + ' %';
    };
    xhr.onload = function () {
      if (xhr.status === 200) {
        $('hostProgressText').textContent = 'Envoyé — lecture pour tout le monde.';
        // Nouvelle version a chaque envoi : force le rechargement de la source.
        send({ type: 'media', media: { kind: 'hosted', src: String(Date.now()), title: file.name, size: file.size } });
        setTimeout(function () { closeLib(); $('hostProgress').classList.add('hidden'); }, 800);
      } else {
        var msg = 'Envoi impossible.';
        try { var d = JSON.parse(xhr.responseText); if (d.maxMb) msg = 'Fichier trop lourd (max ' + d.maxMb + ' Mo).'; } catch (e) {}
        $('hostProgress').classList.add('hidden');
        toast(msg, 'warn', 6000);
      }
    };
    xhr.onerror = function () { $('hostProgress').classList.add('hidden'); toast('Envoi interrompu.', 'warn'); };
    xhr.send(file);
  }

  // glisser-deposer un fichier video n'importe ou dans la fenetre
  (function () {
    var depth = 0;
    function hasFiles(e) {
      return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      depth++;
      $('dropZone').classList.remove('hidden');
    });
    window.addEventListener('dragover', function (e) {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', function () {
      if (--depth <= 0) { depth = 0; $('dropZone').classList.add('hidden'); }
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      $('dropZone').classList.add('hidden');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (/\.(srt|vtt)$/i.test(f.name)) {
        var dt = new DataTransfer();
        dt.items.add(f);
        $('subInput').files = dt.files;
        $('subInput').onchange.call($('subInput'));
        return;
      }
      useLocalFile(f);
    });
  })();

  // invitation
  $('btnInvite').onclick = function () {
    fetch('/net')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // En cloud, le code de seance est le seul secret : le lien est
        // simplement l'adresse du service. En local, la cle d'acces doit
        // voyager avec, sinon le lien ne sert a rien.
        if (S.cfg && S.cfg.cloud) return location.origin + '/#' + S.room;
        var base = d.public
          ? d.public.replace(/\/$/, '')
          : 'http://' + (d.addresses[0] || location.hostname) + ':' + d.port;
        return base + '/?k=' + encodeURIComponent(d.key) + '#' + S.room;
      })
      .catch(function () { return location.origin + '/#' + S.room; })
      .then(function (link) {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(link).then(
            function () { toast('Lien copié : ' + link); },
            function () { toast('Lien à partager : ' + link); }
          );
        } else {
          toast('Lien à partager : ' + link);
        }
      });
  };

  // raccourcis clavier
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('library').classList.contains('hidden')) {
      closeLib();
      return;
    }
    var t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!S.state || S.state.mode === 'web') return;

    if (e.code === 'Space' || e.key === 'k') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(currentPosition() - 5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(currentPosition() + 5); }
    else if (e.key === 'f') $('btnFull').click();
    else if (e.key === 'm') $('btnMute').click();
    else if (e.key === 'c') $('subSel').selectedIndex = ($('subSel').selectedIndex + 1) % $('subSel').options.length, applySubs();
  });

  // evenements du lecteur HTML5
  (function () {
    var v = $('video');
    v.addEventListener('waiting', reportStall);
    v.addEventListener('stalled', reportStall);
    v.addEventListener('canplay', function () { reportReady(true, 2); });
    v.addEventListener('canplaythrough', function () { reportReady(true, 5); });
    v.addEventListener('playing', function () { reportReady(true, 3); });
    v.addEventListener('loadedmetadata', function () {
      S.duration = v.duration || 0;
      refreshSubs();
    });
    v.addEventListener('error', function () {
      if (!v.currentSrc) return;
      var media = S.state && S.state.media;
      var code = v.error && v.error.code;
      var why;
      if (media && media.kind === 'local') why = 'fichier illisible par le navigateur (essaie un .mp4 H.264)';
      else if (code === 2) why = 'source injoignable (lien mort ou hors ligne)';
      else if (code === 3) why = 'fichier corrompu ou codec non supporté';
      else why = 'lien mort ou format non supporté';
      toast('Lecture impossible : ' + why + '.', 'warn', 7000);
      reportReady(false, 0, why);
    });

    // Si le navigateur bloque la lecture automatique, on le detecte et on
    // propose un bouton : le clic redonne l'autorisation de lire avec le son.
    setInterval(function () {
      if (!S.state || !S.state.play.playing || !S.corrector || !S.adapter) return;
      if (S.corrector.startsIn() > 0) return;
      if (!S.adapter.isReady()) return;
      if (S.adapter.isPaused()) $('unmute').classList.remove('hidden');
    }, 1000);
  })();

  // ---------------------------------------------------------- demarrage --

  /** Adapte l'interface a ce que cette instance sait faire. */
  function applyConfig(cfg) {
    S.cfg = cfg;
    if (!cfg.canProxy) document.querySelector('.tab[data-mode="web"]').classList.add('hidden');
    if (cfg.cloud) {
      // Pas de disque a servir : on retire ce qui ne marcherait pas.
      document.querySelector('.lib-tab[data-lib="files"]').classList.add('hidden');
      // Ici les pages proxifiees sortent de la meme origine que l'appli. Le
      // bac a sable sans allow-same-origin leur donne une origine opaque :
      // elles ne peuvent ni lire son stockage ni parler a son API en notre
      // nom. postMessage vers le parent continue de fonctionner.
      $('frame').setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-pointer-lock');
      $('libFiles').classList.add('hidden');
      document.querySelector('.lib-tab[data-lib="local"]').classList.add('active');
      $('libLocal').classList.remove('hidden');
      $('btnInvite').title = 'Copier le lien et le code de la séance';
      if (cfg.canHostUpload && $('hostUploadBlock')) {
        $('hostUploadBlock').classList.remove('hidden');
        if ($('hostHint')) $('hostHint').textContent =
          'Envoi complet : idéal jusqu\'à ' + (cfg.hostUploadMaxMb || 800) + ' Mo ; une fois envoyé tu peux fermer.';
      }
      if (cfg.canHostStream && $('hostStreamRow')) {
        $('hostUploadBlock').classList.remove('hidden');
        $('hostStreamRow').classList.remove('hidden');
      }

      $('roomLabel').firstChild.textContent = 'Code de séance ';
      $('joinRoom').placeholder = 'ex. k3f9tp';
      $('btnCreate').classList.remove('hidden');
    }
  }

  $('btnCreate').onclick = function () {
    var b = this;
    b.disabled = true;
    b.textContent = 'Création…';
    fetch('/session', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $('joinRoom').value = d.code;
        b.textContent = 'Séance ' + d.code + ' créée';
        $('joinHint').textContent = 'Donne ce code à tes potes, puis rejoins.';
        if (!$('joinName').value.trim()) $('joinName').focus();
        else $('joinForm').dispatchEvent(new Event('submit', { cancelable: true }));
      })
      .catch(function () {
        b.textContent = 'Créer une nouvelle séance';
        toast('Création impossible.', 'warn');
      })
      .then(function () { b.disabled = false; });
  };

  // installation (PWA)
  (function () {
    var prompt = null;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      prompt = e;
      $('btnInstall').classList.remove('hidden');
    });
    $('btnInstall').onclick = function () {
      if (!prompt) return;
      prompt.prompt();
      prompt.userChoice.then(function () {
        prompt = null;
        $('btnInstall').classList.add('hidden');
      });
    };
    window.addEventListener('appinstalled', function () {
      $('btnInstall').classList.add('hidden');
    });
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () {});
      });
    }
  })();

  function boot() {
    fetch('/config')
      .then(function (r) { return r.json(); })
      .then(applyConfig)
      .catch(function () {});

    try {
      // sessionStorage et non localStorage : l'identite doit survivre a un
      // rechargement mais rester propre a l'onglet. Partagee via localStorage,
      // un second onglet du meme navigateur prendrait la place du premier.
      S.cid = sessionStorage.getItem('cb.cid');
      if (!S.cid) {
        S.cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('cb.cid', S.cid);
      }
      var vol = parseFloat(localStorage.getItem('cb.vol'));
      if (isFinite(vol)) S.volume = Math.min(1, Math.max(0, vol));
      S.muted = localStorage.getItem('cb.muted') === '1';
    } catch (e) {
      S.cid = Math.random().toString(36).slice(2);
    }
    applyVolume();

    var hash = decodeURIComponent(location.hash.replace('#', '')).trim();
    var savedRoom = '';
    var savedName = '';
    try {
      savedRoom = localStorage.getItem('cb.room') || '';
      savedName = localStorage.getItem('cb.name') || '';
    } catch (e) {}
    $('joinRoom').value = hash || savedRoom || 'salon';
    $('joinName').value = savedName;
    $('joinName').focus();

    $('joinHint').textContent = 'Calibration de l’horloge…';
    Clock.calibrate(7).then(function (ok) {
      if (S.hintLocked) return;
      $('joinHint').textContent = ok
        ? 'Horloge synchronisée (aller-retour ' + Math.round(Clock.rtt) + ' ms).'
        : 'Serveur injoignable.';
    });

    $('joinForm').onsubmit = function (e) {
      e.preventDefault();
      S.name = $('joinName').value.trim() || 'Invité';
      S.room = ($('joinRoom').value.trim() || 'salon').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'salon';
      try {
        localStorage.setItem('cb.name', S.name);
        localStorage.setItem('cb.room', S.room);
      } catch (err) {}
      location.hash = S.room;

      // Le geste utilisateur debloque la lecture automatique pour la suite.
      var v = $('video');
      try {
        var p = v.play();
        if (p && p.then) p.then(function () { v.pause(); }).catch(function () {});
      } catch (err) {}

      $('join').classList.add('hidden');
      $('app').classList.remove('hidden');
      connect();
    };
  }

  boot();
})();
