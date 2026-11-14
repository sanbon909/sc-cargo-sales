'use strict';

// All data comes from the public UEX API (no token needed for these reads).
const API = 'https://api.uexcorp.uk/2.0/';
const CACHE_KEY = 'sc-cargo-sales:data:v1';

// UEX "status_sell" is the terminal's inventory level for a commodity it buys.
// Low inventory means high demand, so we invert it into a 0-5 demand score.
const DEMAND = {
  1: [5, 'Very high'],
  2: [4, 'High'],
  3: [3, 'Medium'],
  4: [3, 'Medium'],
  5: [2, 'Low'],
  6: [1, 'Very low'],
  7: [0, 'None (full)']
};

// UEX "status_buy" is the terminal's inventory of a commodity it sells to you (1 = empty, 7 = full).
const STOCK = {
  1: [0, 'Out of stock'],
  2: [1, 'Very low'],
  3: [2, 'Low'],
  4: [3, 'Medium'],
  5: [4, 'High'],
  6: [5, 'Very high'],
  7: [5, 'Full']
};

// Text that changes with the Sell / Buy toggle.
const MODES = {
  sell: { verb: 'sell', price: 'Latest reported sell price per SCU', level: 'Demand', scu: 'Sell up to', defaultSort: -1 },
  buy: { verb: 'buy', price: 'Latest reported buy price per SCU', level: 'Stock', scu: 'Available', defaultSort: 1 }
};

const $ = (id) => document.getElementById(id);
const els = {
  q: $('q'), clear: $('clear'), suggest: $('suggest'), status: $('status-text'), refresh: $('refresh'),
  result: $('result'), empty: $('empty'), name: $('c-name'), meta: $('c-meta'), systems: $('systems'), rows: $('rows')
};

let db = null;            // { commodities: [{id,name,kind}], sell: Map<id, rows[]>, buy: Map<id, rows[]>, updated }
let mode = 'sell';         // 'sell' = places you can sell to, 'buy' = places you can buy from
let current = null;       // selected commodity
let systemFilter = 'All';
let boxFilter = 0;          // 0 = any size
let sort = { key: 'price', dir: -1 };
let activeIdx = -1;
let matches = [];

async function getJSON(endpoint) {
  const res = await fetch(API + endpoint, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error(`${endpoint}: ${body.status}`);
  return body.data;
}

const ALL_BOXES = [1, 2, 4, 8, 16, 24, 32];

// Box sizes (SCU) the terminal accepts, e.g. "1,2,4,8,16,24,32".
// If UEX has no list, fall back to every standard size up to the terminal's max.
function parseBoxes(list, max) {
  const sizes = String(list || '').split(',').map(Number).filter((n) => n > 0);
  if (sizes.length) return [...new Set(sizes)].sort((a, b) => a - b);
  return max ? ALL_BOXES.filter((n) => n <= max) : [];
}

function buildDb(commodities, prices, terminals, updated) {
  const term = new Map(terminals.map((t) => [t.id, t]));
  const maps = { sell: new Map(), buy: new Map() };
  const add = (m, id, row) => { if (!m.has(id)) m.set(id, []); m.get(id).push(row); };
  for (const p of prices) {
    const t = term.get(p.id_terminal);
    if (!t || t.is_available_live === 0) continue;
    const base = {
      location: t.displayname || t.name,
      detail: t.city_name || t.space_station_name || t.outpost_name || t.poi_name || '',
      terminal: p.terminal_name || t.name,
      body: t.moon_name || t.planet_name || t.orbit_name || '—',
      system: t.star_system_name || 'Unknown',
      reported: (p.date_modified || 0) * 1000,  // when this terminal's prices were last reported
      boxes: parseBoxes(p.container_sizes, t.max_container_size)
    };
    base.maxBox = base.boxes.length ? base.boxes[base.boxes.length - 1] : 0;

    // Places that buy it from you (you sell here).
    if (p.price_sell > 0 || p.status_sell > 0) {
      const scu = p.scu_sell_avg || p.scu_sell || 0;
      // UEX defaults status_sell to 1 with no SCU figure when nobody has reported demand yet.
      const reported = p.status_sell > 0 && !(p.status_sell === 1 && !scu);
      const [level, levelLabel] = reported ? (DEMAND[p.status_sell] || [-1, 'Not reported']) : [-1, 'Not reported'];
      add(maps.sell, p.id_commodity, { ...base, price: p.price_sell || 0, level, levelLabel, scu });
    }
    // Places that sell it to you (you buy here).
    if (p.price_buy > 0) {
      const scu = p.scu_buy_avg || p.scu_buy || 0;
      const reported = p.status_buy > 0 && !(p.status_buy === 1 && !scu);
      const [level, levelLabel] = reported ? (STOCK[p.status_buy] || [-1, 'Not reported']) : [-1, 'Not reported'];
      add(maps.buy, p.id_commodity, { ...base, price: p.price_buy, level, levelLabel, scu });
    }
  }
  const list = commodities
    .filter((c) => maps.sell.has(c.id) || maps.buy.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind || '', illegal: !!c.is_illegal }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { commodities: list, sell: maps.sell, buy: maps.buy, updated };
}

function setStatus(text, busy) {
  els.status.textContent = text;
  els.refresh.disabled = !!busy;
  els.refresh.classList.toggle('spin', !!busy);
}

function timeAgo(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m || 1} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

async function load() {
  setStatus('Downloading latest data…', true);
  try {
    const [commodities, prices, terminals] = await Promise.all([
      getJSON('commodities'), getJSON('commodities_prices_all'), getJSON('terminals')
    ]);
    const updated = Date.now();
    db = buildDb(commodities, prices, terminals, updated);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ commodities, prices, terminals, updated })); } catch (e) { /* cache is optional */ }
    setStatus(`Updated ${fmtTime(updated)}`);
  } catch (err) {
    console.error(err);
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { /* ignore */ }
    if (cached) {
      db = buildDb(cached.commodities, cached.prices, cached.terminals, cached.updated);
      setStatus(`Offline: using data from ${fmtTime(cached.updated)}`);
    } else if (!db) {
      setStatus('Could not reach UEX');
      showEmpty('Could not download data from uexcorp.space. Check your internet connection and press Refresh.', true);
    } else {
      setStatus(`Refresh failed, still using data from ${fmtTime(db.updated)}`);
    }
  }
  if (db) {
    els.q.disabled = false;
    els.q.focus();
    if (current) select(db.commodities.find((c) => c.id === current.id) || null);
    else if (!els.q.value) showEmpty('Start typing a commodity name above to see every place you can sell it.');
  }
}

