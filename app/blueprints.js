'use strict';

// Blueprints tab. Data comes from the Star Citizen Wiki API (api.star-citizen.wiki),
// fetched through the main process (window.wiki.get), for the current LIVE game version.
(() => {
  const BP_CACHE_KEY = 'sc-cargo-sales:blueprints:v1';
  const PAGE_SIZE = 200;   // the API's maximum page size
  const id = (x) => document.getElementById(x);
  const b = {
    q: id('bq'), clear: id('bclear'), suggest: id('bsuggest'), card: id('bp'), empty: id('bempty'),
    name: id('bp-name'), meta: id('bp-meta'), link: id('bp-link'), rows: id('bp-rows'),
    unlock: id('bp-unlock'), dismantle: id('bp-dismantle'),
    tune: id('tune'), tuneStats: id('tune-stats'), tuneReset: id('tune-reset'), tuneCard: id('tune-card')
  };

  let list = null;          // [{uuid, name, type, time, def, version, missions, ingredients, dismantle, web}]
  let updated = 0;
  let loading = false;
  let current = null;       // selected blueprint (list entry)
  let detail = null;        // full detail for current, from /blueprints/{uuid}
  let matches = [];
  let activeIdx = -1;
  const details = new Map();
  const missionInfo = new Map();   // blueprint uuid -> Map(normalized mission title -> {factions, systems}) or false
  let missions = null;             // missionInfo for current, null while loading
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
  const fmtTime = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const status = (text, busy) => window.cargo.status('blueprints', text, busy);

  function fmtDuration(sec) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
    return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
  }
  function fmtAmount(x) {
    if (x.quantity_scu != null) return `${Number(x.quantity_scu).toLocaleString(undefined, { maximumFractionDigits: 3 })} SCU`;
    if (x.quantity != null) return `${Number(x.quantity).toLocaleString()} ×`;
    return '—';
  }

  // Keep only what the tab shows, so the offline cache stays small.
  function slim(bp) {
    const out = bp.output || {};
    return {
      uuid: bp.uuid,
      name: bp.output_name || out.name || bp.key || 'Unknown item',
      type: out.type_label || out.type || '',
      grade: out.grade || '',
      time: bp.craft_time_seconds,
      def: !!bp.is_available_by_default,
      version: bp.game_version || '',
      missions: bp.unlocking_missions_count || 0,
      web: bp.web_url || '',
      ingredients: (bp.ingredients || []).map((i) => ({
        name: i.name, kind: i.kind, quantity: i.quantity, quantity_scu: i.quantity_scu
      })),
      dismantle: (bp.dismantle_returns || []).map((d) => ({ name: d.name, quantity_scu: d.quantity_scu }))
    };
  }

  async function fetchAll() {
    const page = (n) => window.wiki.get(`blueprints?page[size]=${PAGE_SIZE}&page[number]=${n}`);
    const first = await page(1);
    const last = Math.min((first.meta && first.meta.last_page) || 1, 50);
    const rest = [];
    for (let n = 2; n <= last; n++) rest.push(page(n));
    const pages = [first, ...(await Promise.all(rest))];
    const all = pages.flatMap((p) => p.data || []).map(slim);
    const seen = new Set();
    return all.filter((x) => x.uuid && !seen.has(x.uuid) && seen.add(x.uuid))
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  async function load() {
    if (loading) return;
    loading = true;
    status('Downloading blueprints…', true);
    try {
      list = await fetchAll();
      updated = Date.now();
      details.clear();
      missionInfo.clear();
      try { localStorage.setItem(BP_CACHE_KEY, JSON.stringify({ list, updated })); } catch (e) { /* cache is optional */ }
      const v = list.find((x) => x.version)?.version;
      status(`${list.length.toLocaleString()} blueprints${v ? ` · game ${v.replace(/\.\d{6,}$/, '')}` : ''} · updated ${fmtTime(updated)}`);
    } catch (err) {
      console.error(err);
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(BP_CACHE_KEY)); } catch (e) { /* ignore */ }
      if (cached && cached.list) {
        list = cached.list; updated = cached.updated;
        status(`Offline: using blueprints from ${fmtTime(updated)}`);
      } else if (!list) {
        status('Could not reach the Star Citizen Wiki');
        showEmpty('Could not download blueprints from api.star-citizen.wiki. Check your internet connection and press Refresh.', true);
      } else {
        status(`Refresh failed, still using blueprints from ${fmtTime(updated)}`);
      }
    }
    loading = false;
    if (list) {
      b.q.disabled = false;
      if (!id('view-blueprints').hidden && !current) b.q.focus();
      if (current) {
        const again = list.find((x) => x.uuid === current.uuid);
        if (again) select(again); else { current = null; showEmpty('That blueprint is not in the latest data.'); }
      } else if (!b.q.value) showEmpty('Start typing an item name above to see what it takes to craft it.');
    }
  }

  function showEmpty(msg, isError) {
    b.card.hidden = true;
    b.empty.hidden = false;
    b.empty.classList.toggle('error', !!isError);
    b.empty.querySelector('p').textContent = msg;
  }

  // ---------- search ----------
  function findMatches(q) {
    const n = norm(q).trim();
    if (!n) return [];
    const words = n.split(' ');
    const scored = [];
    for (const x of list) {
      const name = norm(x.name);
      let s = -1;
      if (name === n) s = 0;
      else if (name.startsWith(n)) s = 1;
      else if (name.split(' ').some((w) => w.startsWith(n))) s = 2;
      else if (name.includes(n)) s = 3;
      else if (words.every((w) => name.includes(w))) s = 4;
      if (s >= 0) scored.push([s, x]);
    }
    return scored.sort((a, c) => a[0] - c[0] || a[1].name.localeCompare(c[1].name)).map((x) => x[1]).slice(0, 30);
  }

  function highlight(name, q) {
    const t = q.trim();
    const i = name.toLowerCase().indexOf(t.toLowerCase());
    if (i < 0 || !t) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + t.length)) + '</mark>' + esc(name.slice(i + t.length));
  }

  function renderSuggest() {
    const q = b.q.value;
    b.clear.hidden = !q;
    if (!list || !q.trim()) { b.suggest.hidden = true; return; }
    matches = findMatches(q);
    activeIdx = matches.length ? 0 : -1;
    b.suggest.innerHTML = matches.length
      ? matches.map((x, i) => `<li role="option" data-i="${i}" class="${i === activeIdx ? 'active' : ''}">` +
          `<span>${highlight(x.name, q)}</span><span class="kind">${esc(x.type)}</span></li>`).join('')
      : '<li class="none">No blueprint matches that name</li>';
    b.suggest.hidden = false;
  }

  function moveActive(delta) {
    if (!matches.length) return;
    activeIdx = (activeIdx + delta + matches.length) % matches.length;
    [...b.suggest.children].forEach((li, i) => li.classList.toggle('active', i === activeIdx));
    b.suggest.children[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  async function select(x) {
    b.suggest.hidden = true;
    current = x;
    b.q.value = x.name;
    b.clear.hidden = false;
    detail = details.get(x.uuid) || null;
    missions = missionInfo.has(x.uuid) ? missionInfo.get(x.uuid) : null;
    render();
    if (missions === null && !x.def && x.missions) loadMissions(x);
    if (!detail) {
      try {
        const res = await window.wiki.get(`blueprints/${encodeURIComponent(x.uuid)}`);
        details.set(x.uuid, res.data);
        if (current && current.uuid === x.uuid) { detail = res.data; render(); }
      } catch (err) {
        console.error(err);
        if (current && current.uuid === x.uuid) { detail = false; render(); }
      }
    }
  }

  // Faction and system for each mission that rewards this blueprint (from /missions).
  async function loadMissions(x) {
    let info = false;
    try {
      const res = await window.wiki.get(`missions?filter[blueprint_name]=${enc(x.name)}&page[size]=200`);
      info = new Map();
      for (const m of res.data || []) {
        const key = norm(m.title);
        if (!info.has(key)) info.set(key, { factions: new Set(), systems: new Set() });
        const e = info.get(key);
        const f = (m.faction && m.faction.name) || m.mission_giver;
        if (f) e.factions.add(f);
        for (const sys of [].concat(m.star_systems || [])) {
          const n = typeof sys === 'string' ? sys : sys && (sys.name || sys.star_system);
          if (n) e.systems.add(n);
        }
      }
    } catch (err) {
      console.error(err);
    }
    missionInfo.set(x.uuid, info);
    if (current && current.uuid === x.uuid) { missions = info; render(); }
  }

  function missionItem(m) {
    const li = document.createElement('li');
    const t = document.createElement('div'); t.className = 'm-title';
    t.textContent = m.title || 'Unknown mission';
    if (m.count > 1) { const s = document.createElement('small'); s.textContent = ` ×${m.count} variants`; t.append(s); }
    li.append(t);
    const info = missions && missions.get(norm(m.title));
    const facts = [];
    if (info && info.factions.size) facts.push(['Faction', [...info.factions].join(', ')]);
    if (m.reward_scope) facts.push(['Type', m.reward_scope]);
    if (info && info.systems.size) facts.push(['System', [...info.systems].join(', ')]);
    if (facts.length) {
      const d = document.createElement('div'); d.className = 'm-facts';
      for (const [k, v] of facts) {
        const span = document.createElement('span');
        const lab = document.createElement('em'); lab.textContent = k;
        span.append(lab, document.createTextNode(' ' + v));
        d.append(span);
      }
      li.append(d);
    } else if (missions === null) {
      const d = document.createElement('div'); d.className = 'm-facts muted'; d.textContent = 'Loading faction…'; li.append(d);
    }
    return li;
  }

  // ---------- quality sliders ----------
  // The Wiki API gives, for each part of the recipe, how the material's quality (0-1000)
  // scales the crafted item's stats (e.g. Impact Force x0.9 at Q0 to x1.1 at Q1000).
  // Effects on the same stat from several parts multiply. We compare against Q500,
  // like the Star Citizen Wiki's own blueprint page does.
  let tune = null;   // { uuid, aspects, q: [], sel: [], groups: [{key, name, required, idx: []}], props }

  function modAt(mod, quality) {
    const segs = mod && mod.value_segments;
    if (Array.isArray(segs) && segs.length) {
      let seg = segs[0];
      for (const sg of segs) {
        if (quality >= (sg.quality_min ?? 0)) seg = sg;
        if (quality >= (sg.quality_min ?? 0) && quality <= (sg.quality_max ?? 1000)) break;
      }
      const lo = seg.quality_min ?? 0, hi = seg.quality_max ?? 1000;
      const a = seg.modifier_at_start ?? 1, z = seg.modifier_at_end ?? a;
      if (hi === lo) return z;
      const qq = Math.max(lo, Math.min(quality, hi));
      return a + (z - a) * (qq - lo) / (hi - lo);
    }
    const lo = mod?.quality_range?.min ?? 0, hi = mod?.quality_range?.max ?? 1000;
    const a = mod?.modifier_range?.at_min_quality ?? 1, z = mod?.modifier_range?.at_max_quality ?? a;
    if (hi === lo) return z;
    const qq = Math.max(lo, Math.min(quality, hi));
    return a + (z - a) * (qq - lo) / (hi - lo);
  }

  function setupTune() {
    const aspects = (detail && Array.isArray(detail.aspects) ? detail.aspects : []).filter((a) => a && a.input);
    if (tune && tune.uuid === current.uuid && tune.detail === detail) return;
    const groups = new Map();
    aspects.forEach((a, i) => {
      const sg = a.selection_group;
      if (!sg || !sg.key || !(sg.option_count > (sg.required_count || 1))) return;
      if (!groups.has(sg.key)) groups.set(sg.key, { key: sg.key, name: sg.display_name || sg.name || 'Choose', required: sg.required_count || 1, idx: [] });
      groups.get(sg.key).idx.push(i);
    });
    const props = new Map();
    for (const sp of detail.summary_properties || []) if (sp.property_key) props.set(sp.property_key, sp);
    for (const a of aspects) for (const m of a.modifiers || []) if (m.property_key && !props.has(m.property_key)) props.set(m.property_key, m);
    tune = {
      uuid: current.uuid, detail, aspects, groups: [...groups.values()], props,
      q: aspects.map((a) => a.initial_quality ?? 500),
      sel: aspects.map((a) => a.is_selected !== false)
    };
  }

  const groupOf = (i) => tune.groups.find((g) => g.idx.includes(i));
  const baseQ = (a) => a.initial_quality ?? 500;

  function pctText(mod, rel) {
    if (Math.abs(rel - 1) < 0.0005) return ['No change', 'neutral'];
    const pct = `${rel > 1 ? '+' : '−'}${Math.abs((rel - 1) * 100).toFixed(1)}%`;
    if (mod.better_when === 'neutral' || !mod.better_when) return [pct, 'neutral'];
    const better = mod.better_when === 'lower' ? rel < 1 : rel > 1;
    return [`${pct} ${better ? 'better' : 'worse'}`, better ? 'up' : 'down'];
  }

  function renderStats() {
    const out = [];
    const incomplete = tune.groups.find((g) => g.idx.filter((i) => tune.sel[i]).length !== g.required);
    for (const [key, sp] of tune.props) {
      let base = null, cur = null;
      tune.aspects.forEach((a, i) => {
        if (!tune.sel[i]) return;
        for (const m of a.modifiers || []) {
          if (m.property_key !== key) continue;
          base = (base ?? 1) * modAt(m, baseQ(a));
          cur = (cur ?? 1) * modAt(m, tune.q[i]);
        }
      });
      if (base == null) continue;
      out.push([sp, base ? cur / base : cur]);
    }
    b.tuneStats.textContent = '';
    if (incomplete) {
      b.tuneStats.innerHTML = `<p class="muted">Pick ${incomplete.required} option${incomplete.required === 1 ? '' : 's'} in ${esc(incomplete.name)} to see the stats.</p>`;
      return;
    }
    if (!out.length) { b.tuneStats.innerHTML = '<p class="muted">Material quality does not change this item’s stats.</p>'; return; }
    for (const [sp, rel] of out) {
      const row = document.createElement('div'); row.className = 'stat';
      const [txt, tone] = pctText(sp, rel);
      const name = document.createElement('span'); name.textContent = sp.label || sp.property_key;
      const bar = document.createElement('span'); bar.className = 'stat-bar';
      const fill = document.createElement('i');
      const dev = Math.max(-1, Math.min(1, (rel - 1) / 0.4));      // ±40% fills the bar
      fill.className = tone;
      fill.style.left = dev < 0 ? `${50 + dev * 50}%` : '50%';
      fill.style.width = `${Math.abs(dev) * 50}%`;
      bar.append(fill);
      const val = document.createElement('b'); val.className = tone; val.textContent = txt;
      const mult = document.createElement('small'); mult.textContent = `×${rel.toFixed(3)}`;
      val.append(mult);
      row.append(name, bar, val);
      b.tuneStats.append(row);
    }
  }

  function renderTune() {
    if (!detail) {
      b.tuneCard.hidden = false;
      b.tune.innerHTML = `<p class="muted">${detail === false ? 'Could not load quality data.' : 'Loading quality data…'}</p>`;
      b.tuneStats.textContent = '';
      b.tuneReset.hidden = true;
      return;
    }
    setupTune();
    const live = tune.aspects.some((a) => (a.modifiers || []).length);
    b.tuneCard.hidden = !tune.aspects.length;
    if (!live) {
      b.tune.innerHTML = '<p class="muted">Material quality does not change this item’s stats.</p>';
      b.tuneStats.textContent = ''; b.tuneReset.hidden = true;
      b.tuneCard.querySelectorAll('.stats-h, .hint').forEach((e) => { e.hidden = true; });
      return;
    }
    b.tuneCard.querySelectorAll('.stats-h, .hint').forEach((e) => { e.hidden = false; });
    b.tune.textContent = '';
    if (tune.aspects.length > 1) {
      const all = document.createElement('div'); all.className = 'tune-row all';
      all.innerHTML = '<div class="tune-label"><b>All materials</b><small>Move every slider at once</small></div>';
      const r = document.createElement('input'); r.type = 'range'; r.min = 0; r.max = 1000; r.step = 10;
      const allQ = tune.q.every((v) => v === tune.q[0]) ? tune.q[0] : 500; r.value = allQ;
      const out = document.createElement('output'); out.textContent = `Q${allQ}`;
      r.addEventListener('input', () => {
        out.textContent = `Q${r.value}`;
        tune.aspects.forEach((a, i) => { tune.q[i] = Math.max(a.slider_min ?? 0, Math.min(+r.value, a.slider_max ?? 1000)); });
        b.tune.querySelectorAll('.tune-row[data-i]').forEach((row) => paintRow(row, +row.dataset.i));
        renderStats(); b.tuneReset.hidden = tune.q.every((v, i) => v === baseQ(tune.aspects[i]));
      });
      all.append(r, out);
      b.tune.append(all);
    }
    let lastGroup = null;
    tune.aspects.forEach((a, i) => {
      const g = groupOf(i);
      if (g && g !== lastGroup) {
        const h = document.createElement('div'); h.className = 'tune-group';
        h.textContent = `${g.name}: pick ${g.required} of ${g.idx.length}`;
        b.tune.append(h);
      }
      lastGroup = g;
      const row = document.createElement('div'); row.className = 'tune-row'; row.dataset.i = i;
      const lab = document.createElement('div'); lab.className = 'tune-label';
      const nm = document.createElement('b'); nm.textContent = a.input.name || 'Material';
      const part = document.createElement('small'); part.textContent = a.name && a.name !== a.input.name ? a.name : '';
      lab.append(nm, part);
      if (g) {
        const t = document.createElement('label'); t.className = 'pick';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = tune.sel[i];
        cb.addEventListener('change', () => {
          const on = g.idx.filter((k) => tune.sel[k]).length;
          if (cb.checked && on >= g.required) {
            if (g.required === 1) g.idx.forEach((k) => { tune.sel[k] = false; }); else { cb.checked = false; return; }
          }
          tune.sel[i] = cb.checked;
          renderTune();
        });
        t.append(cb, document.createTextNode(' Use'));
        lab.append(t);
      }
      const r = document.createElement('input'); r.type = 'range';
      r.min = a.slider_min ?? 0; r.max = a.slider_max ?? 1000; r.step = 10; r.value = tune.q[i];
      r.disabled = !tune.sel[i] || !(a.modifiers || []).length;
      const out = document.createElement('output');
      const eff = document.createElement('div'); eff.className = 'tune-eff';
      r.addEventListener('input', () => {
        tune.q[i] = +r.value; paintRow(row, i); renderStats();
        b.tuneReset.hidden = tune.q.every((v, k) => v === baseQ(tune.aspects[k]));
      });
      row.append(lab, r, out, eff);
      b.tune.append(row);
      paintRow(row, i);
    });
    b.tuneReset.hidden = tune.q.every((v, i) => v === baseQ(tune.aspects[i]));
    renderStats();
  }

  function paintRow(row, i) {
    const a = tune.aspects[i];
    row.classList.toggle('off', !tune.sel[i]);
    const r = row.querySelector('input[type=range]'); r.value = tune.q[i];
    const span = (r.max - r.min) || 1;
    r.style.setProperty('--fill', `${((tune.q[i] - r.min) / span) * 100}%`);
    row.querySelector('output').textContent = tune.sel[i] ? `Q${tune.q[i]}` : 'Off';
    const eff = row.querySelector('.tune-eff');
    eff.textContent = '';
    const mods = a.modifiers || [];
    if (!mods.length) { eff.innerHTML = '<span class="muted">No effect on stats</span>'; return; }
    for (const m of mods) {
      const rel = modAt(m, tune.q[i]) / (modAt(m, baseQ(a)) || 1);
      const [txt, tone] = tune.sel[i] ? pctText(m, rel) : ['Not used', 'neutral'];
      const chip = document.createElement('span'); chip.className = `eff ${tone}`;
      chip.textContent = `${m.label || m.property_key}: ${txt}`;
      eff.append(chip);
    }
  }

  b.tuneReset.addEventListener('click', () => {
    tune.q = tune.aspects.map(baseQ);
    renderTune();
  });

  // ---------- result ----------
  // Rows for the materials table. Detail data has parts ("Frame", "Cabling") and minimum quality;
  // until it arrives (or if it fails) we show the plain ingredient list from the search data.
  function materialRows() {
    const groups = detail && Array.isArray(detail.requirement_groups) ? detail.requirement_groups : null;
    const rows = [];
    const walk = (nodes, part) => {
      for (const n of nodes || []) {
        if (n.kind === 'group' || (n.children && n.children.length)) {
          const label = n.name || part;
          const pick = n.required_count && n.children && n.required_count < n.children.length
            ? `${label || 'Choose'} (pick ${n.required_count})` : label;
          walk(n.children, pick);
        } else if (n.kind === 'resource' || n.kind === 'item' || n.name) {
          rows.push({ part: part || '', name: n.name || 'Unknown', kind: n.kind, quantity: n.quantity, quantity_scu: n.quantity_scu, q: n.min_quality });
        }
      }
    };
    if (groups && groups.length) walk(groups, '');
    if (!rows.length) {
      for (const i of current.ingredients) rows.push({ part: '', name: i.name || 'Unknown', kind: i.kind, quantity: i.quantity, quantity_scu: i.quantity_scu, q: null });
    }
    return rows;
  }

  function render() {
    const x = current;
    b.name.textContent = x.name;
    const bits = [x.type, x.grade && `Grade ${x.grade}`, x.time != null && `Craft time ${fmtDuration(x.time)}`,
      x.version && `Game ${x.version.replace(/\.\d{6,}$/, '')}`].filter(Boolean);
    b.meta.textContent = bits.join(' · ');
    b.link.hidden = !x.web;
    if (x.web) b.link.href = x.web;

    b.rows.textContent = '';
    const rows = materialRows();
    b.rows.closest('table').classList.toggle('noq', !rows.some((r) => r.q));
    for (const r of rows) {
      const tr = document.createElement('tr');
      const part = document.createElement('td'); part.className = 'muted'; part.textContent = r.part || '—';
      const mat = document.createElement('td'); mat.className = 'loc'; mat.textContent = r.name;
      const amt = document.createElement('td'); amt.className = 'num'; amt.textContent = fmtAmount(r);
      const q = document.createElement('td'); q.className = 'num'; q.textContent = r.q ? `Q${r.q}` : '—';
      tr.append(part, mat, amt, q);
      b.rows.append(tr);
    }
    if (!rows.length) b.rows.innerHTML = '<tr><td colspan="4" class="muted none-row">No materials listed for this blueprint.</td></tr>';

    // How to unlock
    b.unlock.textContent = '';
    if (x.def) {
      b.unlock.innerHTML = '<p class="good">You have this blueprint by default.</p>';
    } else if (detail === null && x.missions) {
      b.unlock.innerHTML = '<p class="muted">Loading missions…</p>';
    } else if (detail && Array.isArray(detail.unlocking_missions_grouped) && detail.unlocking_missions_grouped.length) {
      for (const g of detail.unlocking_missions_grouped) {
        const h = document.createElement('div'); h.className = 'chance'; h.textContent = (g.label || 'Mission reward') + ' from mission';
        const ul = document.createElement('ul'); ul.className = 'missions';
        for (const m of g.missions || []) ul.append(missionItem(m));
        b.unlock.append(h, ul);
      }
    } else if (detail === false) {
      b.unlock.innerHTML = `<p class="muted">Could not load mission details${x.missions ? ` (${x.missions} mission${x.missions === 1 ? '' : 's'} unlock it)` : ''}.</p>`;
    } else {
      b.unlock.innerHTML = '<p class="muted">No unlocking mission is listed yet.</p>';
    }

    // Dismantle returns
    const dis = (detail && detail.dismantle_returns) || x.dismantle;
    const d = detail && detail.dismantle;
    b.dismantle.textContent = '';
    if (dis && dis.length) {
      if (d && (d.time_seconds != null || d.efficiency != null)) {
        const p = document.createElement('p'); p.className = 'muted';
        p.textContent = [d.time_seconds != null && `Takes ${fmtDuration(d.time_seconds)}`,
          d.efficiency != null && `${Math.round(d.efficiency * (d.efficiency <= 1 ? 100 : 1))}% efficiency`].filter(Boolean).join(' · ');
        b.dismantle.append(p);
      }
      const ul = document.createElement('ul'); ul.className = 'returns';
      for (const r of dis) {
        const li = document.createElement('li');
        const n = document.createElement('span'); n.textContent = r.name || 'Unknown';
        const a = document.createElement('b'); a.textContent = fmtAmount(r);
        li.append(n, a); ul.append(li);
      }
      b.dismantle.append(ul);
    } else {
      b.dismantle.innerHTML = '<p class="muted">Nothing listed.</p>';
    }

    renderTune();
    b.empty.hidden = true;
    b.card.hidden = false;
  }

  // ---------- events ----------
  b.q.addEventListener('input', renderSuggest);
  b.q.addEventListener('focus', () => { if (b.q.value && (!current || b.q.value !== current.name)) renderSuggest(); });
  b.q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') { if (activeIdx >= 0 && matches[activeIdx]) select(matches[activeIdx]); }
    else if (e.key === 'Escape') { b.suggest.hidden = true; }
  });
  b.suggest.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); select(matches[+li.dataset.i]); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#view-blueprints .search')) b.suggest.hidden = true; });
  b.clear.addEventListener('click', () => {
    b.q.value = ''; current = null; detail = null; b.clear.hidden = true; b.suggest.hidden = true;
    showEmpty('Start typing an item name above to see what it takes to craft it.');
    b.q.focus();
  });


  window.bpLoad = load;
  window.bpOpened = () => {
    if (!list && !loading) load();
    else if (list && b.card.hidden) b.q.focus();
  };

  // Download blueprints in the background at startup so the tab opens instantly.
  setTimeout(load, 1500);
})();
