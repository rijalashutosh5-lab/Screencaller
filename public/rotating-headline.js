/**
 * RotatingHeadline — a static prefix + a vertically rotating, cross-fading suffix.
 *
 * Vanilla JS (no framework/build step, matching this project's stack). Call it as
 * a factory with an options object standing in for "props":
 *
 *   RotatingHeadline(mountEl, {
 *     staticText: 'Build',
 *     phrases: ['audio surveys', 'user research', ...],
 *     holdMs: 2200,        // how long each phrase rests before transitioning
 *     transitionMs: 600    // slide/fade duration
 *   });
 *
 * Accessibility: the animated nodes are aria-hidden; a visually-hidden aria-live
 * region announces one clean "prefix + phrase" per rotation. Honors
 * prefers-reduced-motion by degrading to a plain opacity cross-fade.
 *
 * Returns { destroy() } to stop timers and detach listeners (reusable/cleanup).
 */
function RotatingHeadline(mountEl, options) {
  const opts = options || {};
  const staticText = opts.staticText || '';
  const phrases = (opts.phrases && opts.phrases.length) ? opts.phrases.slice() : [''];
  const holdMs = opts.holdMs != null ? opts.holdMs : 2200;
  const transitionMs = opts.transitionMs != null ? opts.transitionMs : 600;

  // --- build DOM ---
  mountEl.classList.add('rh');
  mountEl.innerHTML = '';

  const staticEl = document.createElement('span');
  staticEl.className = 'rh-static';
  staticEl.textContent = staticText ? staticText + ' ' : '';

  const viewport = document.createElement('span');
  viewport.className = 'rh-viewport';
  viewport.setAttribute('aria-hidden', 'true');

  // Two stacked items we alternate between: one visible, one incoming.
  const itemA = document.createElement('span');
  const itemB = document.createElement('span');
  itemA.className = itemB.className = 'rh-item';
  viewport.appendChild(itemA);
  viewport.appendChild(itemB);

  // Visually-hidden live region — screen readers get one announcement per phrase.
  const live = document.createElement('span');
  live.className = 'visually-hidden';
  live.setAttribute('aria-live', 'polite');

  mountEl.appendChild(staticEl);
  mountEl.appendChild(viewport);
  mountEl.appendChild(live);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // --- sizing ---
  // Measure the widest phrase at the current font, then (a) shrink the font if
  // that phrase can't fit the container, so the suffix never clips horizontally,
  // and (b) pin the viewport min-width to the widest phrase so short phrases
  // don't make the layout reflow/jump between rotations.
  const MIN_FONT = 16;

  function widestAt() {
    const probe = document.createElement('span');
    probe.className = 'rh-item';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'nowrap';
    viewport.appendChild(probe);
    let max = 0;
    for (const p of phrases) {
      probe.textContent = p;
      max = Math.max(max, probe.getBoundingClientRect().width);
    }
    viewport.removeChild(probe);
    return max;
  }

  // Box width the viewport needs for a phrase of the given text width: add a
  // trailing buffer (~0.18em) so a glyph's right side-bearing is never clipped
  // by the viewport's overflow:hidden.
  function boxWidth(textWidth, font) { return textWidth + font * 0.18 + 2; }

  function measureAndSize() {
    // Start from the CSS-defined (responsive clamp) font size each time.
    mountEl.style.fontSize = '';
    let font = parseFloat(getComputedStyle(mountEl).fontSize) || 32;
    const available = mountEl.clientWidth - 4;

    let widest = widestAt();
    // Shrink to fit the container: one proportional step, then trim by 1px to
    // absorb sub-pixel rounding (getBoundingClientRect vs. actual layout).
    if (available > 0 && boxWidth(widest, font) > available) {
      font = Math.max(MIN_FONT, Math.floor(font * (available / boxWidth(widest, font))));
      mountEl.style.fontSize = font + 'px';
      widest = widestAt();
      let guard = 0;
      while (boxWidth(widest, font) > available && font > MIN_FONT && guard++ < 16) {
        font -= 1;
        mountEl.style.fontSize = font + 'px';
        widest = widestAt();
      }
    }
    viewport.style.minWidth = Math.ceil(boxWidth(widest, font)) + 'px';
  }

  // --- rotation state ---
  let index = 0;
  let current = itemA;   // currently-visible item
  let next = itemB;      // incoming item
  let holdTimer = null;
  let rafId = 0;

  function setActiveText(idx) {
    current.textContent = phrases[idx];
    current.style.transition = 'none';
    current.style.transform = 'translateY(0)';
    current.style.opacity = '1';
    next.style.opacity = '0';
    live.textContent = (staticText ? staticText + ' ' : '') + phrases[idx];
  }

  function transitionTo(idx) {
    const reduced = reduceMotion.matches;
    next.textContent = phrases[idx];
    next.style.transition = 'none';

    if (reduced) {
      // Opacity-only cross-fade, no vertical movement.
      next.style.transform = 'translateY(0)';
      next.style.opacity = '0';
    } else {
      next.style.transform = 'translateY(100%)';
      next.style.opacity = '0';
    }

    // Force a reflow so the "from" state is committed before we transition.
    void next.offsetHeight;

    const ease = `transform ${transitionMs}ms ease-in-out, opacity ${transitionMs}ms ease-in-out`;
    current.style.transition = ease;
    next.style.transition = ease;

    rafId = requestAnimationFrame(() => {
      if (reduced) {
        current.style.opacity = '0';
        next.style.opacity = '1';
      } else {
        current.style.transform = 'translateY(-100%)';
        current.style.opacity = '0';
        next.style.transform = 'translateY(0)';
        next.style.opacity = '1';
      }
      live.textContent = (staticText ? staticText + ' ' : '') + phrases[idx];
    });

    // After the transition, swap roles: incoming becomes current.
    holdTimer = setTimeout(() => {
      const tmp = current; current = next; next = tmp;
      scheduleNext();
    }, transitionMs);
  }

  function scheduleNext() {
    holdTimer = setTimeout(() => {
      index = (index + 1) % phrases.length;
      transitionTo(index);
    }, holdMs);
  }

  function start() {
    measureAndSize();
    setActiveText(index);
    if (phrases.length > 1) scheduleNext();
  }

  // Recompute width on resize (font-size is responsive via clamp()).
  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measureAndSize, 150);
  }
  window.addEventListener('resize', onResize);

  // If the reduced-motion preference flips mid-session, just reset cleanly.
  function onMotionChange() {
    clearTimeout(holdTimer);
    cancelAnimationFrame(rafId);
    setActiveText(index);
    if (phrases.length > 1) scheduleNext();
  }
  // addEventListener on MediaQueryList (with older addListener fallback).
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionChange);
  else if (reduceMotion.addListener) reduceMotion.addListener(onMotionChange);

  start();

  return {
    destroy() {
      clearTimeout(holdTimer);
      clearTimeout(resizeTimer);
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      if (reduceMotion.removeEventListener) reduceMotion.removeEventListener('change', onMotionChange);
      else if (reduceMotion.removeListener) reduceMotion.removeListener(onMotionChange);
    }
  };
}
