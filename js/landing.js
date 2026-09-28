(function () {
  // Flips .reveal-up from "hidden until JS proves it ran" to "visible
  // unless JS proves it's running" -- see the .reveal-up comment in
  // landing.css. This runs synchronously, first, before anything else in
  // this file, so the window where content could be invisible is as small
  // as this script's own parse+exec time, not a scroll-triggered observer
  // callback that may never fire for a given viewport/capture.
  document.documentElement.classList.add('js-reveal');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- scroll-linked chrome: progress hairline + nav material ----------
  var progressEl = document.getElementById('scrollProgress');
  var navEl = document.getElementById('siteNav');
  var heroFrame = document.getElementById('heroArtFrame');
  var ticking = false;

  function updateOnScroll() {
    ticking = false;
    var doc = document.documentElement;
    var scrollTop = window.scrollY || doc.scrollTop;
    var max = (doc.scrollHeight - doc.clientHeight) || 1;
    var pct = Math.min(100, Math.max(0, (scrollTop / max) * 100));

    if (progressEl) progressEl.style.width = pct + '%';
    if (navEl) navEl.classList.toggle('is-scrolled', scrollTop > 8);

    // Gentle parallax on the hero screenshot -- moves slightly slower than
    // the page, and eases toward a soft downscale, so it reads as sitting
    // in its own depth plane rather than being glued flat to the text.
    // Capped to the hero's own height so it settles rather than drifting
    // forever on a long page.
    if (heroFrame && !reduceMotion) {
      var heroH = heroFrame.parentElement ? heroFrame.parentElement.offsetHeight : 800;
      heroScrollT = Math.min(1, scrollTop / (heroH * 1.1));
      applyHeroTransform();
    }
  }

  // The hero clip sits in a tilted 3D frame (like the demo video) that
  // eases flat as you scroll into the page, plus a small tilt toward the
  // pointer on desktop. Scroll and pointer both feed this one function so
  // they compose instead of overwriting each other.
  var heroScrollT = 0;
  var pointerX = 0, pointerY = 0;
  function applyHeroTransform() {
    if (!heroFrame) return;
    var flat = Math.min(1, heroScrollT * 2.2);
    var ry = -9 * (1 - flat) + pointerX * 5;
    var rx = 4 * (1 - flat) - pointerY * 4;
    var translate = heroScrollT * 36; // px
    var scale = 1 - heroScrollT * 0.035;
    heroFrame.style.transform = 'translate3d(0,' + translate + 'px,0) rotateY(' + ry.toFixed(2) + 'deg) rotateX(' + rx.toFixed(2) + 'deg) scale(' + scale + ')';
    heroFrame.style.setProperty('--glare', (0.25 + Math.min(1, (Math.abs(ry) + Math.abs(rx)) / 12) * 0.6).toFixed(2));
  }
  if (heroFrame && !reduceMotion && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    var heroArt = heroFrame.parentElement;
    var pointerTick = false;
    heroArt.addEventListener('pointermove', function (e) {
      var r = heroArt.getBoundingClientRect();
      pointerX = ((e.clientX - r.left) / r.width - 0.5) * 2;
      pointerY = ((e.clientY - r.top) / r.height - 0.5) * 2;
      if (!pointerTick) { pointerTick = true; requestAnimationFrame(function () { pointerTick = false; applyHeroTransform(); }); }
    });
    heroArt.addEventListener('pointerleave', function () { pointerX = 0; pointerY = 0; applyHeroTransform(); });
  }

  function onScroll() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(updateOnScroll);
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  updateOnScroll();

  // ---------- fade/slide-in reveals ----------
  var reveals = document.querySelectorAll('.reveal-up');
  if (reduceMotion || !('IntersectionObserver' in window) || !reveals.length) {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    reveals.forEach(function (el) { revealObserver.observe(el); });
  }

  // ---------- pinned "how it works" scrollytelling ----------
  // Desktop/tablet only (the CSS hides this whole block under 900px and
  // shows a plain stacked fallback instead -- see .feature-fallback).
  // As each text step in the left/right column crosses the vertical center
  // of the viewport, swap the active image in the sticky media panel next
  // to it. No scroll-hijacking: this is plain position:sticky plus an
  // IntersectionObserver, so trackpad/wheel/touch scrolling stays completely
  // native the whole way through.
  var stepEls = document.querySelectorAll('.feature-step');
  var imgEls = document.querySelectorAll('.feature-img');
  var dotEls = document.querySelectorAll('.feature-dot');

  function setActiveStep(index) {
    stepEls.forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.step === String(index));
    });
    imgEls.forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.step === String(index));
    });
    dotEls.forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.dot === String(index));
    });
  }

  // ---------- adaptive nav material over the dark "statement" section ----------
  var statementEl = document.querySelector('.statement');
  if (statementEl && navEl && 'IntersectionObserver' in window) {
    var navDarkObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          navEl.classList.toggle('is-on-dark', entry.isIntersecting);
        });
      },
      // Fires once the section's top has passed under the (64px-tall) nav,
      // not as soon as any sliver of it enters the viewport.
      { threshold: 0, rootMargin: '-64px 0px -85% 0px' }
    );
    navDarkObserver.observe(statementEl);
  }

  if (stepEls.length && 'IntersectionObserver' in window) {
    var stepObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) setActiveStep(entry.target.dataset.step);
        });
      },
      // A thin horizontal band right at the viewport's vertical center --
      // whichever step's block is crossing that band becomes active,
      // matching what the sticky media panel is vertically level with.
      { threshold: 0, rootMargin: '-45% 0px -45% 0px' }
    );
    stepEls.forEach(function (el) { stepObserver.observe(el); });
  }
  // ---------- hero clip: load after the page, pause when off-screen ----------
  var heroVideo = document.getElementById('heroVideo');
  // Phones get a cropped clip that follows the action (and its matching
  // poster, swapped in straight away so the first paint already fits).
  var phoneClip = heroVideo && window.matchMedia('(max-width: 860px)').matches;
  if (phoneClip) {
    heroVideo.setAttribute('poster', heroVideo.dataset.posterMobile);
    heroVideo.dataset.src = heroVideo.dataset.srcMobile;
    heroVideo.dataset.srcWebm = heroVideo.dataset.srcMobileWebm;
  }
  if (heroVideo && !reduceMotion) {
    var startVideo = function () {
      if (heroVideo.getAttribute('src')) return;
      // H.264 where supported (Safari, Chrome, Edge); VP9 WebM otherwise.
      var mp4 = heroVideo.canPlayType('video/mp4; codecs="avc1.640028"');
      heroVideo.setAttribute('src', mp4 ? heroVideo.dataset.src : heroVideo.dataset.srcWebm);
      var p = heroVideo.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked: the poster stays, which is fine */ });
    };
    if (document.readyState === 'complete') setTimeout(startVideo, 150);
    else window.addEventListener('load', function () { setTimeout(startVideo, 150); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!heroVideo.getAttribute('src')) return;
          if (entry.isIntersecting) { var p = heroVideo.play(); if (p && p.catch) p.catch(function () {}); }
          else heroVideo.pause();
        });
      }, { threshold: 0.1 }).observe(heroVideo);
    }
  }

  // ---------- export section: the Markdown window types itself out ----------
  var mdWindow = document.getElementById('mdWindow');
  var mdBody = document.getElementById('mdBody');
  if (mdWindow && mdBody && !reduceMotion && 'IntersectionObserver' in window) {
    // Snapshot the real content as [class, text] runs, then replay it.
    var runs = [];
    mdBody.childNodes.forEach(function (n) {
      runs.push([n.nodeType === 1 ? n.className : '', n.textContent]);
    });
    var total = runs.reduce(function (a, r) { return a + r[1].length; }, 0);
    var render = function (count) {
      var html = '', left = count;
      for (var i = 0; i < runs.length && left > 0; i++) {
        var txt = runs[i][1].slice(0, left);
        left -= txt.length;
        txt = txt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html += runs[i][0] ? '<span class="' + runs[i][0] + '">' + txt + '</span>' : txt;
      }
      mdBody.innerHTML = html + (count < total ? '<span class="md-caret"></span>' : '');
    };
    var typed = false;
    var mdObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || typed) return;
        typed = true;
        mdObserver.disconnect();
        mdWindow.classList.add('is-typing');
        var start = null, dur = 2200;
        var step = function (ts) {
          if (start === null) start = ts;
          var k = Math.min(1, (ts - start) / dur);
          render(Math.round(k * total));
          if (k < 1) requestAnimationFrame(step);
          else { mdWindow.classList.remove('is-typing'); mdWindow.classList.add('is-done'); }
        };
        requestAnimationFrame(step);
      });
    }, { threshold: 0.35 });
    // Only blank it once we know the observer will run, so a failed script
    // never leaves the window empty.
    // Lock the finished height first, so typing never pushes the page around.
    mdBody.style.minHeight = mdBody.offsetHeight + 'px';
    render(0);
    mdObserver.observe(mdWindow);
  }
})();
