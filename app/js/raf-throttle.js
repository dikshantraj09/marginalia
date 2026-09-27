// Shared by pdfview.js (pinch-zoom) and canvas.js (pinch-zoom + card-drag
// link redraw): all three had the same shape of fix for the same root
// cause — a touch gesture delivering several pointermove events per
// animation frame, each doing real layout work (CSS `zoom`, or an SVG
// rebuild that reads offsetHeight), which is more work than the screen can
// actually show. Coalescing to one call per frame fixes all three; this is
// that coalescing, written once.
//
// Returns a { call(), cancel() } pair rather than a single throttled
// function, because every caller here also needs to cancel a pending frame
// early (a pinch ending on finger-lift, a card drag ending on pointerup) —
// a plain "trailing-edge" throttle wouldn't expose that.
export function rafThrottle(fn) {
  let handle = null;
  return {
    // Schedules fn to run on the next animation frame, coalescing any
    // number of calls within that frame into the one run. fn receives no
    // arguments — callers read whatever state they need (finger positions,
    // card coordinates) from their own closure at the time the frame
    // actually runs, not at schedule time, which is what makes the
    // coalescing correct: a late-scheduled call still sees the latest
    // state, not a stale snapshot from whenever call() first fired.
    call() {
      if (handle !== null) return;
      handle = requestAnimationFrame(() => {
        handle = null;
        fn();
      });
    },
    // Drops a pending frame without running fn. Safe to call whether or
    // not a frame is currently pending.
    cancel() {
      if (handle === null) return;
      cancelAnimationFrame(handle);
      handle = null;
    },
    get pending() {
      return handle !== null;
    },
  };
}
