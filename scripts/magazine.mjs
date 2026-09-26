#!/usr/bin/env node
/**
 * Générateur du Magazine — La Forêt s'expose
 * ------------------------------------------------------------------
 * Aucune dépendance : Node 18 ou plus suffit.
 *
 *   node scripts/magazine.mjs build
 *       Regénère tout le Magazine depuis les articles Markdown :
 *       pages HTML, magazine-index.json, feed.json, feed.xml (RSS),
 *       sitemap-magazine.xml et la section Magazine de llms.txt.
 *
 *   node scripts/magazine.mjs new "Titre de l'article" [--rubrique slug] [--date AAAA-MM-JJ]
 *       Crée un brouillon à partir du modèle dans magazine/_src/brouillons/.
 *
 *   node scripts/magazine.mjs publish [--date AAAA-MM-JJ]
 *       Publie les brouillons « statut: pret » dont la date est atteinte
 *       (au maximum publication.articlesPerRun), puis lance build.
 *       C'est la commande appelée par la tâche planifiée (cron, GitHub Actions…).
 *
 * Toute la configuration est dans magazine/magazine-config.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'magazine/magazine-config.json'), 'utf8'));
const SITE = CONFIG.site.url.replace(/\/$/, '');
const MAG = CONFIG.magazine.path;                       // « /magazine/ »
const OUT = path.join(ROOT, CONFIG.paths.output);       // dossier magazine/
const SRC = path.join(ROOT, CONFIG.paths.sources);
const DRAFTS = path.join(ROOT, CONFIG.paths.drafts);
const RUBRIQUES = CONFIG.rubriques;
const rubrique = slug => RUBRIQUES.find(r => r.slug === slug);

/* =========================================================
   Utilitaires
   ========================================================= */

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const slugify = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const abs = p => p.startsWith('http') ? p : SITE + p;

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: CONFIG.publication.timezone });

const dateFr = d => new Date(d + 'T12:00:00Z')
  .toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const dateRfc822 = d => new Date(d + 'T08:00:00Z').toUTCString();

// JSON pour <script type="application/ld+json"> : on neutralise « </ ».
const jsonLd = obj => JSON.stringify(obj, null, 2).replace(/<\//g, '<\\/');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

/* =========================================================
   Lecture des articles (front matter + Markdown)
   ========================================================= */

function parseFrontMatter(text, file) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file} : en-tête « --- » manquant.`);
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: m[2].trim() };
}

// Markdown volontairement simple : suffisant pour des articles éditoriaux.
function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const ext = /^https?:/.test(u) && !u.startsWith(SITE);
      return `<a href="${u}"${ext ? ' rel="noopener"' : ''}>${t}</a>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

