/**
 * Legacy IIFE mirror of dashboard/src/animations.ts (Phase 2 PR D).
 *
 * The browser loads the ESM build from dist/animations.js. This file exists
 * ONLY so tests/dashboard/render.test.js can inject it into a JSDOM window
 * via <script> string injection. PR G deletes all legacy mirrors.
 *
 * Contract: keep byte-level parity with src/animations.ts.
 */
(function () {
  'use strict';

  var CONFETTI_COLORS = [
    '#c8713a',
    '#e8a070',
    '#5a7a62',
    '#8aaa92',
    '#5a6b7a',
    '#8a9baa',
    '#d4b896',
    '#b35a5a',
  ];

  var CONFETTI_PARTICLE_COUNT = 17;
  var CARD_CLOSE_DURATION_MS = 300;
  var TOAST_VISIBLE_MS = 2500;

  function playCloseSound() {
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;

      var ctx = new Ctor();
      var t = ctx.currentTime;

      var duration = 0.25;
      var buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
      var data = buffer.getChannelData(0);

      for (var i = 0; i < data.length; i++) {
        var pos = i / data.length;
        var env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
        data[i] = (Math.random() * 2 - 1) * env;
      }

      var source = ctx.createBufferSource();
      source.buffer = buffer;

      var filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 2.0;
      filter.frequency.setValueAtTime(4000, t);
      filter.frequency.exponentialRampToValueAtTime(400, t + duration);

      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

      source.connect(filter).connect(gain).connect(ctx.destination);
      source.start(t);

      setTimeout(function () { ctx.close(); }, 500);
    } catch (e) {
      // Audio not supported — fail silently.
    }
  }

  function shootConfetti(x, y) {
    for (var i = 0; i < CONFETTI_PARTICLE_COUNT; i++) {
      (function () {
        var el = document.createElement('div');

        var isCircle = Math.random() > 0.5;
        var size = 5 + Math.random() * 6;
        var color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];

        el.style.cssText =
          'position: fixed;' +
          'left: ' + x + 'px;' +
          'top: ' + y + 'px;' +
          'width: ' + size + 'px;' +
          'height: ' + size + 'px;' +
          'background: ' + color + ';' +
          'border-radius: ' + (isCircle ? '50%' : '2px') + ';' +
          'pointer-events: none;' +
          'z-index: 9999;' +
          'transform: translate(-50%, -50%);' +
          'opacity: 1;';
        document.body.appendChild(el);

        var angle = Math.random() * Math.PI * 2;
        var speed = 60 + Math.random() * 120;
        var vx = Math.cos(angle) * speed;
        var vy = Math.sin(angle) * speed - 80;
        var gravity = 200;

        var startTime = performance.now();
        var duration = 700 + Math.random() * 200;

        function frame(now) {
          var elapsed = (now - startTime) / 1000;
          var progress = elapsed / (duration / 1000);

          if (progress >= 1) {
            el.remove();
            return;
          }

          var px = vx * elapsed;
          var py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
          var opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
          var rotate = elapsed * 200 * (isCircle ? 0 : 1);

          el.style.transform =
            'translate(calc(-50% + ' + px + 'px), calc(-50% + ' + py + 'px)) rotate(' + rotate + 'deg)';
          el.style.opacity = String(opacity);

          requestAnimationFrame(frame);
        }

        requestAnimationFrame(frame);
      })();
    }
  }

  function animateCardOut(card, onComplete) {
    if (!card) return;

    var rect = card.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    shootConfetti(cx, cy);

    card.classList.add('closing');
    setTimeout(function () {
      card.remove();
      if (onComplete) onComplete();
    }, CARD_CLOSE_DURATION_MS);
  }

  function showToast(message) {
    var toast = document.getElementById('toast');
    var text = document.getElementById('toastText');
    if (!toast || !text) return;
    text.textContent = message;
    toast.classList.add('visible');
    setTimeout(function () { toast.classList.remove('visible'); }, TOAST_VISIBLE_MS);
  }

  window.animations = {
    playCloseSound: playCloseSound,
    shootConfetti: shootConfetti,
    animateCardOut: animateCardOut,
    showToast: showToast,
  };
})();
