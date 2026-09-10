/* Script injecte dans les pages servies par le proxy (mode "Web partage").
   Il relaie a l'application parente : liens cliques, defilement, curseur ;
   et applique en retour le defilement du pilote et les curseurs des autres. */
(function () {
  'use strict';
  if (window.__cobrowse) return;
  window.__cobrowse = true;
  if (window.parent === window) return;

  var TOP = window.parent;
  var applying = 0;

  function post(msg) {
    msg.__cb = 1;
    try { TOP.postMessage(msg, '*'); } catch (e) {}
  }

  function throttle(fn, ms) {
    var last = 0, timer = null, lastArgs = null;
    return function () {
      lastArgs = arguments;
      var now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn.apply(null, lastArgs);
      } else if (!timer) {
        timer = setTimeout(function () {
          timer = null;
          last = Date.now();
          fn.apply(null, lastArgs);
        }, ms - (now - last));
      }
    };
  }

  // ------------------------------------------------------------ sortants --

  var sendScroll = throttle(function () {
    if (applying > Date.now()) return;
    post({ type: 'scroll', x: window.scrollX, y: window.scrollY });
  }, 60);

  var sendCursor = throttle(function (x, y) {
    post({ type: 'cursor', x: x, y: y });
  }, 55);

  window.addEventListener('scroll', sendScroll, { passive: true });
  document.addEventListener('mousemove', function (e) { sendCursor(e.pageX, e.pageY); }, { passive: true, capture: true });

  document.addEventListener(
    'click',
    function (e) {
      var el = e.target;
      var a = el && el.closest ? el.closest('a[href]') : null;
      if (!a) return;
      var raw = a.getAttribute('href') || '';
      if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(raw)) return;
      var abs;
      try { abs = new URL(a.href, location.href).href; } catch (err) { return; }
      if (!/^https?:/i.test(abs)) return;
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'navigate', url: abs });
    },
    true
  );

  document.addEventListener(
    'submit',
    function (e) {
      var f = e.target;
      if (!f || f.tagName !== 'FORM') return;
      var method = (f.getAttribute('method') || 'get').toLowerCase();
      e.preventDefault();
      if (method !== 'get') {
        post({ type: 'notice', text: 'Le proxy ne relaie pas les formulaires POST.' });
        return;
      }
      var u;
      try { u = new URL(f.getAttribute('action') || location.href, location.href); } catch (err) { return; }
      var params = new URLSearchParams();
      try {
        new FormData(f).forEach(function (v, k) { if (typeof v === 'string') params.append(k, v); });
      } catch (err) {}
      u.search = params.toString();
      post({ type: 'navigate', url: u.href });
    },
    true
  );

  window.open = function (url) {
    if (url) {
      try { post({ type: 'navigate', url: new URL(url, location.href).href }); } catch (e) {}
    }
    return null;
  };

  function announce() {
    // document.baseURI vaut le <base href> injecte par le proxy, c'est-a-dire
    // l'adresse reelle du site - pas l'URL interne du proxy.
    post({ type: 'title', title: document.title, url: document.baseURI });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
  else announce();
  window.addEventListener('load', announce);

  // ------------------------------------------------------------ entrants --

  var layer = null;
  var nodes = {};

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.setAttribute('data-cobrowse', 'cursors');
    layer.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    (document.body || document.documentElement).appendChild(layer);
    nodes = {};
    return layer;
  }

  function cursorNode(c) {
    var n = nodes[c.id];
    if (n && n.isConnected) return n;
    n = document.createElement('div');
    n.style.cssText =
      'position:absolute;transform:translate(-2px,-2px);transition:top .08s linear,left .08s linear;' +
      'pointer-events:none;font:600 11px system-ui,sans-serif;white-space:nowrap;';
    n.innerHTML =
      '<svg width="16" height="20" viewBox="0 0 16 20" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">' +
      '<path d="M1 1l12 9-5.2.7L11 18l-2.6 1-3-6.4L1 16z" fill="' + c.color + '" stroke="#fff" stroke-width="1.2"/></svg>' +
      '<span style="display:inline-block;margin:2px 0 0 10px;padding:1px 6px;border-radius:8px;color:#fff;' +
      'background:' + c.color + ';box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>';
    n.lastChild.textContent = c.name;
    ensureLayer().appendChild(n);
    nodes[c.id] = n;
    return n;
  }

  function renderCursors(list) {
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      seen[c.id] = 1;
      var n = cursorNode(c);
      n.style.left = c.x + 'px';
      n.style.top = c.y + 'px';
    }
    Object.keys(nodes).forEach(function (id) {
      if (!seen[id]) {
        if (nodes[id] && nodes[id].remove) nodes[id].remove();
        delete nodes[id];
      }
    });
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__cbdown !== 1) return;
    if (d.type === 'scrollTo') {
      applying = Date.now() + 180;
      window.scrollTo({ left: d.x, top: d.y, behavior: 'auto' });
    } else if (d.type === 'cursors') {
      if (!d.list.length && !Object.keys(nodes).length) return;
      renderCursors(d.list);
    }
  });
})();