function markdown(md) {
  const headings = [];
  const html = md.split(/\r?\n\s*\r?\n/).map(block => {
    const b = block.trim();
    let m;
    if ((m = b.match(/^(#{2,3})\s+(.+)$/))) {
      const level = m[1].length, text = m[2].trim(), id = slugify(text);
      headings.push({ level, text, id });
      return `<h${level} id="${id}">${inline(text)}</h${level}>`;
    }
    const lines = b.split(/\r?\n/);
    if (lines.every(l => /^\s*[-*]\s+/.test(l)))
      return '<ul>\n' + lines.map(l => `  <li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('\n') + '\n</ul>';
    if (lines.every(l => /^\s*\d+[.)]\s+/.test(l)))
      return '<ol>\n' + lines.map(l => `  <li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('\n') + '\n</ol>';
    if (lines.every(l => l.startsWith('>')))
      return `<blockquote><p>${inline(lines.map(l => l.replace(/^>\s?/, '')).join(' '))}</p></blockquote>`;
    return `<p>${inline(lines.join(' '))}</p>`;
  }).join('\n');
  return { html, headings };
}

function loadArticle(file) {
  const { data, body } = parseFrontMatter(fs.readFileSync(file, 'utf8'), path.basename(file));
  for (const f of CONFIG.metadata.required)
    if (!data[f]) throw new Error(`${path.basename(file)} : champ obligatoire « ${f} » manquant.`);
  if (!rubrique(data.rubrique))
    throw new Error(`${path.basename(file)} : rubrique inconnue « ${data.rubrique} ».`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date))
    throw new Error(`${path.basename(file)} : date attendue au format AAAA-MM-JJ.`);
  const slug = data.slug || slugify(data.titre);
  const { html, headings } = markdown(body);
  const words = body.replace(/[#>*\-\[\]()]/g, ' ').split(/\s+/).filter(Boolean).length;
  return {
    ...data,
    slug,
    auteur: data.auteur || CONFIG.site.publisher,
    motsCles: (data.mots_cles || '').split(',').map(s => s.trim()).filter(Boolean),
    url: `${MAG}${slug}/`,
    html, headings, words,
    lecture: Math.max(1, Math.round(words / 200)),
    image: data.image || CONFIG.site.defaultImage,
    imageAlt: data.image_alt || data.titre,
    hasImage: Boolean(data.image),
    source: path.relative(ROOT, file).replace(/\\/g, '/'),
  };
}

function loadArticles() {
  if (!fs.existsSync(SRC)) return [];
  const list = fs.readdirSync(SRC).filter(f => f.endsWith('.md')).map(f => loadArticle(path.join(SRC, f)));
  const seen = new Set();
  for (const a of list) {
    if (seen.has(a.slug)) throw new Error(`Deux articles ont le même slug : « ${a.slug} ».`);
    seen.add(a.slug);
  }
  // Ordre chronologique inverse (le plus récent d'abord). À date égale, un article
  // « une: oui » passe devant, puis ordre alphabétique.
  const une = a => (a.une === 'oui' ? 1 : 0);
  return list.sort((a, b) => b.date.localeCompare(a.date) || une(b) - une(a) || a.titre.localeCompare(b.titre, 'fr'));
}

/* =========================================================
   Éléments d'interface partagés
   ========================================================= */

// Icônes simples, dessinées en SVG (feuille, arbre, cercle, pousse).
const ICONS = {
  feuille: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5 19 14 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  arbre: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3 5 13h4l-3 5h12l-3-5h4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 18v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  cercle: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  pousse: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21v-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 12c0-4-3-6-7-6 0 4 3 6 7 6Zm0-2c0-4 3-6 7-6 0 4-3 6-7 6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};
const icon = r => `<span class="mag-icone">${ICONS[r.icon] || ICONS.cercle}</span>`;

const feedLinks = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/icone-512.png" sizes="512x512">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="Magazine La Forêt s'expose (RSS)" href="${MAG}feed.xml">
<link rel="alternate" type="application/feed+json" title="Magazine La Forêt s'expose (JSON Feed)" href="${MAG}feed.json">`;

function header(active) {
  const link = (href, label, key) =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<a class="mag-evitement" href="#contenu">Aller au contenu</a>
<header class="mag-entete">
  <div class="mag-wrap mag-entete-barre">
    <a class="mag-logo" href="/"><img src="/logo-blanc-symbole.png" alt="La Forêt s'expose" width="492" height="400"></a>
    <nav aria-label="Navigation principale">
      ${link(MAG, 'Magazine', 'magazine')}
      ${link(MAG + 'articles/', 'Tous les articles', 'articles')}
      <a href="/#projet">Le projet</a>
      <a href="/#accueillir">J'ai un lieu</a>
      <a href="/#exposer">Je veux exposer</a>
    </nav>
  </div>
  <nav class="mag-rubriques-nav" aria-label="Rubriques du Magazine">
    <div class="mag-wrap">
      ${RUBRIQUES.map(r => link(`${MAG}rubrique/${r.slug}/`, esc(r.name), 'r-' + r.slug)).join('\n      ')}
    </div>
  </nav>
</header>`;
}

const footer = () => `<footer class="mag-pied">
  <div class="mag-wrap">
    <p><strong>La Forêt s'expose</strong>, un projet de l'association Art for Good.<br>
    Association loi 1901, RNA W751271647, 54 rue René Boulanger, 75010 Paris.</p>
    <nav aria-label="Liens du pied de page">
      <a href="/">Accueil</a>
      <a href="${MAG}">Magazine</a>
      <a href="${MAG}articles/">Tous les articles</a>
      <a href="${MAG}feed.xml">Flux RSS</a>
      <a href="${MAG}feed.json">JSON Feed</a>
      <a href="/mentions-legales.html">Mentions légales</a>
    </nav>
  </div>
</footer>`;

// Fil d'Ariane : HTML + objet JSON-LD BreadcrumbList.
function breadcrumb(items) {
  const html = `<nav class="mag-ariane" aria-label="Fil d'Ariane"><ol>${items.map((it, i) =>
    i === items.length - 1
      ? `<li aria-current="page">${esc(it.name)}</li>`
      : `<li><a href="${it.url}">${esc(it.name)}</a></li>`).join('')}</ol></nav>`;
  const ld = {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: abs(it.url) })),
  };
  return { html, ld };
}
const crumbs = (...rest) => [{ name: 'Accueil', url: '/' }, { name: CONFIG.magazine.shortTitle, url: MAG }, ...rest];

// Visuel de rubrique (utilisé quand l'article n'a pas d'image).
const visuel = (a, cls = 'carte-visuel') => {
  const r = rubrique(a.rubrique);
  return a.hasImage
    ? `<img class="${cls}" src="${esc(a.image)}" alt="${esc(a.imageAlt)}" loading="lazy" width="1200" height="630">`
    : `<div class="${cls} ${cls}--motif" data-rubrique="${r.slug}" aria-hidden="true">${ICONS[r.icon]}</div>`;
};

// Carte d'article, réutilisée partout (et reproduite à l'identique par magazine.js).
function card(a, level = 3) {
  const r = rubrique(a.rubrique);
  return `<article class="carte" data-rubrique="${r.slug}">
  <a class="carte-lien" href="${a.url}">
    ${visuel(a)}
    <div class="carte-texte">
      <p class="carte-rubrique">${icon(r)}${esc(r.name)}</p>
      <h${level} class="carte-titre">${esc(a.titre)}</h${level}>
      <p class="carte-chapeau">${esc(a.chapeau)}</p>
      <p class="carte-meta"><time datetime="${a.date}">${dateFr(a.date)}</time> · ${a.lecture} min</p>
    </div>
  </a>
</article>`;
}

const publisherLd = { '@id': CONFIG.site.publisherId };

// Squelette commun aux pages de liste (accueil, rubriques, tous les articles).
function page({ title, description, canonical, active, body, ld, extraHead = '', bodyClass = '' }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${abs(canonical)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta property="og:type" content="website">
<meta property="og:locale" content="fr_FR">
<meta property="og:site_name" content="${esc(CONFIG.site.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${abs(canonical)}">
<meta property="og:image" content="${abs(CONFIG.site.defaultImage)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${abs(CONFIG.site.defaultImage)}">
${feedLinks}
${extraHead}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Young+Serif&family=Public+Sans:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${MAG}magazine.css">
<script type="application/ld+json">${jsonLd({ '@context': 'https://schema.org', '@graph': ld })}</script>
</head>
<body class="${bodyClass}">
${header(active)}
<main id="contenu">
${body}
</main>
${footer()}
<script src="${MAG}magazine.js" defer></script>
</body>
</html>
`;
}

const itemListLd = list => ({
  '@type': 'ItemList',
  numberOfItems: list.length,
  itemListElement: list.map((a, i) => ({ '@type': 'ListItem', position: i + 1, url: abs(a.url), name: a.titre })),
});

/* =========================================================
   Pages
   ========================================================= */

function buildHome(articles) {
  const bc = breadcrumb([{ name: 'Accueil', url: '/' }, { name: CONFIG.magazine.shortTitle, url: MAG }]);
  const [une, ...suite] = articles;
  const enAvant = suite.slice(0, 3);
  const body = `
<section class="mag-intro">
  <div class="mag-wrap">
    ${bc.html}
    <h1>${esc(CONFIG.magazine.title)}</h1>
    <p class="mag-intro-texte">${esc(CONFIG.magazine.intro)}</p>
  </div>
</section>

<section class="mag-section mag-wrap" aria-labelledby="t-rubriques">
  <h2 id="t-rubriques">Les rubriques</h2>
  <ul class="rubriques-grille">
    ${RUBRIQUES.map(r => {
      const n = articles.filter(a => a.rubrique === r.slug).length;
      return `<li class="rubrique-carte" data-rubrique="${r.slug}">
      <a href="${MAG}rubrique/${r.slug}/">
        ${icon(r)}
        <h3>${esc(r.name)}</h3>
        <p>${esc(r.description)}</p>
        <span class="rubrique-compte">${n} article${n > 1 ? 's' : ''}</span>
      </a>
    </li>`;
    }).join('\n    ')}
  </ul>
</section>

${une ? `<section class="mag-section mag-wrap" aria-labelledby="t-une">
  <h2 id="t-une">À la une</h2>
  <div class="carte-une">${card(une, 3)}</div>
</section>` : ''}

${enAvant.length ? `<section class="mag-section mag-wrap" aria-labelledby="t-avant">
  <h2 id="t-avant">Articles récents</h2>
  <div class="cartes-grille">
    ${enAvant.map(a => card(a)).join('\n    ')}
  </div>
</section>` : ''}

<p class="mag-wrap mag-tous"><a class="mag-bouton" href="${MAG}articles/">Tous les articles</a></p>
`;
  const ld = [
    {
      '@type': 'CollectionPage',
      '@id': abs(MAG) + '#page',
      url: abs(MAG),
      name: CONFIG.magazine.title,
      description: CONFIG.magazine.description,
      inLanguage: CONFIG.site.lang,
      isPartOf: { '@id': SITE + '/#site' },
      publisher: publisherLd,
      breadcrumb: bc.ld,
      hasPart: RUBRIQUES.map(r => ({ '@type': 'CollectionPage', name: r.name, url: abs(`${MAG}rubrique/${r.slug}/`) })),
      mainEntity: itemListLd(articles.slice(0, 10)),
    },
  ];
  write(path.join(OUT, 'index.html'), page({
    title: `${CONFIG.magazine.title} — art, forêts et climat`,
    description: CONFIG.magazine.description, canonical: MAG, active: 'magazine', body, ld, bodyClass: 'page-magazine',
  }));
}

function filtres(active) {
  return `<nav class="filtres" aria-label="Filtrer par rubrique" data-filtres>
    <a href="${MAG}articles/" data-filtre="toutes"${active ? '' : ' aria-current="true"'}>Toutes</a>
    ${RUBRIQUES.map(r => `<a href="${MAG}rubrique/${r.slug}/" data-filtre="${r.slug}"${active === r.slug ? ' aria-current="true"' : ''}>${esc(r.name)}</a>`).join('\n    ')}
  </nav>`;
}

function buildListing(articles) {
  const per = CONFIG.pagination.perPage;
  const pages = Math.max(1, Math.ceil(articles.length / per));
  const urlOf = n => n === 1 ? `${MAG}articles/` : `${MAG}articles/page/${n}/`;
  for (let n = 1; n <= pages; n++) {
    const list = articles.slice((n - 1) * per, n * per);
    const suffix = n > 1 ? ` — page ${n}` : '';
    const bc = breadcrumb(crumbs({ name: 'Tous les articles' + suffix, url: urlOf(n) }));
    const pagination = pages > 1 ? `<nav class="pagination" aria-label="Pagination" data-pagination>
    ${n > 1 ? `<a rel="prev" href="${urlOf(n - 1)}">← Précédent</a>` : ''}
    ${Array.from({ length: pages }, (_, i) => i + 1).map(i => i === n
      ? `<span aria-current="page">${i}</span>` : `<a href="${urlOf(i)}">${i}</a>`).join(' ')}
    ${n < pages ? `<a rel="next" href="${urlOf(n + 1)}">Suivant →</a>` : ''}
  </nav>` : '';
    const extraHead = (n > 1 ? `<link rel="prev" href="${abs(urlOf(n - 1))}">\n` : '')
      + (n < pages ? `<link rel="next" href="${abs(urlOf(n + 1))}">\n` : '');
    const body = `
<section class="mag-intro mag-intro--compact">
  <div class="mag-wrap">
    ${bc.html}
    <h1>Tous les articles${suffix}</h1>
    <p class="mag-intro-texte">${articles.length} article${articles.length > 1 ? 's' : ''}, du plus récent au plus ancien.</p>
  </div>
</section>
<section class="mag-section mag-wrap" aria-label="Liste des articles">
  ${filtres(null)}
  <p class="filtres-etat" aria-live="polite" data-filtres-etat></p>
  <div class="cartes-grille" id="liste-articles" data-liste>
    ${list.map(a => card(a, 2)).join('\n    ')}
  </div>
  ${pagination}
</section>`;
    const ld = [{
      '@type': 'CollectionPage', '@id': abs(urlOf(n)) + '#page', url: abs(urlOf(n)),
      name: 'Tous les articles du Magazine' + suffix, inLanguage: CONFIG.site.lang,
      isPartOf: { '@id': abs(MAG) + '#page' }, breadcrumb: bc.ld, mainEntity: itemListLd(list),
    }];
    write(path.join(OUT, urlOf(n).slice(MAG.length), 'index.html'), page({
      title: `Tous les articles${suffix} — Magazine La Forêt s'expose`,
      description: `Tous les articles du Magazine de La Forêt s'expose, du plus récent au plus ancien : art et environnement, forêts françaises, artistes et actualités du projet.`,
      canonical: urlOf(n), active: 'articles', body, ld, extraHead, bodyClass: 'page-liste',
    }));
  }
}

