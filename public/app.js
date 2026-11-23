'use strict';
/* Giesbert – erinnert ans Gießen, sonst an nichts. */

const STORE_KEY = 'giesbert.v1';
const DAY = 86400000;
const GBIF_BACKBONE = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c';

/* ---------- Hilfsfunktionen ---------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function todayStr(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return toDateStr(d);
}
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / DAY); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return toDateStr(d); }

function norm(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
function hueOf(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 90 + (h % 110); }

/* ---------- Speicher ---------- */
let state = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { const s = JSON.parse(raw); if (Array.isArray(s.plants)) return s; }
  } catch (e) { /* leer starten */ }
  return {version: 1, plants: [], lastNotified: null};
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Speichern hat leider nicht geklappt – ist der private Modus aktiv?'); }
}

/* ---------- Pflege-Logik ---------- */
function seasonalBase(base, date = new Date()) {
  const m = date.getMonth() + 1;
  if (m >= 4 && m <= 9) return base.s;
  if (m === 3 || m === 10) return Math.round((base.s + base.w) / 2);
  return base.w;
}
function intervalOf(p, date = new Date()) {
  if (!p.auto) return Math.max(1, p.custom || 7);
  return Math.max(1, Math.round(seasonalBase(p.base, date) * (p.factor || 1)));
}
function seasonLabel(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m >= 4 && m <= 9) return 'Sommerhalbjahr';
  if (m === 3 || m === 10) return 'Übergangszeit';
  return 'Winter';
}
/** Tage bis zum nächsten Gießen (≤ 0 = heute dran). */
function daysLeft(p) {
  const today = todayStr();
  if (!p.lastWatered) return p.snoozeUntil && p.snoozeUntil > today ? daysBetween(today, p.snoozeUntil) : 0;
  let due = addDays(p.lastWatered, intervalOf(p));
  if (p.snoozeUntil && p.snoozeUntil > due) due = p.snoozeUntil;
  return daysBetween(today, due);
}
function fertilizerDue(p) {
  if (!p.fertHint || !p.base.f) return false;
  const m = new Date().getMonth() + 1;
  if (m < 3 || m > 9) return false;
  return daysBetween(p.lastFertilized || p.added, todayStr()) >= p.base.f;
}
function displayName(p) { return p.nickname || p.name; }

/* ---------- Darstellung ---------- */
const LEAF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21c0-9 5-15 15-17-1 10-6 16-14 16 2-4 5-7 8-9-4 2-7 5-9 10z"/></svg>';
const DROP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.7C9 7 6 10.5 6 14a6 6 0 0 0 12 0c0-3.5-3-7-6-11.3z"/></svg>';

function statusText(p, left) {
  if (!p.lastWatered && left <= 0) return 'Schau mal, ob sie Durst hat';
  if (left < -1) return `Hat seit ${-left} Tagen Durst`;
  if (left === -1) return 'Hat seit gestern Durst';
  if (left === 0) return 'Heute gießen';
  if (left === 1) return 'Morgen dran';
  return `In ${left} Tagen`;
}

function cardHTML(p) {
  const left = daysLeft(p);
  const due = left <= 0;
  const iv = intervalOf(p);
  const level = due ? 0 : Math.min(100, Math.round(left / iv * 100));
  const sub = p.nickname ? p.name + (p.latin ? ' · ' + p.latin : '') : (p.latin || '');
  const fert = fertilizerDue(p)
    ? `<button class="tag" data-act="fert" data-id="${p.id}" title="Als gedüngt markieren">🌱 Dünger wäre mal wieder nett</button>` : '';
  return `
  <article class="card ${due ? 'due' : ''}" data-id="${p.id}" style="--h:${hueOf(p.latin || p.name)}">
    <div class="avatar">${LEAF}</div>
    <div class="info" data-act="edit" data-id="${p.id}" role="button" tabindex="0" aria-label="${esc(displayName(p))} bearbeiten">
      <div class="name">${esc(displayName(p))}</div>
      ${sub ? `<div class="latin">${esc(sub)}</div>` : ''}
      <div class="status">${statusText(p, left)}</div>
      <div class="meter" title="Wasserstand (geschätzt)"><i style="width:${level}%"></i></div>
      ${fert ? `<div class="tags">${fert}</div>` : ''}
    </div>
    <div class="actions">
      <button class="btn water" data-act="water" data-id="${p.id}">${DROP}Gegossen</button>
      ${due ? `<button class="btn tiny" data-act="snooze" data-id="${p.id}" title="Erde noch feucht? Morgen nochmal erinnern.">Morgen nochmal</button>` : ''}
    </div>
  </article>`;
}

