/* =========================================================
   Magazine — La Forêt s'expose
   Script navigateur, léger et sans dépendance.

   Filtres par rubrique sur la page « Tous les articles » :
   - Sans JavaScript, chaque filtre est un vrai lien vers la page de la
     rubrique : tout reste accessible et indexable.
   - Avec JavaScript, un clic filtre sur place à partir de
     magazine-index.json (tous les articles, toutes pages confondues),
     sans recharger la page.

   L'automatisation (création d'articles, sitemap, flux, index) est dans
   scripts/magazine.mjs, exécuté par Node et non par le navigateur.
   ========================================================= */
(function () {
  'use strict';

  var nav = document.querySelector('[data-filtres]');
  var liste = document.querySelector('[data-liste]');
  if (!nav || !liste) return; // pas de filtre dynamique sur cette page

  var etat = document.querySelector('[data-filtres-etat]');
  var pagination = document.querySelector('[data-pagination]');
  var contenuInitial = liste.innerHTML;
  var index = null;

  var ICONS = {
    feuille: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5 19 14 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    arbre: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3 5 13h4l-3 5h12l-3-5h4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 18v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    cercle: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    pousse: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21v-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 12c0-4-3-6-7-6 0 4 3 6 7 6Zm0-2c0-4 3-6 7-6 0 4-3 6-7 6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Même balisage que la fonction card() de scripts/magazine.mjs.
  function carte(a, rubriques) {
    var r = rubriques[a.rubrique] || {};
    var ic = ICONS[r.icon] || ICONS.cercle;
    var visuel = a.hasImage
      ? '<img class="carte-visuel" src="' + esc(a.image) + '" alt="' + esc(a.imageAlt) + '" loading="lazy" width="1200" height="630">'
      : '<div class="carte-visuel carte-visuel--motif" data-rubrique="' + esc(a.rubrique) + '" aria-hidden="true">' + ic + '</div>';
    return '<article class="carte" data-rubrique="' + esc(a.rubrique) + '">' +
      '<a class="carte-lien" href="' + esc(a.path) + '">' + visuel +
      '<div class="carte-texte">' +
      '<p class="carte-rubrique"><span class="mag-icone">' + ic + '</span>' + esc(a.rubriqueNom) + '</p>' +
      '<h2 class="carte-titre">' + esc(a.titre) + '</h2>' +
      '<p class="carte-chapeau">' + esc(a.chapeau) + '</p>' +
      '<p class="carte-meta"><time datetime="' + esc(a.date) + '">' + esc(a.dateTexte) + '</time> · ' + a.lecture + ' min</p>' +
      '</div></a></article>';
  }

  function chargerIndex() {
    if (index) return Promise.resolve(index);
    return fetch('/magazine/magazine-index.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) { index = data; return data; });
  }

  function activer(lien) {
    nav.querySelectorAll('a').forEach(function (a) { a.removeAttribute('aria-current'); });
    lien.setAttribute('aria-current', 'true');
  }

  nav.addEventListener('click', function (e) {
    var lien = e.target.closest('a[data-filtre]');
    if (!lien) return;
    // Ctrl/Cmd-clic : on laisse le navigateur ouvrir la page de rubrique.
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    var filtre = lien.getAttribute('data-filtre');
    activer(lien);

    if (filtre === 'toutes') {
      liste.innerHTML = contenuInitial;
      if (pagination) pagination.hidden = false;
      if (etat) etat.textContent = '';
      return;
    }

    chargerIndex().then(function (data) {
      var rubriques = {};
      data.rubriques.forEach(function (r) { rubriques[r.slug] = r; });
      var choix = data.articles.filter(function (a) { return a.rubrique === filtre; });
      liste.innerHTML = choix.length
        ? choix.map(function (a) { return carte(a, rubriques); }).join('')
        : '<p class="mag-vide">Pas encore d\'article dans cette rubrique.</p>';
      if (pagination) pagination.hidden = true;
      if (etat) etat.textContent = choix.length + ' article' + (choix.length > 1 ? 's' : '') +
        ' dans « ' + (rubriques[filtre] ? rubriques[filtre].name : filtre) + ' »';
    }).catch(function () {
      // En cas d'échec (hors ligne…), on suit simplement le lien.
      window.location.href = lien.href;
    });
  });
})();