function buildRubriques(articles) {
  for (const r of RUBRIQUES) {
    const list = articles.filter(a => a.rubrique === r.slug);
    const url = `${MAG}rubrique/${r.slug}/`;
    const bc = breadcrumb(crumbs({ name: r.name, url }));
    const autres = RUBRIQUES.filter(x => x.slug !== r.slug);
    const body = `
<section class="mag-intro mag-intro--compact" data-rubrique="${r.slug}">
  <div class="mag-wrap">
    ${bc.html}
    <p class="mag-surtitre">${icon(r)}Rubrique</p>
    <h1>${esc(r.name)}</h1>
    <p class="mag-intro-texte">${esc(r.description)}</p>
  </div>
</section>
<section class="mag-section mag-wrap" aria-label="Articles de la rubrique ${esc(r.name)}">
  ${filtres(r.slug)}
  <div class="cartes-grille">
    ${list.length ? list.map(a => card(a, 2)).join('\n    ') : '<p class="mag-vide">Les premiers articles de cette rubrique arrivent bientôt.</p>'}
  </div>
</section>
<aside class="mag-section mag-wrap" aria-labelledby="t-autres">
  <h2 id="t-autres">Les autres rubriques</h2>
  <ul class="rubriques-liens">
    ${autres.map(x => `<li><a href="${MAG}rubrique/${x.slug}/">${icon(x)}${esc(x.name)}</a></li>`).join('\n    ')}
  </ul>
</aside>`;
    const ld = [{
      '@type': 'CollectionPage', '@id': abs(url) + '#page', url: abs(url), name: `${r.name} — Magazine La Forêt s'expose`,
      description: r.description, inLanguage: CONFIG.site.lang, isPartOf: { '@id': abs(MAG) + '#page' },
      about: r.name, breadcrumb: bc.ld, mainEntity: itemListLd(list),
    }];
    write(path.join(OUT, 'rubrique', r.slug, 'index.html'), page({
      title: `${r.name} — Magazine La Forêt s'expose`, description: r.description,
      canonical: url, active: 'r-' + r.slug, body, ld, bodyClass: 'page-rubrique',
    }));
  }
}

