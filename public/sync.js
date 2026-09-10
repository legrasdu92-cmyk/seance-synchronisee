/**
 * Moteur de synchronisation.
 *
 *  1. SyncClock  : aligne l'horloge locale sur celle du serveur (methode NTP
 *                  simplifiee : plusieurs sondes, on garde les aller-retours
 *                  les plus courts, moyenne des decalages).
 *  2. Corrector  : compare en continu la position du lecteur a la position
 *                  theorique calculee depuis l'horloge partagee, et corrige
 *                  - par micro-variation de vitesse pour les petits ecarts
 *                    (invisible a l'oeil et a l'oreille),
 *                  - par saut pour les gros ecarts.
 *
 *  Resultat : tous les lecteurs convergent vers la meme position, quel que
 *  soit le moment ou ils rejoignent la seance.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- horloge --

  var SyncClock = {
    offset: 0, // ms a ajouter a Date.now() pour obtenir l'heure serveur
    rtt: 0, // meilleur aller-retour observe
    calibrated: false,

    now: function () {
      return Date.now() + this.offset;
    },

    probe: function () {
      var t0 = Date.now();
      return fetch('/time', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
        .then(function (r) {
          var t2 = Date.now();
          return r.json().then(function (d) {
            var rtt = t2 - t0;
            return { rtt: rtt, offset: d.t - (t0 + rtt / 2) };
          });
        });
    },

    calibrate: function (samples) {
      var self = this;
      var n = samples || 7;
      var got = [];
      function next(i) {
        if (i >= n) return Promise.resolve();
        return self
          .probe()
          .then(function (s) {
            got.push(s);
          })
          .catch(function () {})
          .then(function () {
            return new Promise(function (r) {
              setTimeout(r, 40);
            });
          })
          .then(function () {
            return next(i + 1);
          });
      }
      return next(0).then(function () {
        if (!got.length) return false;
        got.sort(function (a, b) {
          return a.rtt - b.rtt;
        });
        var best = got.slice(0, Math.max(1, Math.min(3, got.length)));
        var avg = best.reduce(function (s, x) {
          return s + x.offset;
        }, 0) / best.length;
        self.rtt = best[0].rtt;
        // Premiere calibration : on prend la valeur telle quelle. Ensuite on
        // lisse pour eviter les a-coups de position.
        self.offset = self.calibrated ? self.offset * 0.6 + avg * 0.4 : avg;
        self.calibrated = true;
        return true;
      });
    },
  };

  // --------------------------------------------------------- correcteur ---

  // Zone morte volontairement etroite : deux clients peuvent chacun s'y
  // installer, donc l'ecart entre eux vaut au pire deux fois cette valeur.
  var SOFT = 0.022; // s : en dessous, on ne touche a rien
  // Au dela de HARD on saute : a +-12 % de vitesse, resorber 300 ms prend deja
  // 2,5 s. Un micro-saut vaut mieux qu'un long moment desynchronise.
  var HARD = 0.3; // s
  var JUMP_COOLDOWN = 900; // ms : evite les sauts en rafale pendant un buffer
  var GAIN = 1.0; // reactivite du rattrapage doux
  var MAX_TRIM = 0.12; // +-12 % de vitesse au maximum
  var YT_TOL = 0.35; // s : tolerance YouTube (pas de micro-vitesse possible)

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  /**
   * @param {object} adapter interface lecteur :
   *   getTime, setTime, play, pause, isPaused, setRate, buffered, duration,
   *   canRate (bool), isReady (bool)
   */
  function Corrector(adapter, opts) {
    this.a = adapter;
    this.opts = opts || {};
    this.state = null; // { playing, position, anchor, rate }
    this.enabled = true;
    this.drift = 0;
    this.corrections = 0;
    this.jumps = 0;
    this._startTimer = null;
    this._spinning = false;
    this._timer = null;
    this._lastJump = 0;
  }

  Corrector.prototype.setState = function (play) {
    this.state = play;
    this.corrections = 0;
    this.jumps = 0;
    this.apply(true);
  };

  Corrector.prototype.start = function () {
    var self = this;
    if (this._timer) return;
    this._timer = setInterval(function () {
      self.apply(false);
    }, 150);
  };

  Corrector.prototype.stop = function () {
    clearInterval(this._timer);
    this._timer = null;
    clearTimeout(this._startTimer);
  };

  /** Position mediatique theorique a l'instant present. */
  Corrector.prototype.target = function () {
    var s = this.state;
    if (!s) return 0;
    if (!s.playing) return s.position;
    var elapsed = Math.max(0, SyncClock.now() - s.anchor) / 1000;
    return s.position + elapsed * s.rate;
  };

  Corrector.prototype.startsIn = function () {
    if (!this.state || !this.state.playing) return 0;
    return this.state.anchor - SyncClock.now();
  };

  /** Demarrage a l'instant pile : minuterie grossiere puis rAF pour finir. */
  Corrector.prototype._scheduleStart = function (anchor) {
    var self = this;
    if (this._spinning) return;
    clearTimeout(this._startTimer);
    var delay = anchor - SyncClock.now() - 90;
    this._spinning = true;
    this._startTimer = setTimeout(function () {
      var step = function () {
        if (!self.state || !self.state.playing) {
          self._spinning = false;
          return;
        }
        if (SyncClock.now() >= anchor - 8) {
          self._spinning = false;
          self.a.play();
          return;
        }
        requestAnimationFrame(step);
      };
      step();
    }, Math.max(0, delay));
  };

  Corrector.prototype.apply = function (force) {
    var s = this.state;
    var a = this.a;
    if (!s || !a.isReady()) return;

    var target = this.target();
    var cur = a.getTime();
    this.drift = cur - target;

    // --- en pause -----------------------------------------------------
    if (!s.playing) {
      clearTimeout(this._startTimer);
      this._spinning = false;
      if (!a.isPaused()) a.pause();
      if (Math.abs(cur - s.position) > 0.25 || force) a.setTime(s.position);
      a.setRate(s.rate);
      return;
    }

    // --- depart programme ---------------------------------------------
    var startsIn = s.anchor - SyncClock.now();
    if (startsIn > 15) {
      if (!a.isPaused()) a.pause();
      if (Math.abs(cur - s.position) > 0.15 || force) a.setTime(s.position);
      a.setRate(s.rate);
      this._scheduleStart(s.anchor);
      return;
    }

    // --- fin de media -------------------------------------------------
    // Sans ce garde-fou, la position theorique depasse la duree, le lecteur
    // termine puis `play()` le fait repartir de zero : la seance boucle.
    var dur = a.duration ? a.duration() : 0;
    if (dur && target >= dur - 0.04) {
      if (!a.isPaused()) a.pause();
      if (Math.abs(cur - dur) > 0.3) a.setTime(Math.max(0, dur - 0.04));
      a.setRate(s.rate);
      return;
    }

    // --- lecture en cours ---------------------------------------------
    if (a.isPaused()) a.play();

    var diff = target - cur; // >0 : on est en retard
    var abs = Math.abs(diff);

    if (!this.enabled) {
      a.setRate(s.rate);
      return;
    }

    if (!a.canRate) {
      // YouTube : uniquement du recalage.
      if (abs > YT_TOL) {
        a.setTime(target + 0.12);
        this.jumps++;
      }
      a.setRate(s.rate);
      return;
    }

    if (abs > HARD && Date.now() - this._lastJump > JUMP_COOLDOWN) {
      a.setTime(target + 0.12); // la recherche coute ~100 ms, on anticipe
      a.setRate(s.rate);
      this._lastJump = Date.now();
      this.jumps++;
    } else if (abs > SOFT) {
      // Rattrapage doux : la vitesse est corrigee proportionnellement a
      // l'ecart, plafonnee a +-12 % (inaudible, le navigateur conserve la
      // hauteur du son). Constante de temps d'environ une seconde.
      a.setRate(
        clamp(s.rate * (1 + diff * GAIN), s.rate * (1 - MAX_TRIM), s.rate * (1 + MAX_TRIM))
      );
      this.corrections++;
    } else {
      a.setRate(s.rate);
    }
  };

  // ------------------------------------------------------------ adaptateurs --

  function HtmlAdapter(video) {
    this.v = video;
    this.canRate = true;
  }
  HtmlAdapter.prototype.getTime = function () {
    return this.v.currentTime || 0;
  };
  HtmlAdapter.prototype.setTime = function (t) {
    try {
      this.v.currentTime = Math.max(0, t);
    } catch (e) {}
  };
  HtmlAdapter.prototype.play = function () {
    var p = this.v.play();
    if (p && p.catch) p.catch(function () {});
  };
  HtmlAdapter.prototype.pause = function () {
    this.v.pause();
  };
  HtmlAdapter.prototype.isPaused = function () {
    return this.v.paused;
  };
  HtmlAdapter.prototype.setRate = function (r) {
    if (Math.abs(this.v.playbackRate - r) > 0.001) this.v.playbackRate = r;
  };
  HtmlAdapter.prototype.duration = function () {
    return isFinite(this.v.duration) ? this.v.duration : 0;
  };
  HtmlAdapter.prototype.isReady = function () {
    return this.v.readyState >= 2 && !!this.v.currentSrc;
  };
  HtmlAdapter.prototype.buffered = function () {
    var v = this.v;
    for (var i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
        return v.buffered.end(i) - v.currentTime;
      }
    }
    return 0;
  };

  function YtAdapter(player) {
    this.p = player;
    this.canRate = false;
  }
  YtAdapter.prototype.getTime = function () {
    try {
      return this.p.getCurrentTime() || 0;
    } catch (e) {
      return 0;
    }
  };
  YtAdapter.prototype.setTime = function (t) {
    try {
      this.p.seekTo(Math.max(0, t), true);
    } catch (e) {}
  };
  YtAdapter.prototype.play = function () {
    try {
      this.p.playVideo();
    } catch (e) {}
  };
  YtAdapter.prototype.pause = function () {
    try {
      this.p.pauseVideo();
    } catch (e) {}
  };
  YtAdapter.prototype.isPaused = function () {
    try {
      return this.p.getPlayerState() !== 1;
    } catch (e) {
      return true;
    }
  };
  YtAdapter.prototype.setRate = function (r) {
    try {
      var allowed = this.p.getAvailablePlaybackRates() || [1];
      var best = allowed.reduce(function (a, b) {
        return Math.abs(b - r) < Math.abs(a - r) ? b : a;
      }, allowed[0]);
      if (this.p.getPlaybackRate() !== best) this.p.setPlaybackRate(best);
    } catch (e) {}
  };
  YtAdapter.prototype.duration = function () {
    try {
      return this.p.getDuration() || 0;
    } catch (e) {
      return 0;
    }
  };
  YtAdapter.prototype.isReady = function () {
    try {
      return typeof this.p.getPlayerState === 'function' && this.p.getPlayerState() !== -1;
    } catch (e) {
      return false;
    }
  };
  YtAdapter.prototype.buffered = function () {
    try {
      return (this.p.getVideoLoadedFraction() || 0) * this.duration() - this.getTime();
    } catch (e) {
      return 0;
    }
  };

  window.Sync = {
    Clock: SyncClock,
    Corrector: Corrector,
    HtmlAdapter: HtmlAdapter,
    YtAdapter: YtAdapter,
    SOFT: SOFT,
    HARD: HARD,
  };
})();
