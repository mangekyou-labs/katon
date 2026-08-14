/* TrustRFQ landing — reveal on scroll + pointer parallax on the ticket stack.
   Plain external script: the CSP has no 'unsafe-inline' in script-src.

   FAIL VISIBLE. The hidden state in hero.css is gated on `.lp-js`, which this
   file puts on <html>. If the script 404s, throws, or is blocked, the class is
   never set, nothing is ever hidden, and the page renders in full. A landing
   page that fails visible is a page; one that fails invisible is an outage.
   That is also why this runs render-blocking in <head> rather than deferred —
   deferred, the browser can paint the content before the class lands, and you
   see a flash of the page hiding itself. */
(() => {
  'use strict';

  const root = document.documentElement;

  /* PREVIEW FLAG. `?motion=on` forces the page to animate even where the OS asks for
     reduced motion. It exists because there is otherwise no way to SEE this page move
     on a machine with Reduce Motion enabled system-wide — a media query cannot be
     overridden from script, so the choice would be "change your OS settings" or
     "never look at it". Opt-in, per URL: nobody reaches it by accident, and the
     default behaviour for every real visitor is untouched. */
  const forced = new URLSearchParams(window.location.search).get('motion') === 'on';
  if (forced) root.classList.add('lp-motion');   // exempts the CSS kill switch

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches && !forced;
  const canObserve = 'IntersectionObserver' in window;

  // Only arm the hidden state if we can actually un-hide it again.
  if (!reduced && canObserve) root.classList.add('lp-js');

  /* The tickets each carry their own transform, and the parallax feeds in
     through --lp-mx / --lp-my rather than a wrapper transform. That is
     deliberate: a transformed *ancestor* becomes the backdrop root, so the
     tickets' backdrop-filter would sample nothing and render empty. */
  const parallax = () => {
    const deal = document.querySelector('.lp-deal');
    if (!deal || reduced) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    let frame = 0;

    const track = (event) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const box = deal.getBoundingClientRect();
        const x = (event.clientX - (box.left + box.width / 2)) / box.width;
        const y = (event.clientY - (box.top + box.height / 2)) / box.height;
        deal.style.setProperty('--lp-mx', (x * 14).toFixed(2));
        deal.style.setProperty('--lp-my', (y * 10).toFixed(2));
      });
    };

    const rest = () => {
      deal.style.setProperty('--lp-mx', '0');
      deal.style.setProperty('--lp-my', '0');
    };

    window.addEventListener('pointermove', track, { passive: true });
    window.addEventListener('pointerleave', rest);
    window.addEventListener('blur', rest);
  };

  /* THE NAV'S ONE BIT OF STATE.
     Everything the capsule does is CSS; the script's whole job is to say whether
     the page has left the top. It runs unconditionally — not behind `lp-js`, not
     behind reduced-motion — because `is-stuck` is not an animation, it is the
     nav's material. With Reduce Motion on, the same two states still apply; the
     kill switch in hero.css simply cuts the transition between them.

     rAF-throttled, and only touched when the answer actually changes, so a fling
     down the page costs one class write, not one per scroll event. */
  const capsule = () => {
    const bar = document.querySelector('.lp-topbar');
    if (!bar) return;

    let frame = 0;
    let stuck = null;

    const sync = () => {
      frame = 0;
      const next = window.scrollY > 6;
      if (next === stuck) return;
      stuck = next;
      bar.classList.toggle('is-stuck', next);
    };

    window.addEventListener('scroll', () => {
      if (!frame) frame = window.requestAnimationFrame(sync);
    }, { passive: true });

    sync();   // reloading mid-page must land in the right state, not animate into it
  };

  /* Watch a set, add `is-in` once, stop watching. */
  const watch = (nodes, options) => {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, options);
    nodes.forEach((el) => io.observe(el));
  };

  /* THE TYPEWRITER.
     Text on the problem section is not faded in, it is TYPED — as if someone were at
     a keyboard while you watch.

     Two things make this safe rather than clever:

     · It never invents the schedule. The delays all live in CSS (--lp-lead-in, --lp-row),
       and a duplicate copy of them here would drift the first time either is touched.
       So nothing is scheduled: each element is typed when ITS OWN reveal begins, caught
       via animationstart / transitionstart. CSS stays the single source of timing.
     · It fails visible. The full text ships in the HTML and is only lifted out at the
       moment typing starts. Script blocked, script broken, motion reduced — the words
       are simply there, whole.

     minWidth/minHeight are pinned from the element's real box before it is emptied.
     Without that, the pill collapses to nothing and the two-line headline reflows the
     page under the reader as each line fills. */
  const typeOut = (el) => {
    if (el.dataset.lpTyped) return;
    el.dataset.lpTyped = '1';

    const text = el.textContent;
    if (!text.trim()) return;

    const box = el.getBoundingClientRect();
    el.style.minWidth = Math.ceil(box.width) + 'px';
    el.style.minHeight = Math.ceil(box.height) + 'px';
    el.textContent = '';
    el.classList.add('is-typing');

    /* ms per character. The default lets long strings type faster, so a headline does
       not outstay a two-word eyebrow — but any element can override it with
       data-lp-speed when its pace is a deliberate choice rather than a fallout of its
       length. The headline does exactly that: it is the sentence the whole section
       rests on, and it earns being typed slowly enough to read as it lands. */
    const speed = Number(el.dataset.lpSpeed) || Math.max(16, Math.min(48, 1100 / text.length));
    let i = 0;

    const tick = () => {
      el.textContent = text.slice(0, ++i);
      if (i < text.length) { window.setTimeout(tick, speed); return; }
      el.classList.remove('is-typing');
      el.style.minWidth = '';
      el.style.minHeight = '';
    };
    window.setTimeout(tick, 40);
  };

  const typewriter = () => {
    if (reduced) return;

    // The reveal that fires is on the CELL; the text to type may be a span inside it.
    const target = (node) => {
      if (!(node instanceof Element)) return null;
      if (node.classList.contains('lp-type')) return node;
      return node.querySelector(':scope > .lp-type');
    };

    const onBegin = (event) => {
      const el = target(event.target);
      if (el) typeOut(el);
    };

    // the ladder's values reveal via animation; the eyebrow and headline via transition
    document.addEventListener('animationstart', onBegin);
    document.addEventListener('transitionstart', onBegin);
  };

  const start = () => {
    capsule();   // before the lp-js gate: the nav is chrome, not choreography

    const revealables = document.querySelectorAll('.lp-reveal, .lp-deal');
    /* The ladder has NO hidden state of its own — the card is already on the page.
       `is-in` only starts its rows dealing (see the ladder block in hero.css §12). */
    const ladders = document.querySelectorAll('.lp-ladder');
    const firstBeat = document.querySelector('#why .lp-eyebrow');

    const showAll = () => {
      revealables.forEach((el) => el.classList.add('is-in'));
      ladders.forEach((el) => el.classList.add('is-in'));
    };

    if (!root.classList.contains('lp-js')) {
      showAll();
      return;
    }

    watch(revealables, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });

    /* THE FILM'S CLOCK IS THE EYEBROW'S CLOCK.
       Every delay on this section — the eyebrow's 200ms, the headline's 900ms, the
       table's --lp-lead-in — is measured from one instant, so all three must be counted
       from the SAME zero. That zero is the eyebrow's reveal: the film's first beat.

       Hence the observer below is aimed at the eyebrow and uses the IDENTICAL options
       to the reveal watcher above. Two other anchors were tried and both are wrong:
       · The CARD. Scrolling by hand, the card appears seconds after the headline does,
         so the table would count its lead-in from a zero far in the future and the
         numbers would land long after the sentence they answer.
       · The SECTION. It starts intersecting when its top edge merely peeks above the
         fold — while the eyebrow and headline are still off-screen and have not
         revealed at all. The clock then starts BEFORE the first beat, and the rows
         overtake the sentence. Measured: rows arriving 1.45s ahead of the headline. */
    if (firstBeat && ladders.length) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          ladders.forEach((el) => el.classList.add('is-in'));
          io.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });
      io.observe(firstBeat);
    }

    /* Failsafe, if the observer never fires. It must NOT blanket-reveal the ladder:
       a reader still on the hero at 3s would have the whole sequence play out below
       the fold and arrive to a table that has already finished dealing. So the timer
       asks first whether the observer is alive — by 3s the hero's own revealables are
       long past their threshold, and if not one of them carries `is-in`, nothing is
       listening and the ladder must show its numbers or show nothing at all. */
    window.setTimeout(() => {
      const observerAlive = [...revealables].some((el) => el.classList.contains('is-in'));
      revealables.forEach((el) => el.classList.add('is-in'));
      if (!observerAlive) ladders.forEach((el) => el.classList.add('is-in'));
    }, 3000);

    parallax();
    typewriter();   // must be armed BEFORE anything reveals, or its first beat is missed
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