function related(a, articles) {
  const others = articles.filter(x => x.slug !== a.slug);
  const score = x => (x.rubrique === a.rubrique ? 10 : 0) + x.motsCles.filter(k => a.motsCles.includes(k)).length;
  return others.sort((x, y) => score(y) - score(x) || y.date.localeCompare(x.date)).slice(0, 3);
}

function buildArticles(articles) {
  const tpl = fs.readFileSync(path.join(ROOT, CONFIG.paths.template), 'utf8')
    .replace(/<!--[\s\S]*?-->\n?/, ''); // retire le commentaire d'aide du modèle
  articles.forEach((a, i) => {
    const r = rubrique(a.rubrique);
    const next = articles[i - 1]; // plus récent
    const prev = articles[i + 1]; // plus ancien
    const bc = breadcrumb(crumbs({ name: r.name, url: `${MAG}rubrique/${r.slug}/` }, { name: a.titre, url: a.url }));
    const lies = related(a, articles);
    const h2 = a.headings.filter(h => h.level === 2);
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Article',
          '@id': abs(a.url) + '#article',
          headline: a.titre.slice(0, 110),
          description: a.chapeau,
          image: [abs(a.image)],
          datePublished: a.date,
          dateModified: a.maj || a.date,
          author: a.auteur === CONFIG.site.publisher ? publisherLd : { '@type': 'Person', name: a.auteur },
          publisher: publisherLd,
          articleSection: r.name,
          keywords: a.motsCles.join(', '),
          wordCount: a.words,
          timeRequired: `PT${a.lecture}M`,
          inLanguage: CONFIG.site.lang,
          isAccessibleForFree: true,
          mainEntityOfPage: { '@id': abs(a.url) + '#page' },
          isPartOf: { '@id': abs(MAG) + '#page' },
        },
        {
          '@type': 'WebPage', '@id': abs(a.url) + '#page', url: abs(a.url), name: a.titre,
          description: a.chapeau, inLanguage: CONFIG.site.lang, isPartOf: { '@id': SITE + '/#site' },
          breadcrumb: bc.ld, primaryImageOfPage: abs(a.image),
          speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.article-chapeau'] },
        },
      ],
    };
    const nav = `<nav class="article-navigation" aria-label="Articles précédent et suivant">
        ${prev ? `<a rel="prev" href="${prev.url}"><span>← Article précédent</span>${esc(prev.titre)}</a>` : '<span></span>'}
        ${next ? `<a rel="next" href="${next.url}"><span>Article suivant →</span>${esc(next.titre)}</a>` : '<span></span>'}
      </nav>
      <p class="article-retour"><a href="${MAG}rubrique/${r.slug}/">Tous les articles « ${esc(r.name)} »</a> · <a href="${MAG}articles/">Tous les articles</a></p>`;
    const vals = {
      titre: esc(a.titre),
      description: esc(a.chapeau),
      canonical: abs(a.url),
      image: esc(abs(a.image)),
      image_alt: esc(a.imageAlt),
      mots_cles: esc(a.motsCles.join(', ')),
      auteur: esc(a.auteur),
      jsonld: jsonLd(ld),
      header: header('r-' + r.slug),
      fil_ariane: bc.html,
      rubrique_nom: esc(r.name),
      rubrique_url: `${MAG}rubrique/${r.slug}/`,
      rubrique_slug: r.slug,
      date_iso: a.date,
      date_texte: dateFr(a.date),
      maj_bloc: a.maj ? ` · mis à jour le <time datetime="${a.maj}" itemprop="dateModified">${dateFr(a.maj)}</time>` : '',
      temps_lecture: String(a.lecture),
      chapeau: esc(a.chapeau),
      visuel: `<figure class="article-visuel mag-wrap">${visuel(a, 'article-image')}</figure>`,
      sommaire: h2.length > 1
        ? `<h2 class="sommaire-titre">Sommaire</h2><ol>${h2.map(h => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ol>`
        : '',
      contenu: a.html,
      navigation: nav,
      articles_lies: lies.length
        ? `<div class="cartes-grille">${lies.map(x => card(x, 3)).join('\n')}</div>`
        : '<p class="mag-vide">D\'autres articles arrivent bientôt.</p>',
      footer: footer(),
      feeds: feedLinks,
    };
    write(path.join(OUT, a.slug, 'index.html'), tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vals ? vals[k] : m)));
  });
}

