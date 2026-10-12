/* ---------------------------------------------------------------------------
   KAIRO 1980 — language: detection, memory, direction, and the switch itself
   ---------------------------------------------------------------------------
   Loaded first and shared by every page, including the legal ones, so there is
   exactly one implementation of "what language is this and how is it applied".

   How a language is chosen, in order:

     1. ?lang=de|en|ar in the URL — an explicit, shareable link wins.
     2. A choice the visitor made here before, from localStorage.
     3. The browser's own language list (navigator.languages), which is what
        Windows, macOS, Android and iOS all feed from the system setting.
     4. German.

   Detection NEVER overrides a stored choice: once someone has pressed a
   language button, that is the answer on every later visit, whatever their
   phone says. Nothing is stored until they press it — an automatic detection
   writes nothing, which is also what keeps this free of consent obligations
   under § 25 TTDSG: the only value ever stored is one the visitor asked for.

   Translation lives in the markup, not here. An element carries the text for
   all three languages and this file swaps it:

     <span class="t" data-de="…" data-en="…" data-ar="…">
     <meta class="t" data-t="content" data-de="…">   -> writes the attribute
     <a class="t" data-de-href="…">                  -> per-language target

   Brand names, the domain, e-mail addresses, WhatsApp links, Instagram and
   every technical identifier are deliberately NOT translatable: they carry no
   data-* attributes and are therefore never touched, in any language.
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  var SUPPORTED = ['de', 'en', 'ar'];
  var FALLBACK = 'de';
  var STORAGE_KEY = 'kairo.lang';
  var RTL = ['ar'];

  // Attributes a .t element may target instead of its text content.
  var ATTR_TARGETS = ['content', 'aria-label', 'placeholder', 'alt', 'title'];

  // data-t="html" is for legal prose only, where a sentence contains a link or
  // a <strong> and splitting it into fragments would make the translation
  // unreadable and the German unmaintainable. The values come from this site's
  // own markup — never from a URL, a form or anything a visitor can influence —
  // so this is the same trust level as the rest of the static HTML.
  var HTML_TARGET = 'html';

  function normalise(tag) {
    var base = String(tag || '').toLowerCase().replace('_', '-').split('-')[0];
    return SUPPORTED.indexOf(base) !== -1 ? base : null;
  }

  function stored() {
    try { return normalise(localStorage.getItem(STORAGE_KEY)); } catch (e) { return null; }
  }

  function remember(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* private mode */ }
  }

  function fromQuery() {
    var match = /[?&]lang=([A-Za-z_-]+)/.exec(location.search);
    return match ? normalise(match[1]) : null;
  }

  // navigator.languages is the ordered list the visitor actually configured;
  // navigator.language alone misses "English first, German second" setups.
  function fromBrowser() {
    var list = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || navigator.userLanguage];
    for (var i = 0; i < list.length; i++) {
      var hit = normalise(list[i]);
      if (hit) return hit;
    }
    return null;
  }

  var current = FALLBACK;

  function isRtl(lang) {
    return RTL.indexOf(lang) !== -1;
  }

  /* --- applying ----------------------------------------------------------- */

  function paintElements(lang) {
      var island = document.getElementById('kairoLive');
      var live = {};
      try { live = island ? JSON.parse(island.textContent) : {}; } catch (e) {}
      var pickup = (live.serviceMode || ((window.KAIRO_CONFIG || {}).service || {}).mode) === 'pickup';
    var nodes = document.querySelectorAll('.t');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var value = pickup ? el.getAttribute('data-pickup-' + lang) : null;
      if (value === null) value = el.getAttribute('data-' + lang);
      if (value !== null) {
        var target = el.getAttribute('data-t');
        if (target === HTML_TARGET) el.innerHTML = value;
        else if (target && ATTR_TARGETS.indexOf(target) !== -1) el.setAttribute(target, value);
        else el.textContent = value;
      }
      // A link may also carry a per-language target — the WhatsApp buttons
      // prefill their message in the language the visitor is reading.
      var href = pickup ? el.getAttribute('data-pickup-href') : null;
      if (!href) href = el.getAttribute('data-' + lang + '-href');
      if (href) el.setAttribute('href', href);
    }
  }

  /* One canonical per language variant, matching the hreflang set in <head>.
     German is the site's default and keeps the bare URL.

     The base is the page's OWN canonical href, read once here before this
     function has ever rewritten it. It used to come from a data-base attribute
     whose fallback was the homepage, which meant any page that did not carry
     the attribute — impressum and datenschutz never did — declared the homepage
     as its canonical the moment this script ran, asking Google to drop it as a
     duplicate of a page it has nothing to do with. A page's canonical URL is
     already written in its markup exactly once; reading it from there is what
     makes that class of bug impossible rather than merely fixed. */
  var canonicalBase = null;

  /* The language named in the CURRENT URL — nothing else.

     The invariant is that the canonical mirrors the URL. Detection may change
     what is displayed; only something that changes the URL may change the
     canonical, and in this file that is updateUrl() alone.

     It used to follow the language being DISPLAYED, which is chosen from
     navigator.languages when the URL says nothing. Googlebot renders in
     English — so it fetched https://kairo1980.de/, was handed a page claiming
     its canonical was https://kairo1980.de/?lang=en, and reasonably concluded
     the two were duplicates and that we had nominated the other one. Search
     Console reported "Duplicate, Google chose different canonical than user"
     and the homepage fell out of the index on 13 June 2026: indexed pages went
     from 2 to 1 and stayed there.

     The static markup was right the whole time, and so was the sitemap and the
     hreflang set. This script overwrote all three a moment after load. */
  var urlLang = null;

  function paintCanonical() {
    var link = document.querySelector('link[rel="canonical"]');
    if (!link) return;
    if (canonicalBase === null) canonicalBase = link.getAttribute('href') || '';
    if (!canonicalBase) return;
    link.setAttribute('href',
      (urlLang && urlLang !== FALLBACK)
        ? canonicalBase + '?lang=' + urlLang
        : canonicalBase);
  }

  function paintSwitcher(lang) {
    var buttons = document.querySelectorAll('[data-action="lang"]');
    for (var i = 0; i < buttons.length; i++) {
      var isCurrent = buttons[i].getAttribute('data-lang') === lang;
      buttons[i].classList.toggle('active', isCurrent);
      // The switch is a set of choices, one of which is in effect: that is
      // aria-pressed, not aria-current, and it is what a screen reader needs
      // to announce the active language at all.
      buttons[i].setAttribute('aria-pressed', String(isCurrent));
    }
  }

  function apply(lang) {
    current = lang;
    var root = document.documentElement;
    root.setAttribute('lang', lang);
    root.setAttribute('dir', isRtl(lang) ? 'rtl' : 'ltr');

    paintElements(lang);
    paintCanonical();
    paintSwitcher(lang);

    // order.js repaints the hours, the basket and every generated string; the
    // page chrome in app.js repaints the reviews.
    document.dispatchEvent(new CustomEvent('kairo:lang', { detail: lang }));
  }

  // A manual switch is a decision: it is remembered, and it is written into the
  // address bar so the page the visitor is reading is the page they can share.
  function set(lang) {
    lang = normalise(lang) || FALLBACK;
    if (lang === current) return;
    remember(lang);
    apply(lang);
    updateUrl(lang);
  }

  /* The one place the URL changes, and therefore the one place the canonical
     may change with it. Pressing a language button rewrites both together; a
     browser merely PREFERRING a language rewrites neither. */
  function updateUrl(lang) {
    if (!window.history || !history.replaceState) return;
    var url = location.pathname + (lang === FALLBACK ? '' : '?lang=' + lang) + location.hash;
    try { history.replaceState(null, '', url); } catch (e) { /* file:// */ }
    urlLang = (lang === FALLBACK) ? null : lang;
    paintCanonical();
  }

  /* --- boot --------------------------------------------------------------- */

  var linked = fromQuery();
  // What the URL says at load. Read before anything can rewrite it.
  urlLang = linked;
  var chosen = stored();
  var initial = linked || chosen || fromBrowser() || FALLBACK;

  // A shared ?lang= link is honoured, but it does not silently overwrite a
  // preference this visitor set themselves. It only becomes their preference
  // if they had none.
  if (linked && !chosen) remember(linked);

  window.KairoLang = {
    supported: SUPPORTED.slice(),
    fallback: FALLBACK,
    get current() { return current; },
    isRtl: function (lang) { return isRtl(lang || current); },
    set: set,
    refresh: function () { paintElements(current); }
  };

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-action="lang"]');
    if (btn) set(btn.getAttribute('data-lang'));
  });

  // Applied as soon as this file runs — before order.js renders anything and
  // before first paint of the body, so no visitor sees German text flip to
  // Arabic. The elements exist because this script is deferred.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(initial); });
  } else {
    apply(initial);
  }
})();
