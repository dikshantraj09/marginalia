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
      var t = Math.min(1, scrollTop / (heroH * 1.1));
      var translate = t * 36; // px
      var scale = 1 - t * 0.035;
      heroFrame.style.transform = 'translate3d(0,' + translate + 'px,0) scale(' + scale + ')';
    }
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
})();