/* =========================================================
   Fichiers de données : index, flux, sitemap, llms.txt
   ========================================================= */

function buildData(articles) {
  // Horodatage déduit du dernier article, et non de l'heure de génération : deux
  // générations successives sans nouvel article produisent des fichiers identiques.
  // Sans cela, la tâche planifiée enverrait chaque jour une modification inutile.
  const derniere = articles.length ? articles.map(a => a.maj || a.date).sort().at(-1) : today();
  const now = `${derniere}T08:00:00+02:00`;

  // magazine-index.json : index interne (filtres JS, outils, LLM).
  write(path.join(OUT, 'magazine-index.json'), JSON.stringify({
    _commentaire: 'Fichier généré par scripts/magazine.mjs — ne pas modifier à la main.',
    generated: now,
    magazine: { title: CONFIG.magazine.title, url: abs(MAG), description: CONFIG.magazine.description },
    rubriques: RUBRIQUES.map(r => ({
      slug: r.slug, name: r.name, icon: r.icon, description: r.description, url: abs(`${MAG}rubrique/${r.slug}/`),
      count: articles.filter(a => a.rubrique === r.slug).length,
    })),
    articles: articles.map(a => ({
      slug: a.slug, url: abs(a.url), path: a.url, titre: a.titre, chapeau: a.chapeau,
      date: a.date, maj: a.maj || null, dateTexte: dateFr(a.date),
      rubrique: a.rubrique, rubriqueNom: rubrique(a.rubrique).name,
      auteur: a.auteur, motsCles: a.motsCles, image: abs(a.image), hasImage: a.hasImage, imageAlt: a.imageAlt,
      lecture: a.lecture, mots: a.words, intertitres: a.headings.map(h => h.text), source: a.source,
    })),
  }, null, 2));

  // feed.json : JSON Feed 1.1, avec le texte intégral (idéal pour l'ingestion par les LLM).
  write(path.join(OUT, 'feed.json'), JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: CONFIG.magazine.title,
    home_page_url: abs(MAG),
    feed_url: abs(MAG + 'feed.json'),
    description: CONFIG.magazine.description,
    language: 'fr-FR',
    icon: abs(CONFIG.site.defaultImage),
    authors: [{ name: CONFIG.site.publisher, url: SITE + '/' }],
    items: articles.map(a => ({
      id: abs(a.url), url: abs(a.url), title: a.titre, summary: a.chapeau,
      content_html: a.html, image: abs(a.image),
      date_published: `${a.date}T08:00:00+02:00`,
      date_modified: `${a.maj || a.date}T08:00:00+02:00`,
      authors: [{ name: a.auteur }], tags: [rubrique(a.rubrique).name, ...a.motsCles], language: 'fr-FR',
    })),
  }, null, 2));

  // feed.xml : RSS 2.0.
  const cdata = s => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  write(path.join(OUT, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>${esc(CONFIG.magazine.title)}</title>
  <link>${abs(MAG)}</link>
  <description>${esc(CONFIG.magazine.description)}</description>
  <language>fr-FR</language>
  <atom:link href="${abs(MAG + 'feed.xml')}" rel="self" type="application/rss+xml"/>
  <lastBuildDate>${dateRfc822(derniere)}</lastBuildDate>
${articles.map(a => `  <item>
    <title>${esc(a.titre)}</title>
    <link>${abs(a.url)}</link>
    <guid isPermaLink="true">${abs(a.url)}</guid>
    <pubDate>${dateRfc822(a.date)}</pubDate>
    <category>${esc(rubrique(a.rubrique).name)}</category>
    <description>${cdata(a.chapeau)}</description>
    <content:encoded>${cdata(a.html)}</content:encoded>
  </item>`).join('\n')}
</channel>
</rss>
`);

  // sitemap-magazine.xml
  const lastmod = articles.length ? articles.map(a => a.maj || a.date).sort().at(-1) : today();
  const per = CONFIG.pagination.perPage;
  const pages = Math.max(1, Math.ceil(articles.length / per));
  const urls = [
    { loc: MAG, lastmod },
    ...Array.from({ length: pages }, (_, i) => ({ loc: i ? `${MAG}articles/page/${i + 1}/` : `${MAG}articles/`, lastmod })),
    ...RUBRIQUES.map(r => {
      const d = articles.filter(a => a.rubrique === r.slug).map(a => a.maj || a.date).sort().at(-1);
      return { loc: `${MAG}rubrique/${r.slug}/`, lastmod: d || lastmod };
    }),
    ...articles.map(a => ({ loc: a.url, lastmod: a.maj || a.date })),
  ];
  write(path.join(OUT, 'sitemap-magazine.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>\n    <loc>${abs(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`).join('\n')}