function render() {
  const hero = $('#hero'), list = $('#list');
  const plants = state.plants.map(p => ({p, left: daysLeft(p)})).sort((a, b) => a.left - b.left || displayName(a.p).localeCompare(displayName(b.p), 'de'));
  const due = plants.filter(x => x.left <= 0);
  const rest = plants.filter(x => x.left > 0);
  updateBadge(due.length);

  if (!plants.length) {
    hero.innerHTML = '';
    list.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle cx="60" cy="60" r="56" fill="var(--green-soft)"/>
          <path d="M44 74h32l-4 26H48z" fill="var(--sun)" opacity=".8"/>
          <path d="M60 74c0-18 4-30 18-38-2 16-8 28-18 38z" fill="var(--green)"/>
          <path d="M60 74c0-14-4-24-16-30 1 13 6 23 16 30z" fill="var(--green-2)"/>
          <path d="M84 22c-4 6-7 10-7 14a7 7 0 0 0 14 0c0-4-3-8-7-14z" fill="var(--water)"/>
        </svg>
        <h2>Noch ganz schön leer hier</h2>
        <p>Füg Deine erste Pflanze hinzu. Mehr als den Namen brauche ich nicht – versprochen. 🙂</p>
        <button class="btn primary" data-act="add">Erste Pflanze hinzufügen</button>
      </div>`;
    return;
  }

  if (due.length) {
    hero.innerHTML = `
      <h2>${due.length === 1 ? 'Eine Pflanze hat' : `${due.length} Pflanzen haben`} heute Durst</h2>
      <p>${due.length === 1 ? 'Ein kurzer Gang mit der Gießkanne genügt.' : 'Ein kleiner Rundgang mit der Gießkanne – fertig.'}</p>
      ${due.length > 1 ? '<button class="btn primary" data-act="water-all">Alle gegossen</button>' : ''}`;
  } else {
    const next = rest[0];
    hero.innerHTML = `
      <h2>Alle sind versorgt 🌿</h2>
      <p>Als Nächstes ist <strong>${esc(displayName(next.p))}</strong> ${next.left === 1 ? 'morgen' : `in ${next.left} Tagen`} dran. Bis dahin: nichts zu tun.</p>`;
  }

  let html = '';
  if (due.length) html += `<div class="group-title"><h3>Heute dran</h3></div><div class="grid">${due.map(x => cardHTML(x.p)).join('')}</div>`;
  if (rest.length) html += `<div class="group-title"><h3>${due.length ? 'Später' : 'Deine Pflanzen'}</h3><span class="muted small">${seasonLabel()}</span></div><div class="grid">${rest.map(x => cardHTML(x.p)).join('')}</div>`;
  list.innerHTML = html;
}

/* ---------- Aktionen ---------- */
function findPlant(id) { return state.plants.find(p => p.id === id); }

function water(ids) {
  const before = ids.map(id => { const p = findPlant(id); return {id, lastWatered: p.lastWatered, snoozeUntil: p.snoozeUntil}; });
  for (const id of ids) { const p = findPlant(id); p.lastWatered = todayStr(); p.snoozeUntil = null; }
  save(); render();
  ids.forEach(id => document.querySelector(`.card[data-id="${id}"]`)?.classList.add('splash'));
  const msg = ids.length === 1 ? `${displayName(findPlant(ids[0]))} ist versorgt 💧` : `${ids.length} Pflanzen versorgt 💧`;
  toast(msg, () => { for (const b of before) Object.assign(findPlant(b.id) || {}, b); save(); render(); });
}
function snooze(id) {
  const p = findPlant(id); const prev = p.snoozeUntil;
  p.snoozeUntil = todayStr(1); save(); render();
  toast('Alles klar, ich frag morgen nochmal.', () => { p.snoozeUntil = prev; save(); render(); });
}
function fertilized(id) {
  const p = findPlant(id); const prev = p.lastFertilized;
  p.lastFertilized = todayStr(); save(); render();
  toast('Als gedüngt vermerkt 🌱', () => { p.lastFertilized = prev; save(); render(); });
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.act) {
    case 'water': water([id]); break;
    case 'water-all': water(state.plants.filter(p => daysLeft(p) <= 0).map(p => p.id)); break;
    case 'snooze': snooze(id); break;
    case 'fert': fertilized(id); break;
    case 'edit': openEdit(id); break;
    case 'add': openAdd(); break;
  }
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.info[data-act="edit"]')) { e.preventDefault(); openEdit(e.target.dataset.id); }
});

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Rückgängig</button>' : ''}`;
  t.hidden = false;
  if (undo) t.querySelector('button').onclick = () => { t.hidden = true; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

/* ---------- Suche (lokale Datenbank) ---------- */
const INDEX = PLANTS.map((p, i) => ({
  i,
  names: [...p.d.map(n => ({n, de: true})), ...p.l.map(n => ({n, de: false}))].map(x => ({...x, k: norm(x.n)})),
  genus: p.l.map(n => norm(n).split(' ')[0]),
}));

function searchLocal(q) {
  const k = norm(q);
  if (k.length < 2) return [];
  const qWords = k.split(' ');
  const hits = [];
  for (const entry of INDEX) {
    let best = 0, matched = null;
    for (const nm of entry.names) {
      let s = 0;
      if (nm.k === k) s = 100;
      else if (nm.k.startsWith(k)) s = 85;
      else if (nm.k.split(' ').some(w => w.startsWith(k))) s = 70;
      else if (k.length >= 3 && nm.k.includes(k)) s = 55;
      else if (k.length >= 4) {
        const tol = k.length >= 8 ? 2 : 1;
        const words = nm.k.split(' ');
        if (levenshtein(k, nm.k) <= tol || words.some(w => levenshtein(k, w) <= tol) || levenshtein(k, nm.k.slice(0, k.length)) <= tol - (k.length < 8 ? 0 : 1)) s = 40;
      }
      if (s > best || (s === best && s > 0 && nm.de && matched && !matched.de)) { best = s; matched = nm; }
    }
    // Gattung passt (z. B. „Calathea makoyana“ → Calathea)
    if (!best && qWords.length > 1 && entry.genus.includes(qWords[0])) { best = 30; matched = {n: q, de: false, genusOnly: true}; }
    if (best) hits.push({entry: PLANTS[entry.i], score: best, matched});
  }
  hits.sort((a, b) => b.score - a.score || a.entry.d[0].localeCompare(b.entry.d[0], 'de'));
  return hits.slice(0, 8);
}

/* ---------- Online-Suche über GBIF (nur Namensauflösung) ---------- */
async function searchGBIF(q) {
  const url = `https://api.gbif.org/v1/species/search?q=${encodeURIComponent(q)}&datasetKey=${GBIF_BACKBONE}&highertaxonKey=6&status=ACCEPTED&limit=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('GBIF ' + res.status);
  const data = await res.json();
  const seen = new Set(); const out = [];
  for (const r of data.results || []) {
    const latin = r.canonicalName || r.scientificName;
    if (!latin || seen.has(latin) || !['SPECIES', 'GENUS', 'VARIETY', 'SUBSPECIES'].includes(r.rank)) continue;
    seen.add(latin);
    const de = (r.vernacularNames || []).filter(v => ['deu', 'ger', 'de'].includes(String(v.language).toLowerCase())).map(v => v.vernacularName);
    out.push({latin, family: r.family || '', genus: r.genus || latin.split(' ')[0], de: [...new Set(de)].slice(0, 3)});
    if (out.length >= 8) break;
  }
  return out;
}
function careForTaxon(t) {
  const g = norm(t.genus);
  const local = PLANTS.find(p => p.l.some(n => norm(n) === norm(t.latin))) || PLANTS.find(p => p.l.some(n => norm(n).split(' ')[0] === g));
  if (local) return {base: {s: local.s, w: local.w, f: local.f}, hint: local.h, source: `Richtwerte der Gattung ${t.genus}`};
  if (FAMILY_DEFAULTS[t.family]) return {base: {...FAMILY_DEFAULTS[t.family]}, source: `Richtwerte der Familie ${t.family}`};
  return {base: {...GENERIC_DEFAULT}, source: 'Allgemeine Richtwerte – passe sie gern an'};
}

/* ---------- Dialog: Pflanze hinzufügen ---------- */
const dlgAdd = $('#dlg-add');
let draft = null;

function openAdd() {
  draft = null;
  $('#search').value = '';
  $('#results').innerHTML = '';
  $('#search-extra').innerHTML = '<p class="muted small">Deutscher Name oder lateinischer Name – beides klappt.</p>';
  showStep('search');
  dlgAdd.showModal();
  setTimeout(() => $('#search').focus(), 50);
}
function showStep(step) {
  $('#step-search').hidden = step !== 'search';
  $('#step-details').hidden = step !== 'details';
  $('#add-foot').hidden = step !== 'details';
  $('#add-title').textContent = step === 'search' ? 'Neue Pflanze' : 'Fast fertig';
}

let searchTimer;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
$('#search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#results button')?.click(); }
});

function runSearch() {
  const q = $('#search').value.trim();
  const hits = searchLocal(q);
  $('#results').innerHTML = hits.map((h, i) => {
    const p = h.entry;
    const name = h.matched?.de ? h.matched.n : p.d[0];
    const others = p.d.filter(n => n !== name).slice(0, 3);
    return `<li><button type="button" data-hit="${i}">
      <span class="r-name">${esc(name)}</span>
      <span class="r-latin">${esc(h.matched?.genusOnly ? q : p.l[0])}</span>
      ${others.length ? `<span class="r-meta">auch: ${esc(others.join(', '))}</span>` : ''}
    </button></li>`;
  }).join('');
  $('#results').querySelectorAll('button').forEach(b => b.onclick = () => {
    const h = hits[+b.dataset.hit], p = h.entry;
    const name = h.matched?.de ? h.matched.n : p.d[0];
    pickDraft({
      name, latin: h.matched?.genusOnly ? q : p.l[0],
      base: {s: p.s, w: p.w, f: p.f}, hint: p.h,
      source: h.matched?.genusOnly ? `Richtwerte der Gattung ${p.l[0].split(' ')[0]}` : 'Richtwerte aus der eingebauten Datenbank',
    });
  });

  const extra = $('#search-extra');
  if (q.length < 2) { extra.innerHTML = '<p class="muted small">Deutscher Name oder lateinischer Name – beides klappt.</p>'; return; }
  extra.innerHTML = `
    ${hits.length ? '' : '<p class="muted small">In der eingebauten Liste ist nichts dabei.</p>'}
    ${q.length >= 3 ? '<button type="button" class="btn ghost" id="btn-gbif">🔎 Online in der GBIF-Datenbank suchen</button>' : ''}
    <button type="button" class="btn ghost" id="btn-custom">➕ „${esc(q)}“ einfach so anlegen</button>`;
  $('#btn-gbif')?.addEventListener('click', () => runGBIF(q));
  $('#btn-custom').onclick = () => pickDraft({name: q, latin: '', base: {...GENERIC_DEFAULT}, source: 'Allgemeine Richtwerte – passe sie gern an'});
}

async function runGBIF(q) {
  const btn = $('#btn-gbif');
  btn.disabled = true; btn.textContent = 'Suche läuft …';
  try {
    const found = await searchGBIF(q);
    if (!found.length) { btn.textContent = 'Online leider auch nichts gefunden'; return; }
    const ul = document.createElement('ul'); ul.className = 'results';
    ul.innerHTML = '<li class="muted small">Ergebnisse von GBIF (Global Biodiversity Information Facility):</li>' + found.map((t, i) => `
      <li><button type="button" data-g="${i}">
        <span class="r-name">${esc(t.de[0] || t.latin)}</span>
        <span class="r-latin">${esc(t.latin)}</span>
        <span class="r-meta">${esc([t.family, t.de.slice(1).join(', ')].filter(Boolean).join(' · '))}</span>
      </button></li>`).join('');
    btn.replaceWith(ul);
    ul.querySelectorAll('button').forEach(b => b.onclick = () => {
      const t = found[+b.dataset.g];
      pickDraft({name: t.de[0] || t.latin, latin: t.latin, family: t.family, ...careForTaxon(t)});
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Online-Suche gerade nicht erreichbar – nochmal versuchen?';
  }
}

function pickDraft(d) {
  draft = {...d, factor: 1};
  $('#picked').innerHTML = `
    <div class="p-name">${esc(d.name)}</div>
    ${d.latin ? `<div class="p-latin">${esc(d.latin)}</div>` : ''}
    ${d.hint ? `<p class="hint">💡 ${esc(d.hint)}</p>` : ''}`;
  $('#nickname').value = '';
  dlgAdd.querySelector('input[name=last][value="0"]').checked = true;
  updateAddInterval();
  showStep('details');
}
function updateAddInterval() {
  const iv = Math.max(1, Math.round(seasonalBase(draft.base) * draft.factor));
  $('#add-interval').textContent = iv;
  $('#add-interval-note').textContent = `${draft.source}. Im Winter etwa alle ${Math.round(draft.base.w * draft.factor)}, im Sommer alle ${Math.round(draft.base.s * draft.factor)} Tage – das passt sich automatisch an.`;
}
$('#step-details').addEventListener('click', e => {
  const b = e.target.closest('[data-step]'); if (!b || !draft) return;
  const cur = Math.max(1, Math.round(seasonalBase(draft.base) * draft.factor));
  const next = Math.max(1, Math.min(90, cur + Number(b.dataset.step)));
  draft.factor = next / seasonalBase(draft.base);
  updateAddInterval();
});
$('#btn-back').onclick = () => { showStep('search'); $('#search').focus(); };

$('#form-add').addEventListener('submit', e => {
  if (e.submitter?.value !== 'save' || !draft) return;
  const lastSel = dlgAdd.querySelector('input[name=last]:checked').value;
  const plant = {
    id: uid(), name: draft.name, latin: draft.latin || '', family: draft.family || '',
    nickname: $('#nickname').value.trim(), base: draft.base, hint: draft.hint || '',
    auto: true, factor: Math.round(draft.factor * 1000) / 1000, custom: null,
    lastWatered: lastSel === '99' ? null : todayStr(-Number(lastSel)),
    snoozeUntil: null, lastFertilized: null, fertHint: draft.base.f > 0, added: todayStr(),
  };
  state.plants.push(plant); save(); render();
  toast(`${displayName(plant)} ist eingezogen 🪴`);
});

/* ---------- Dialog: Pflanze bearbeiten ---------- */
const dlgEdit = $('#dlg-edit');
let editing = null, editInterval = 7;

function openEdit(id) {
  const p = findPlant(id); if (!p) return;
  editing = p; editInterval = intervalOf(p);
  $('#edit-title').textContent = displayName(p);
  $('#edit-sub').textContent = [p.nickname ? p.name : '', p.latin].filter(Boolean).join(' · ');
  $('#edit-nickname').value = p.nickname || '';
  $('#edit-last').value = p.lastWatered || '';
  $('#edit-last').max = todayStr();
  $('#edit-auto').checked = !!p.auto;
  $('#edit-fert').checked = !!p.fertHint;
  $('#edit-fert').closest('.switch').hidden = !p.base.f;
  $('#edit-hint').hidden = !p.hint; $('#edit-hint').textContent = p.hint ? '💡 ' + p.hint : '';
  updateEditInterval();
  dlgEdit.showModal();
}
function updateEditInterval() {
  $('#edit-interval').textContent = editInterval;
  const auto = $('#edit-auto').checked;
  const f = editInterval / seasonalBase(editing.base);
  $('#edit-interval-note').textContent = auto
    ? `Aktuell (${seasonLabel()}): alle ${editInterval} Tage. Im Winter etwa alle ${Math.max(1, Math.round(editing.base.w * f))}, im Sommer alle ${Math.max(1, Math.round(editing.base.s * f))} Tage.`
    : 'Fester Rhythmus, das ganze Jahr gleich.';
}
dlgEdit.addEventListener('click', e => {
  const b = e.target.closest('[data-step]'); if (!b) return;
  editInterval = Math.max(1, Math.min(90, editInterval + Number(b.dataset.step)));
  updateEditInterval();
});
$('#edit-auto').addEventListener('change', updateEditInterval);
$('#form-edit').addEventListener('submit', e => {
  if (e.submitter?.value !== 'save' || !editing) return;
  const p = editing;
  p.nickname = $('#edit-nickname').value.trim();
  const last = $('#edit-last').value;
  if (last !== (p.lastWatered || '')) { p.lastWatered = last || null; p.snoozeUntil = null; }
  p.auto = $('#edit-auto').checked;
  if (p.auto) { p.factor = Math.round(editInterval / seasonalBase(p.base) * 1000) / 1000; }
  else { p.custom = editInterval; }
  p.fertHint = $('#edit-fert').checked;
  save(); render();
});
$('#btn-delete').onclick = () => {
  const p = editing; if (!p) return;
  const idx = state.plants.indexOf(p);
  state.plants.splice(idx, 1); save(); render(); dlgEdit.close();
  toast(`${displayName(p)} entfernt`, () => { state.plants.splice(idx, 0, p); save(); render(); });
};

/* ---------- Einstellungen ---------- */
const dlgSettings = $('#dlg-settings');
$('#btn-settings').onclick = () => { updateNotifyUI(); dlgSettings.showModal(); };
$('#btn-add').onclick = openAdd;

// Dialoge per Klick auf den Hintergrund schließen
for (const d of [dlgAdd, dlgEdit, dlgSettings]) {
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
}

$('#btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], {type: 'application/json'});
  download(blob, `giesbert-${todayStr()}.json`);
};
$('#btn-import').onclick = () => $('#file-import').click();
$('#file-import').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.plants)) throw new Error('Format');
    if (state.plants.length && !confirm(`${data.plants.length} Pflanzen importieren? Deine aktuelle Liste wird ersetzt.`)) return;
    state = {version: 1, lastNotified: null, ...data}; save(); render(); dlgSettings.close();
    toast(`${state.plants.length} Pflanzen importiert`);
  } catch (err) { toast('Die Datei konnte ich leider nicht lesen.'); }
  e.target.value = '';
};

$('#btn-ics').onclick = () => {
  const n = Number($('#ics-freq').value);
  const [hh, mm] = ($('#ics-time').value || '09:00').split(':');
  const start = todayStr().replace(/-/g, '') + `T${hh}${mm}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const appUrl = location.href.split('#')[0];
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Giesbert//DE', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${uid()}@giesbert`, `DTSTAMP:${stamp}`, `DTSTART:${start}`, 'DURATION:PT5M',
    `RRULE:FREQ=DAILY;INTERVAL=${n}`,
    'SUMMARY:🪴 Kurz bei den Pflanzen vorbeischauen',
    `DESCRIPTION:Wer hat heute Durst? Giesbert weiß es: ${appUrl}`, `URL:${appUrl}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Giesbert', 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  download(new Blob([ics], {type: 'text/calendar'}), 'giesbert-erinnerung.ics');
};
function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- Mitteilungen & App-Badge ---------- */
function updateNotifyUI() {
  const btn = $('#btn-notify'), note = $('#notify-note');
  if (!('Notification' in window)) { btn.hidden = true; note.textContent = ''; return; }
  const perm = Notification.permission;
  btn.hidden = perm !== 'default';
  note.textContent = perm === 'granted'
    ? 'Mitteilungen sind erlaubt: Solange die App offen ist (oder als installierte App im Hintergrund läuft), melde ich mich einmal am Tag, wenn jemand Durst hat.'
    : perm === 'denied' ? 'Mitteilungen sind im Browser blockiert.' : 'Optional: eine Mitteilung, solange die App offen ist.';
}
$('#btn-notify').onclick = async () => { await Notification.requestPermission(); updateNotifyUI(); checkNotify(); };

async function checkNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const due = state.plants.filter(p => daysLeft(p) <= 0);
  if (!due.length || state.lastNotified === todayStr()) return;
  state.lastNotified = todayStr(); save();
  const body = due.length === 1 ? `${displayName(due[0])} hat Durst.` : `${due.map(displayName).slice(0, 4).join(', ')}${due.length > 4 ? ' …' : ''} haben Durst.`;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification('Giesbert 💧', {body, icon: 'icon.svg', tag: 'giesbert'});
    else new Notification('Giesbert 💧', {body, icon: 'icon.svg'});
  } catch (e) { /* egal */ }
}
function updateBadge(n) {
  try { if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) { /* nicht unterstützt */ }
}

/* ---------- Start ---------- */
render();
checkNotify();
// Bei Rückkehr zur App und alle 30 Minuten neu berechnen (z. B. über Mitternacht)
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); checkNotify(); } });
setInterval(() => { render(); checkNotify(); }, 30 * 60 * 1000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