function showEmpty(msg, isError) {
  els.result.hidden = true;
  els.empty.hidden = false;
  els.empty.classList.toggle('error', !!isError);
  els.empty.querySelector('p').textContent = msg;
}

// ---------- search / autocomplete ----------
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '');

function findMatches(q) {
  const n = norm(q).trim();
  if (!n) return [];
  const scored = [];
  for (const c of db.commodities) {
    const name = norm(c.name);
    let s = -1;
    if (name === n) s = 0;
    else if (name.startsWith(n)) s = 1;
    else if (name.split(' ').some((w) => w.startsWith(n))) s = 2;
    else if (name.includes(n)) s = 3;
    if (s >= 0) scored.push([s, c]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map((x) => x[1]).slice(0, 12);
}

function highlight(name, q) {
  const i = name.toLowerCase().indexOf(q.toLowerCase().trim());
  const esc = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  if (i < 0 || !q.trim()) return esc(name);
  const end = i + q.trim().length;
  return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, end)) + '</mark>' + esc(name.slice(end));
}

function renderSuggest() {
  const q = els.q.value;
  els.clear.hidden = !q;
  if (!db || !q.trim()) { els.suggest.hidden = true; return; }
  matches = findMatches(q);
  activeIdx = matches.length ? 0 : -1;
  if (!matches.length) {
    els.suggest.innerHTML = '<li class="none">No commodity matches that name</li>';
  } else {
    els.suggest.innerHTML = matches.map((c, i) =>
      `<li role="option" data-i="${i}" class="${i === activeIdx ? 'active' : ''}">` +
      `<span>${highlight(c.name, q)}</span><span class="kind">${c.illegal ? 'Illegal · ' : ''}${c.kind}</span></li>`
    ).join('');
  }
  els.suggest.hidden = false;
}

function moveActive(delta) {
  if (!matches.length) return;
  activeIdx = (activeIdx + delta + matches.length) % matches.length;
  [...els.suggest.children].forEach((li, i) => li.classList.toggle('active', i === activeIdx));
  els.suggest.children[activeIdx].scrollIntoView({ block: 'nearest' });
}

function select(c) {
  els.suggest.hidden = true;
  if (!c) { current = null; showEmpty('That commodity is not in the latest data.'); return; }
  if (!current || current.id !== c.id) systemFilter = 'All';
  current = c;
  els.q.value = c.name;
  els.clear.hidden = false;
  renderResult();
}