</urlset>
`);

  // llms.txt : section Magazine tenue à jour entre deux balises.
  const llmsPath = path.join(ROOT, CONFIG.paths.llms);
  if (fs.existsSync(llmsPath)) {
    const block = `<!-- magazine:start (section générée par scripts/magazine.mjs) -->
## Magazine

${CONFIG.magazine.description}

- [Accueil du Magazine](${abs(MAG)})
- [Tous les articles](${abs(MAG + 'articles/')})
- [Flux JSON avec le texte intégral des articles](${abs(MAG + 'feed.json')})
- [Index des articles (JSON)](${abs(MAG + 'magazine-index.json')})
- [Flux RSS](${abs(MAG + 'feed.xml')})

### Articles

${articles.map(a => `- [${a.titre}](${abs(a.url)}) (${rubrique(a.rubrique).name}, ${dateFr(a.date)}) : ${a.chapeau}`).join('\n')}
<!-- magazine:end -->`;
    let llms = fs.readFileSync(llmsPath, 'utf8');
    llms = /<!-- magazine:start[\s\S]*?<!-- magazine:end -->/.test(llms)
      ? llms.replace(/<!-- magazine:start[\s\S]*?<!-- magazine:end -->/, block)
      : llms.trimEnd() + '\n\n' + block + '\n';
    fs.writeFileSync(llmsPath, llms, 'utf8');
  }
}

/* =========================================================
   Commandes
   ========================================================= */

// Supprime les pages générées précédemment (tous les sous-dossiers de magazine/ sauf ceux
// qui commencent par « _ » ou qui sont listés dans KEEP), puis regénère tout.
const KEEP = new Set(['images']);
function clean() {
  for (const d of fs.readdirSync(OUT, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.startsWith('_') && !KEEP.has(d.name))
      fs.rmSync(path.join(OUT, d.name), { recursive: true, force: true });
  }
}

function build() {
  const articles = loadArticles();
  clean();
  buildHome(articles);
  buildListing(articles);
  buildRubriques(articles);
  buildArticles(articles);
  buildData(articles);
  console.log(`Magazine généré : ${articles.length} article(s), ${RUBRIQUES.length} rubriques.`);
  return articles;
}

function newDraft() {
  const titre = process.argv[3];
  if (!titre || titre.startsWith('--')) {
    console.error('Usage : node scripts/magazine.mjs new "Titre de l\'article" [--rubrique slug] [--date AAAA-MM-JJ]');
    process.exit(1);
  }
  const r = arg('rubrique', RUBRIQUES[0].slug);
  if (!rubrique(r)) { console.error(`Rubrique inconnue : ${r}. Choix : ${RUBRIQUES.map(x => x.slug).join(', ')}`); process.exit(1); }
  const date = arg('date', today());
  const slug = slugify(titre);
  const file = path.join(DRAFTS, `${date}-${slug}.md`);
  if (fs.existsSync(file)) { console.error(`Le brouillon existe déjà : ${file}`); process.exit(1); }
  write(file, `---
titre: ${titre}
slug: ${slug}
chapeau: Résumé de l'article en une ou deux phrases (160 caractères conseillés).
date: ${date}
rubrique: ${r}
auteur: ${CONFIG.site.publisher}
mots_cles: forêt, art
statut: brouillon
---

Premier paragraphe : l'essentiel de l'article, en quelques phrases claires.

## Premier intertitre

Développement. Citer ses sources : [Office national des forêts](https://www.onf.fr).

## Deuxième intertitre

- Point clé 1
- Point clé 2

## Pour aller plus loin

Conclusion et lien vers [La Forêt s'expose](/).
`);
  console.log(`Brouillon créé : ${path.relative(ROOT, file)}\nPassez « statut: pret » pour qu'il soit publié automatiquement le ${date}.`);
}

function publish() {
  const limitDate = arg('date', today());
  const max = CONFIG.publication.articlesPerRun;
  if (!fs.existsSync(DRAFTS)) { console.log('Aucun brouillon.'); return build(); }
  const ready = fs.readdirSync(DRAFTS).filter(f => f.endsWith('.md')).map(f => {
    const file = path.join(DRAFTS, f);
    const { data } = parseFrontMatter(fs.readFileSync(file, 'utf8'), f);
    return { f, file, data };
  }).filter(d => d.data.statut === 'pret' && d.data.date && d.data.date <= limitDate)
    .sort((a, b) => a.data.date.localeCompare(b.data.date))
    .slice(0, max);

  for (const d of ready) {
    loadArticle(d.file); // valide l'article avant de le déplacer
    const text = fs.readFileSync(d.file, 'utf8').replace(/^statut:.*\r?\n/m, '');
    fs.mkdirSync(SRC, { recursive: true });
    fs.writeFileSync(path.join(SRC, d.f.replace(/^\d{4}-\d{2}-\d{2}-/, '')), text, 'utf8');
    fs.rmSync(d.file);
    console.log(`Publié : ${d.data.titre}`);
  }
  if (!ready.length) console.log(`Aucun brouillon prêt à publier au ${limitDate}.`);
  build();
}

const commands = { build, new: newDraft, publish };
const cmd = process.argv[2] || 'build';
if (!commands[cmd]) { console.error(`Commande inconnue : ${cmd}. Commandes : build, new, publish.`); process.exit(1); }
try { commands[cmd](); } catch (e) { console.error('Erreur : ' + e.message); process.exit(1); }