// ---------- results ----------
function renderResult() {
  const M = MODES[mode];
  const all = db[mode].get(current.id) || [];
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.querySelector('th[data-key="price"]').title = M.price;
  document.querySelector('th[data-key="level"]').textContent = M.level;
  document.querySelector('th[data-key="scu"]').textContent = M.scu;
  const systems = [...new Set(all.map((r) => r.system))].sort();
  if (systemFilter !== 'All' && !systems.includes(systemFilter)) systemFilter = 'All';

  els.name.textContent = current.name;
  const sysText = systems.length === 1 ? '1 system' : `${systems.length} systems`;
  els.meta.textContent = (all.length
    ? `You can ${M.verb} this at ${all.length} place${all.length === 1 ? '' : 's'} in ${sysText}`
    : `There is nowhere to ${M.verb} this in the latest data`) +
    (current.kind ? ` · ${current.kind}` : '') + (current.illegal ? ' · Illegal' : '');

  els.systems.innerHTML = ['All', ...systems].map((s) =>
    `<button class="chip ${s === systemFilter ? 'on' : ''}" data-sys="${s}">${s}</button>`).join('');

  const rows = all.filter((r) => (systemFilter === 'All' || r.system === systemFilter) &&
    (!boxFilter || r.boxes.includes(boxFilter)));
  const { key, dir } = sort;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    const c = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return c * dir || a.location.localeCompare(b.location);
  });

  els.rows.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const loc = document.createElement('td');
    loc.className = 'loc';
    loc.textContent = r.location;
    const sub = [r.detail, r.terminal].filter((x) => x && x !== r.location);
    if (sub.length) { const s = document.createElement('small'); s.textContent = [...new Set(sub)].join(' · '); loc.append(s); }
    const body = document.createElement('td'); body.textContent = r.body;
    const sys = document.createElement('td'); sys.textContent = r.system;
    const dem = document.createElement('td');
    dem.innerHTML = `<span class="demand ${r.level < 0 ? 'dna' : 'd' + r.level}"><span class="bars"><i></i><i></i><i></i><i></i><i></i></span><span></span></span>`;
    dem.querySelector('.demand > span:last-child').textContent = r.levelLabel;
    const scu = document.createElement('td'); scu.className = 'num';
    scu.textContent = r.scu ? `${r.scu.toLocaleString()} SCU` : '—';
    const box = document.createElement('td'); box.className = 'boxes';
    if (r.boxes.length) {
      for (const n of r.boxes) { const b = document.createElement('b'); b.textContent = n; if (n === boxFilter) b.className = 'hit'; box.append(b); }
    } else box.textContent = '—';
    const price = document.createElement('td'); price.className = 'num price';
    if (r.price) {
      price.textContent = `${r.price.toLocaleString()} aUEC`;
      const ago = document.createElement('small'); ago.textContent = timeAgo(r.reported); ago.title = r.reported ? fmtTime(r.reported) : '';
      price.append(ago);
    } else price.textContent = '—';
    tr.append(loc, body, sys, price, dem, scu, box);
    els.rows.append(tr);
  }

  document.querySelectorAll('th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.key === key);
    th.classList.toggle('desc', th.dataset.key === key && dir < 0);
  });
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" class="muted none-row">${all.length ? 'No locations here take that box size.' : 'No locations found.'}</td>`;
    els.rows.append(tr);
  }
  els.empty.hidden = true;
  els.result.hidden = false;
}

// ---------- events ----------
els.q.addEventListener('input', renderSuggest);
els.q.addEventListener('focus', () => { if (els.q.value && (!current || els.q.value !== current.name)) renderSuggest(); });
els.q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
  else if (e.key === 'Enter') { if (activeIdx >= 0 && matches[activeIdx]) select(matches[activeIdx]); }
  else if (e.key === 'Escape') { els.suggest.hidden = true; }
});
els.suggest.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) { e.preventDefault(); select(matches[+li.dataset.i]); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) els.suggest.hidden = true; });
els.clear.addEventListener('click', () => {
  els.q.value = ''; current = null; els.clear.hidden = true; els.suggest.hidden = true;
  showEmpty('Start typing a commodity name above to see every place you can sell it.');
  els.q.focus();
});
els.systems.addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) { systemFilter = b.dataset.sys; renderResult(); }
});
document.querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const key = th.dataset.key;
  sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === 'price' ? MODES[mode].defaultSort : ['level', 'scu', 'maxBox'].includes(key) ? -1 : 1 };
  if (current) renderResult();
});
els.refresh.addEventListener('click', load);
document.getElementById('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === mode) return;
  mode = b.dataset.mode;
  sort = { key: 'price', dir: MODES[mode].defaultSort };  // best price first: highest to sell, lowest to buy
  document.querySelector('.sub').textContent = `Where can I ${mode} this?`;
  if (current) renderResult();
  else showEmpty(`Start typing a commodity name above to see every place you can ${mode} it.`);
});
document.getElementById('box').addEventListener('change', (e) => {
  boxFilter = +e.target.value;
  if (current) renderResult();
});

load();
