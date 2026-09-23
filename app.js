/* ============================================================
   NYC Trip Dashboard
   - data + realtime sync : Supabase
   - auth                 : Supabase magic link, allow-listed emails
   - map                  : MapLibre GL JS + OpenFreeMap tiles
   - geocoding            : Nominatim (OpenStreetMap), rate limited
   ============================================================ */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.47.10/+esm';

const CFG = window.TRIP_CONFIG || {};
const sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/* ---------- reference data ---------- */
const DAYS = [
  { id: '2026-11-25', dow: 'Wed', n: '25', label: 'Wednesday, November 25' },
  { id: '2026-11-26', dow: 'Thu', n: '26', label: 'Thursday, November 26 — Thanksgiving' },
  { id: '2026-11-27', dow: 'Fri', n: '27', label: 'Friday, November 27' },
  { id: '2026-11-28', dow: 'Sat', n: '28', label: 'Saturday, November 28' },
  { id: '2026-11-29', dow: 'Sun', n: '29', label: 'Sunday, November 29' },
  { id: '2026-11-30', dow: 'Mon', n: '30', label: 'Monday, November 30 — departure' }
];
const CATS = [
  { id: 'breakfast', name: 'Breakfast',   color: '#E0A526' },
  { id: 'lunch',     name: 'Lunch',       color: '#78894A' },
  { id: 'dinner',    name: 'Dinner',      color: '#A93B2E' },
  { id: 'coffee',    name: 'Coffee',      color: '#C2796F' },
  { id: 'sights',    name: 'Sightseeing', color: '#2E7D77' },
  { id: 'show',      name: 'Show',        color: '#D4622A' },
  { id: 'travel',    name: 'Travel',      color: '#4A6B8A' },
  { id: 'other',     name: 'Other',       color: '#8A7B68' }
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const STATUSES = [
  { id: 'confirmed', name: 'Confirmed',     color: '#78894A' },
  { id: 'tentative', name: 'Tentative',     color: '#E0A526' },
  { id: 'needsres',  name: 'Needs booking', color: '#A93B2E' },
  { id: 'question',  name: 'Open question', color: '#4A6B8A' },
  { id: 'optional',  name: 'Optional',      color: '#8A7B68' }
];
const STAT = Object.fromEntries(STATUSES.map(s => [s.id, s]));

const LOCATING = [
  'Walking the block…', 'Asking a cabbie…', 'Checking the cross streets…',
  'Reading the avenue signs…', 'Somewhere between 5th and 6th…', 'Consulting the subway map…',
  'Hailing a yellow cab…', 'Counting blocks uptown…', 'Looking for the awning…', 'Pinning it down…'
];

/* ---------- utilities ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + (m ? ':' + String(m).padStart(2, '0') : '') + ap;
}
function fmtDur(m) {
  if (!m) return '';
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), r = m % 60;
  return h + 'h' + (r ? ' ' + r + 'm' : '');
}
function money(n) {
  n = Number(n) || 0;
  return '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', {
    minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2
  });
}
function totalCost(e) {
  const base = (Number(e.costPerPerson) || 0) * (Number(e.people) || 0);
  const ex = (e.extras || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return base + ex;
}
function sortEvents(a, b) {
  if (!a.time && !b.time) return (a.title || '').localeCompare(b.title || '');
  if (!a.time) return 1;
  if (!b.time) return -1;
  return a.time.localeCompare(b.time);
}
function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const la1 = a.lat * rad, la2 = b.lat * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function legText(m) {
  const mi = m / 1609.34;
  const mins = Math.max(1, Math.round(m / 80));   // ~80 m/min walking
  const blocks = Math.round(m / 80);              // NYC short block ≈ 80 m
  const dist = mi < 0.1 ? Math.round(m) + ' m' : mi.toFixed(mi < 1 ? 2 : 1) + ' mi';
  if (mi > 2.5) return dist + ' · too far to walk';
  return dist + ' · about ' + blocks + ' block' + (blocks === 1 ? '' : 's') + ' · ' + mins + ' min walk';
}
function hasLoc(e) { return Number.isFinite(e.lat) && Number.isFinite(e.lng); }

/* ---------- row mapping: database snake_case <-> app camelCase ---------- */
function fromRow(r) {
  return {
    id: r.id,
    day: typeof r.day === 'string' ? r.day.slice(0, 10) : r.day,
    time: r.time || '',
    durationMin: r.duration_min ?? 60,
    title: r.title || '',
    address: r.address || '',
    category: r.category || 'other',
    status: r.status || 'confirmed',
    link: r.link || '',
    notes: r.notes || '',
    people: r.people ?? 0,
    costPerPerson: Number(r.cost_per_person) || 0,
    extras: Array.isArray(r.extras) ? r.extras : [],
    needsReservation: !!r.needs_reservation,
    booked: !!r.booked,
    confirmation: r.confirmation || '',
    reservationTime: r.reservation_time || '',
    lat: r.lat == null ? null : Number(r.lat),
    lng: r.lng == null ? null : Number(r.lng),
    geoStatus: r.geo_status || 'idle',
    geoResolved: r.geo_resolved || '',
    updatedBy: r.updated_by || ''
  };
}
function toRow(e) {
  return {
    day: e.day,
    time: e.time || null,
    duration_min: e.durationMin || 0,
    title: e.title,
    address: e.address || '',
    category: e.category,
    status: e.status,
    link: e.link || '',
    notes: e.notes || '',
    people: e.people || 0,
    cost_per_person: e.costPerPerson || 0,
    extras: e.extras || [],
    needs_reservation: !!e.needsReservation,
    booked: !!e.booked,
    confirmation: e.confirmation || '',
    reservation_time: e.reservationTime || '',
    lat: Number.isFinite(e.lat) ? e.lat : null,
    lng: Number.isFinite(e.lng) ? e.lng : null,
    geo_status: e.geoStatus || 'idle',
    geo_resolved: e.geoResolved || ''
  };
}

/* ---------- state ---------- */
/* S.day holds a day id, or the sentinel ALL_DAYS for the whole-trip view.
   Category filters apply in both, which is the point of the whole-trip view —
   "show me every dinner across the trip". */
const ALL_DAYS = 'all';

const S = {
  events: [],
  day: DAYS[0].id,
  cats: new Set(CATS.map(c => c.id)),
  toBookOnly: false,
  filtersOpen: false,
  selected: null,
  session: null,
  online: true
};

/* ============================================================
   DATA LAYER — Supabase, with live sync
   ============================================================ */
const Data = {
  channel: null,

  async load() {
    const { data, error } = await sb.from('events').select('*');
    if (error) { console.error('load', error); toast('Could not load the trip: ' + error.message); return; }
    S.events = data.map(fromRow);
  },

  // Every open browser subscribes; any insert/update/delete lands here within
  // a second or so and re-renders without a refresh.
  subscribe() {
    if (this.channel) return;
    this.channel = sb.channel('events-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, payload => {
        const { eventType, new: nu, old: od } = payload;
        if (eventType === 'INSERT' || eventType === 'UPDATE') {
          const ev = fromRow(nu);
          const i = S.events.findIndex(x => x.id === ev.id);
          if (i >= 0) S.events[i] = ev; else S.events.push(ev);
        } else if (eventType === 'DELETE') {
          S.events = S.events.filter(x => x.id !== od.id);
          if (S.selected === od.id) { S.selected = null; closeSheet(); }
        }
        render();
      })
      .subscribe(status => {
        const wasOnline = S.online;
        S.online = status === 'SUBSCRIBED';
        if (wasOnline !== S.online) renderSyncBadge();
      });
  },

  async insert(e) {
    const { data, error } = await sb.from('events').insert(toRow(e)).select().single();
    if (error) { toast('Could not save: ' + error.message); return null; }
    const ev = fromRow(data);
    if (!S.events.some(x => x.id === ev.id)) S.events.push(ev);
    return ev;
  },

  async update(id, patch) {
    // optimistic: apply locally first so the UI never feels laggy
    const i = S.events.findIndex(x => x.id === id);
    const before = i >= 0 ? { ...S.events[i] } : null;
    if (i >= 0) { S.events[i] = { ...S.events[i], ...patch }; render(); }

    const { error } = await sb.from('events').update(toRow({ ...before, ...patch })).eq('id', id);
    if (error) {
      if (i >= 0 && before) S.events[i] = before;   // roll back
      render();
      toast('Could not save: ' + error.message);
      return false;
    }
    return true;
  },

  async remove(id) {
    const before = S.events.slice();
    S.events = S.events.filter(x => x.id !== id);
    render();
    const { error } = await sb.from('events').delete().eq('id', id);
    if (error) { S.events = before; render(); toast('Could not delete: ' + error.message); return false; }
    return true;
  }
};

/* ============================================================
   GEOCODING — Nominatim (OpenStreetMap)
   Free, no key. Their usage policy caps this at one request per second,
   so everything goes through a serialised queue with a deliberate gap.
   ============================================================ */
const Geo = {
  queue: [], running: false, last: 0,

  enqueue(id) {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.run();
  },

  async run() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const id = this.queue.shift();
      const ev = S.events.find(e => e.id === id);
      if (!ev) continue;
      if (!ev.title && !ev.address) { await Data.update(id, { geoStatus: 'none' }); continue; }

      const wait = 1100 - (Date.now() - this.last);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.last = Date.now();
      await this.one(ev);
    }
    this.running = false;
  },

  async one(ev) {
    await Data.update(ev.id, { geoStatus: 'pending' });

    // Try the full "name, address" first, then fall back to each on its own.
    const tries = [
      [ev.title, ev.address].filter(Boolean).join(', '),
      ev.address,
      ev.title
    ].filter(Boolean);

    for (const q of tries) {
      try {
        const url = 'https://nominatim.openstreetmap.org/search'
          + '?format=jsonv2&limit=1&addressdetails=1'
          + '&viewbox=-74.0479,40.9176,-73.9067,40.6829&bounded=0'   // nudge toward NYC
          + '&q=' + encodeURIComponent(/new york|ny\b|nyc/i.test(q) ? q : q + ', New York, NY');
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) continue;
        const hits = await res.json();
        if (!hits.length) continue;
        const lat = Number(hits[0].lat), lng = Number(hits[0].lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        await Data.update(ev.id, {
          lat, lng, geoStatus: 'ok',
          geoResolved: String(hits[0].display_name || '').slice(0, 160)
        });
        return;
      } catch (err) { /* try the next phrasing */ }
      await new Promise(r => setTimeout(r, 1100));
      this.last = Date.now();
    }
    await Data.update(ev.id, { geoStatus: 'failed' });
  }
};

/* ============================================================
   MAP — MapLibre GL JS over OpenFreeMap tiles
   ============================================================ */
const Map_ = {
  map: null, markers: [], ready: false,

  init() {
    if (this.map) return;
    this.map = new maplibregl.Map({
      container: 'map',
      style: CFG.mapStyle || 'https://tiles.openfreemap.org/styles/positron',
      center: [-73.9820, 40.7600],
      zoom: 12.4,
      attributionControl: { compact: true }
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'imperial' }), 'bottom-left');
    // OpenFreeMap asks for attribution; MapLibre renders it, we just name the source.
    this.map.addControl(new maplibregl.AttributionControl({
      customAttribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · ' +
        '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · ' +
        'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
    }));

    this.map.on('load', () => {
      this.map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1B4F4B', 'line-width': 3, 'line-opacity': 0.65,
          'line-dasharray': [1.6, 1.4]
        }
      });
      this.ready = true;
      this.draw();
    });
  },

  markerEl(e, num, selected) {
    const c = CAT[e.category] || CAT.other;
    const el = document.createElement('button');
    el.className = 'mk' + (selected ? ' sel' : '');
    el.type = 'button';
    el.style.background = c.color;
    el.setAttribute('aria-label', e.title || 'Stop');
    el.textContent = num;
    el.addEventListener('click', ev => { ev.stopPropagation(); openDetail(e.id); });
    return el;
  },

  draw(fit = false) {
    if (!this.ready) return;
    this.markers.forEach(m => m.remove());
    this.markers = [];

    const list = visibleEvents().filter(hasLoc);
    list.forEach((e, i) => {
      const m = new maplibregl.Marker({ element: this.markerEl(e, i + 1, S.selected === e.id), anchor: 'center' })
        .setLngLat([e.lng, e.lat])
        .addTo(this.map);
      this.markers.push(m);
    });

    this.map.getSource('route').setData(
      list.length > 1
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: list.map(e => [e.lng, e.lat]) } }
        : { type: 'FeatureCollection', features: [] }
    );

    const empty = $('#mapEmpty');
    if (!list.length) {
      empty.hidden = false;
      empty.textContent = visibleEvents().length ? 'Finding these stops on the map…' : 'Nothing on the map for this view';
    } else empty.hidden = true;

    if (fit && list.length) this.fit(list);
  },

  fit(list) {
    list = list || visibleEvents().filter(hasLoc);
    if (!this.ready || !list.length) return;
    if (list.length === 1) { this.map.easeTo({ center: [list[0].lng, list[0].lat], zoom: 15 }); return; }
    const b = new maplibregl.LngLatBounds();
    list.forEach(e => b.extend([e.lng, e.lat]));
    this.map.fitBounds(b, { padding: { top: 60, bottom: 70, left: 50, right: 50 }, maxZoom: 16, duration: 600 });
  },

  focus(e) {
    if (!this.ready || !hasLoc(e)) return;
    this.map.easeTo({ center: [e.lng, e.lat], zoom: Math.max(this.map.getZoom(), 15), duration: 500 });
  }
};

/* ---------- filtering ---------- */
function visibleEvents() {
  if (S.toBookOnly) {
    return S.events
      .filter(e => e.needsReservation && !e.booked)
      .sort((a, b) => (a.day + (a.time || 'zz')).localeCompare(b.day + (b.time || 'zz')));
  }
  if (S.day === ALL_DAYS) {
    // Chronological across the whole trip; undated stops sort to the end of
    // their own day, same rule as a single day view.
    return S.events
      .filter(e => S.cats.has(e.category))
      .sort((a, b) => (a.day + (a.time || 'zz')).localeCompare(b.day + (b.time || 'zz')));
  }
  return S.events.filter(e => e.day === S.day && S.cats.has(e.category)).sort(sortEvents);
}
function toBookCount() { return S.events.filter(e => e.needsReservation && !e.booked).length; }

/* ---------- budget ---------- */
/* Cost is stored per event as people × costPerPerson + extras. Nothing rolled
   it up trip-wide, so there was no way to answer "what is this costing us".
   These deliberately read S.events directly and ignore the day/category
   filters — the question is about the whole trip, not the current view. */
function budgetTotals() {
  const priced = S.events.filter(e => totalCost(e) > 0);
  const grand = priced.reduce((s, e) => s + totalCost(e), 0);
  // "Outstanding" mirrors the To-book rule: needs a reservation, not booked yet.
  const outstanding = priced
    .filter(e => e.needsReservation && !e.booked)
    .reduce((s, e) => s + totalCost(e), 0);
  return {
    grand,
    outstanding,
    committed: grand - outstanding,
    pricedCount: priced.length,
    unpricedCount: S.events.length - priced.length
  };
}
function budgetByDay() {
  return DAYS.map(d => {
    const evs = S.events.filter(e => e.day === d.id);
    return {
      label: d.dow + ' ' + d.n,
      sub: d.label.replace(/^[A-Za-z]+, /, ''),
      color: 'var(--petrol)',
      total: evs.reduce((s, e) => s + totalCost(e), 0),
      count: evs.filter(e => totalCost(e) > 0).length
    };
  });
}
function budgetByCat() {
  return CATS.map(c => {
    const evs = S.events.filter(e => e.category === c.id);
    return {
      label: c.name,
      color: c.color,
      total: evs.reduce((s, e) => s + totalCost(e), 0),
      count: evs.filter(e => totalCost(e) > 0).length
    };
  }).filter(r => r.total > 0).sort((a, b) => b.total - a.total);
}
function budgetRanked() {
  return S.events.filter(e => totalCost(e) > 0).sort((a, b) => totalCost(b) - totalCost(a));
}

/* ---------- render: chrome ---------- */
function renderRail() {
  const allPend = S.events.some(e => e.needsReservation && !e.booked);
  const all = `<button class="day day-all" role="tab" data-day="${ALL_DAYS}" aria-selected="${!S.toBookOnly && S.day === ALL_DAYS}">
      <span>Trip</span><b>All</b><i>${S.events.length}${allPend ? '<span class="dot"></span>' : ''}</i>
    </button>`;
  $('#rail').innerHTML = all + DAYS.map(d => {
    const n = S.events.filter(e => e.day === d.id).length;
    const pend = S.events.some(e => e.day === d.id && e.needsReservation && !e.booked);
    return `<button class="day" role="tab" data-day="${d.id}" aria-selected="${!S.toBookOnly && S.day === d.id}">
      <span>${d.dow}</span><b>${d.n}</b><i>${n}${pend ? '<span class="dot"></span>' : ''}</i>
    </button>`;
  }).join('');
}
function renderChips() {
  $('#chips').innerHTML = CATS.map(c => {
    const on = S.cats.has(c.id);
    return `<button class="chip" data-cat="${c.id}" aria-pressed="${on}" style="color:${on ? 'var(--paper)' : c.color};border-color:${c.color}">
      <i class="sw"></i>${c.name}</button>`;
  }).join('');
  // Collapsible filter panel. The button carries the active-filter state so
  // a narrowed view is never invisible while the panel is shut.
  const on = S.cats.size, allOn = on === CATS.length;
  $('#filterN').textContent = allOn ? 'All' : `${on}/${CATS.length}`;
  $('#filterBtn').setAttribute('aria-expanded', S.filtersOpen);
  $('#filterBtn').classList.toggle('narrowed', !allOn);
  $('#filterPanel').hidden = !S.filtersOpen;

  const n = toBookCount();
  $('#tobookN').textContent = n;
  $('#tobook').setAttribute('aria-pressed', S.toBookOnly);
  $('#tobook').hidden = n === 0 && !S.toBookOnly;
  $('#mastCount').textContent = S.events.length + ' stops';

  // The toolbar button carries the trip total, so the headline number is
  // visible without opening anything. Unlike To book this is never hidden at
  // zero: the seeded itinerary has no costs yet, and a hidden button would
  // make the budget undiscoverable exactly when it is most needed.
  $('#budgetN').textContent = money(budgetTotals().grand);
}
function renderSyncBadge() {
  const el = $('#sync');
  if (!el) return;
  el.className = 'sync' + (S.online ? ' on' : '');
  el.title = S.online ? 'Live — changes sync to both phones' : 'Reconnecting…';
}

/* ---------- render: list ---------- */
function statusTag(e) {
  const s = STAT[e.status] || STAT.confirmed;
  return `<span class="tag" style="color:${s.color}">${s.name}</span>`;
}
function renderList() {
  const list = visibleEvents();
  const el = $('#list');
  const allDays = S.day === ALL_DAYS;
  const d = DAYS.find(x => x.id === S.day);

  if (!list.length) {
    const narrowed = S.cats.size < CATS.length;
    el.innerHTML = S.toBookOnly
      ? `<div class="empty"><h3>Everything is booked</h3><p>No outstanding reservations on the trip.</p></div>`
      : allDays
        ? `<div class="daytitle">THE WHOLE TRIP</div>
           <div class="empty"><h3>Nothing matches</h3>
             <p>${S.events.length ? 'Every stop is filtered out — widen the category filter.' : 'No stops on the trip yet.'}</p>
             <button class="btn primary" data-new="1" style="display:inline-block;flex:0 0 auto;padding:11px 20px">Add the first stop</button>
           </div>`
        : `<div class="daytitle">${esc(d.label.toUpperCase())}</div>
           <div class="empty"><h3>Nothing here yet</h3>
             <p>${S.events.some(e => e.day === S.day) ? 'Every stop on this day is filtered out.' : 'This day is wide open.'}</p>
             <button class="btn primary" data-new="1" style="display:inline-block;flex:0 0 auto;padding:11px 20px">Add the first stop</button>
           </div>`;
    return;
  }

  let html = S.toBookOnly
    ? `<div class="daytitle">STILL TO BOOK — ${list.length} ITEM${list.length === 1 ? '' : 'S'}</div>`
    : allDays
      ? `<div class="daytitle">THE WHOLE TRIP — ${list.length} STOP${list.length === 1 ? '' : 'S'}</div>`
      : `<div class="daytitle">${esc(d.label.toUpperCase())}</div>`;

  let pinIdx = 0;
  let curDay = null;
  list.forEach((e, i) => {
    const c = CAT[e.category] || CAT.other;
    const placed = hasLoc(e);
    if (placed) pinIdx++;
    const num = placed ? pinIdx : '·';
    const dd = DAYS.find(x => x.id === e.day);

    // Whole-trip view keeps its chronology readable by breaking on each day.
    if (allDays && e.day !== curDay) {
      curDay = e.day;
      const cnt = list.filter(x => x.day === e.day).length;
      html += `<div class="daybreak"><span>${esc((dd ? dd.label : e.day).toUpperCase())}</span><i>${cnt}</i></div>`;
    }

    const dayTag = S.toBookOnly && dd ? `<span class="tag" style="color:var(--ink-soft)">${dd.dow} ${dd.n}</span>` : '';

    let locBit = '';
    if (!placed) {
      if (e.geoStatus === 'pending') {
        locBit = `<div class="locating"><i class="blip"></i><span data-loc="${e.id}">${LOCATING[Math.floor(Math.random() * LOCATING.length)]}</span></div>`;
      } else if (e.geoStatus === 'cleared') {
        locBit = `<div class="noloc">Location removed — not on the map</div>`;
      } else if (e.geoStatus === 'failed' || e.geoStatus === 'none') {
        locBit = `<div class="noloc">No location yet — add coordinates</div>`;
      }
    }
    const res = e.needsReservation
      ? `<span class="tag ${e.booked ? 'solid' : ''}" style="${e.booked ? 'background:var(--olive)' : 'color:var(--brick)'}">${e.booked ? 'Booked' : 'Not booked'}</span>`
      : '';

    html += `<button class="stop" data-open="${e.id}">
      <div class="marker${placed ? '' : ' hollow'}" style="background:${c.color}">${num}</div>
      <div class="card">
        <div class="when">${esc(fmtTime(e.time) || 'Time TBD')}${e.durationMin ? ' · ' + fmtDur(e.durationMin) : ''}</div>
        <h3>${esc(e.title || 'Untitled stop')}</h3>
        ${e.address ? `<div class="where">${esc(e.address)}</div>` : ''}
        <div class="tags">${dayTag}<span class="tag" style="color:${c.color}">${c.name}</span>${statusTag(e)}${res}${totalCost(e) ? `<span class="tag" style="color:var(--ink-soft)">${money(totalCost(e))}</span>` : ''}</div>
        ${locBit}
      </div>
    </button>`;

    // Walking legs only make sense between consecutive stops on the SAME day.
    // In the whole-trip view the next stop may be tomorrow morning, which is
    // not a walk.
    const nxt = list[i + 1];
    if (!S.toBookOnly && nxt && nxt.day === e.day && placed && hasLoc(nxt)) {
      html += `<div class="leg">${legText(haversine({ lat: e.lat, lng: e.lng }, { lat: nxt.lat, lng: nxt.lng }))}</div>`;
    }
  });
  el.innerHTML = html;
}

function render() {
  renderRail();
  renderChips();
  renderSyncBadge();
  renderList();
  Map_.draw();
  refreshBudgetIfOpen();
}

/* rotating pending-location copy */
setInterval(() => {
  document.querySelectorAll('[data-loc]').forEach(el => {
    el.textContent = LOCATING[Math.floor(Math.random() * LOCATING.length)];
  });
}, 2600);

/* ---------- sheet plumbing ---------- */
const sheet = () => $('#sheet');
const scrim = () => $('#scrim');
let sheetMode = null;

function openSheet(title, bodyHTML, footHTML) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = bodyHTML;
  $('#sheetFoot').innerHTML = footHTML || '';
  sheet().hidden = false;
  requestAnimationFrame(() => { sheet().classList.add('open'); scrim().classList.add('open'); });
  $('#sheetBody').scrollTop = 0;
}
function closeSheet() {
  sheet().classList.remove('open');
  scrim().classList.remove('open');
  setTimeout(() => { sheet().hidden = true; }, 240);
  sheetMode = null;
  if (S.selected) { S.selected = null; Map_.draw(); }
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ---------- budget view ---------- */
const BUDGET_TABS = [
  { id: 'total', name: 'Overview' },
  { id: 'day',   name: 'By day' },
  { id: 'cat',   name: 'Category' },
  { id: 'big',   name: 'Largest' }
];
let budgetTab = 'total';

/* A labelled proportional bar. max is passed in so every row in a tab is
   scaled against the same peak rather than against itself. */
function budgetBar(label, sub, total, max, color) {
  const pct = max > 0 ? Math.max(total > 0 ? 2 : 0, Math.round((total / max) * 100)) : 0;
  return `<div class="brow">
    <div class="brow-top"><span>${esc(label)}</span><b>${money(total)}</b></div>
    <div class="bbar"><i style="width:${pct}%;background:${color}"></i></div>
    ${sub ? `<div class="brow-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

function budgetBodyHTML() {
  const t = budgetTotals();

  if (budgetTab === 'total') {
    const days = budgetByDay().filter(d => d.total > 0).sort((a, b) => b.total - a.total);
    const cats = budgetByCat();
    return `
      <div class="btotal"><span>TRIP TOTAL</span><b>${money(t.grand)}</b></div>
      <div class="bsplit">
        <div><span>COMMITTED</span><b>${money(t.committed)}</b></div>
        <div><span>STILL TO BOOK</span><b class="brick">${money(t.outstanding)}</b></div>
      </div>
      ${t.unpricedCount
        ? `<div class="bnote">${t.unpricedCount} stop${t.unpricedCount === 1 ? '' : 's'} ${t.unpricedCount === 1 ? 'has' : 'have'} no cost recorded, so this total is incomplete.</div>`
        : `<div class="bnote ok">Every stop has a cost recorded.</div>`}
      <div class="bfacts">
        ${days.length ? `<div class="d-row"><dt>PRICIEST DAY</dt><dd>${esc(days[0].label)} — ${money(days[0].total)}</dd></div>` : ''}
        ${cats.length ? `<div class="d-row"><dt>BIGGEST CATEGORY</dt><dd>${esc(cats[0].label)} — ${money(cats[0].total)}</dd></div>` : ''}
        <div class="d-row"><dt>STOPS PRICED</dt><dd>${t.pricedCount} of ${S.events.length}</dd></div>
      </div>`;
  }

  if (budgetTab === 'day') {
    const rows = budgetByDay();
    const max = Math.max(...rows.map(r => r.total), 0);
    if (!max) return `<div class="empty"><h3>No costs yet</h3><p>Add a cost to any stop and it will show up here.</p></div>`;
    return rows.map(r => budgetBar(
      r.label,
      r.total ? `${r.count} priced stop${r.count === 1 ? '' : 's'}` : 'Nothing costed yet',
      r.total, max, r.color
    )).join('');
  }

  if (budgetTab === 'cat') {
    const rows = budgetByCat();
    const max = Math.max(...rows.map(r => r.total), 0);
    if (!rows.length) return `<div class="empty"><h3>No costs yet</h3><p>Add a cost to any stop and it will show up here.</p></div>`;
    return rows.map(r => budgetBar(
      r.label, `${r.count} stop${r.count === 1 ? '' : 's'}`, r.total, max, r.color
    )).join('');
  }

  // 'big' — every priced stop, most expensive first, tap through to the stop.
  const ranked = budgetRanked();
  if (!ranked.length) return `<div class="empty"><h3>No costs yet</h3><p>Add a cost to any stop and it will show up here.</p></div>`;
  return ranked.map(e => {
    const c = CAT[e.category] || CAT.other;
    const d = DAYS.find(x => x.id === e.day);
    const out = e.needsReservation && !e.booked;
    return `<button class="bitem" data-open="${e.id}">
      <div class="bitem-main">
        <h4>${esc(e.title || 'Untitled stop')}</h4>
        <div class="tags">
          <span class="tag" style="color:var(--ink-soft)">${d ? d.dow + ' ' + d.n : ''}</span>
          <span class="tag" style="color:${c.color}">${c.name}</span>
          ${out ? `<span class="tag" style="color:var(--brick)">Not booked</span>` : ''}
        </div>
      </div>
      <b>${money(totalCost(e))}</b>
    </button>`;
  }).join('');
}

function openBudget(tab) {
  if (tab) budgetTab = tab;
  sheetMode = 'budget';
  const tabs = `<div class="btabs">${BUDGET_TABS.map(x =>
    `<button class="btab" data-btab="${x.id}" aria-pressed="${budgetTab === x.id}">${x.name}</button>`
  ).join('')}</div>`;
  openSheet('Budget', tabs + `<div class="bbody">${budgetBodyHTML()}</div>`);
}

/* Re-render the open budget sheet in place, so a realtime edit from the other
   phone updates the numbers instead of showing stale ones. */
function refreshBudgetIfOpen() {
  if (sheetMode !== 'budget' || sheet().hidden) return;
  const body = $('#sheetBody .bbody');
  const tabsEl = $('#sheetBody .btabs');
  if (!body || !tabsEl) return;
  body.innerHTML = budgetBodyHTML();
  [...tabsEl.querySelectorAll('[data-btab]')].forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.btab === budgetTab));
}

/* ---------- detail view ---------- */
function openDetail(id) {
  const e = S.events.find(x => x.id === id);
  if (!e) return;
  S.selected = id;
  Map_.draw();
  Map_.focus(e);

  const c = CAT[e.category] || CAT.other;
  const day = DAYS.find(d => d.id === e.day) || DAYS[0];
  const sameDay = S.events.filter(x => x.day === e.day).sort(sortEvents);
  const idx = sameDay.findIndex(x => x.id === e.id);
  const prev = sameDay[idx - 1], next = sameDay[idx + 1];
  const placed = hasLoc(e);
  const per = Number(e.costPerPerson) || 0;
  const extras = (e.extras || []).filter(x => x.label || x.amount);

  const resHTML = e.needsReservation ? `<div class="resbar ${e.booked ? 'booked' : ''}">
      <h4>${e.booked ? 'Booked' : 'Not booked yet'}</h4>
      <p>${e.booked
        ? (e.confirmation ? 'Confirmation ' + esc(e.confirmation) : 'No confirmation number saved.') +
          (e.reservationTime ? ' · Reservation ' + esc(fmtTime(e.reservationTime)) : '')
        : 'This one still needs a reservation.'}</p>
      <button class="quick" data-toggleres="${e.id}">${e.booked ? 'Mark as not booked' : 'Mark as booked'}</button>
    </div>` : '';

  const walk = (o, label) => {
    if (!o) return '';
    const dtxt = (placed && hasLoc(o))
      ? legText(haversine({ lat: e.lat, lng: e.lng }, { lat: o.lat, lng: o.lng }))
      : 'distance unknown';
    return `<button class="nb" data-open="${o.id}"><span>${label}</span><div>
      <b style="font-family:var(--display);font-weight:500">${esc(o.title)}</b><br>
      <span style="letter-spacing:0;font-family:var(--body);font-size:12.5px;text-transform:none;color:var(--ink-soft)">${esc(fmtTime(o.time) || 'time TBD')} · ${esc(dtxt)}</span>
    </div></button>`;
  };

  const numInView = visibleEvents().filter(hasLoc).findIndex(x => x.id === e.id) + 1;

  const body = `
    <div class="d-hero">
      <div class="marker" style="background:${c.color}">${placed && numInView ? numInView : '·'}</div>
      <div>
        <div class="when">${esc(day.dow)} ${esc(day.n)} · ${esc(fmtTime(e.time) || 'time TBD')}${e.durationMin ? ' · ' + fmtDur(e.durationMin) : ''}</div>
        <h3>${esc(e.title || 'Untitled stop')}</h3>
      </div>
    </div>
    <div class="tags" style="margin-bottom:14px">
      <span class="tag" style="color:${c.color}">${c.name}</span>${statusTag(e)}
    </div>
    ${resHTML}
    ${(per || totalCost(e) || extras.length)
      ? `<div class="costgrid">
           <div><span>PER PERSON</span><b>${money(per)}</b></div>
           <div><span>TOTAL · ${Number(e.people) || 0} PEOPLE</span><b>${money(totalCost(e))}</b></div>
         </div>`
      : `<div class="nocost">No cost recorded — add one when you know it</div>`}
    <dl class="d-rows">
      ${e.address ? `<div class="d-row"><dt>ADDRESS</dt><dd>${esc(e.address)}</dd></div>` : ''}
      <div class="d-row"><dt>LOCATION</dt><dd>${placed
        ? `${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}${e.geoResolved ? `<br><span style="color:var(--ink-soft);font-size:12.5px">matched: ${esc(e.geoResolved)}</span>` : ''}
           <br><a href="https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lng}" target="_blank" rel="noopener">Directions</a>`
        : (e.geoStatus === 'pending'
            ? `<span style="color:var(--stone)">Still looking…</span>`
            : e.geoStatus === 'cleared'
              ? `<span style="color:var(--ink-soft)">Location removed. Use “Re-locate missing pins” to look it up again.</span>`
              : `<span style="color:var(--brick)">Not placed on the map yet</span>`)}</dd></div>
      ${extras.length ? `<div class="d-row"><dt>EXTRAS</dt><dd>${extras.map(x => `${esc(x.label || 'Extra')} — ${money(x.amount)}`).join('<br>')}</dd></div>` : ''}
      ${e.link ? `<div class="d-row"><dt>LINK</dt><dd><a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.link.replace(/^https?:\/\//, ''))}</a></dd></div>` : ''}
      ${e.notes ? `<div class="d-row"><dt>NOTES</dt><dd>${esc(e.notes)}</dd></div>` : ''}
      ${e.updatedBy ? `<div class="d-row"><dt>LAST EDIT</dt><dd>${esc(e.updatedBy)}</dd></div>` : ''}
    </dl>
    ${(prev || next) ? `<div class="neighbors">${walk(prev, 'BEFORE')}${walk(next, 'AFTER')}</div>` : ''}
  `;
  sheetMode = 'detail';
  openSheet(day.dow + ' ' + day.n, body,
    `<button class="btn primary" data-edit="${e.id}">Edit stop</button>
     <button class="btn danger" data-del="${e.id}">Delete</button>`);
}

/* ---------- form ---------- */
let formState = null;

function openForm(id) {
  const existing = id ? S.events.find(e => e.id === id) : null;
  formState = existing ? JSON.parse(JSON.stringify(existing)) : {
    id: null, day: S.toBookOnly ? DAYS[0].id : S.day, title: '', address: '', category: 'sights',
    time: '', durationMin: 60, people: 4, costPerPerson: 0, extras: [], link: '', notes: '',
    status: 'confirmed', needsReservation: false, booked: false, confirmation: '',
    reservationTime: '', lat: null, lng: null, geoStatus: 'idle'
  };
  sheetMode = 'form';
  openSheet(existing ? 'Edit stop' : 'New stop', formHTML(),
    `<button class="btn ghost" data-cancel="1">Cancel</button>
     <button class="btn primary" data-save="1">${existing ? 'Save changes' : 'Add stop'}</button>`);
  wireForm();
}

function extraRow(x, i) {
  return `<div class="extra" data-i="${i}">
    <input type="text" data-ex="label" value="${esc(x.label || '')}" placeholder="Snacks, drinks…">
    <input type="number" data-ex="amount" min="0" step="0.01" value="${x.amount || 0}">
    <button type="button" data-exdel="${i}" aria-label="Remove">×</button></div>`;
}

function formHTML() {
  const f = formState;
  const placed = hasLoc(f);
  return `
  <div class="f"><label for="f-title">WHAT IS IT</label>
    <input id="f-title" type="text" value="${esc(f.title)}" placeholder="Katz's Delicatessen" autocomplete="off"></div>

  <div class="f"><label for="f-addr">ADDRESS OR NEIGHBOURHOOD</label>
    <input id="f-addr" type="text" value="${esc(f.address)}" placeholder="205 E Houston St" autocomplete="off">
    <div class="hint">Optional. The name alone is usually enough — the map pin is looked up in the background after you save.</div></div>

  <div class="f"><span class="legend">DAY</span>
    <div class="pickrow" id="f-days">${DAYS.map(d => `<button type="button" class="pick" data-day="${d.id}" aria-pressed="${f.day === d.id}">${d.dow} ${d.n}</button>`).join('')}</div></div>

  <div class="f"><span class="legend">CATEGORY</span>
    <div class="pickrow" id="f-cats">${CATS.map(c => `<button type="button" class="pick" data-cat="${c.id}" aria-pressed="${f.category === c.id}" style="color:${f.category === c.id ? 'var(--paper)' : c.color};border-color:${c.color};${f.category === c.id ? 'background:' + c.color + ';' : ''}"><i class="sw"></i>${c.name}</button>`).join('')}</div></div>

  <div class="f f2">
    <div><label for="f-time">START</label><input id="f-time" type="time" value="${esc(f.time)}"></div>
    <div><label for="f-dur">MINUTES</label><input id="f-dur" type="number" min="0" step="15" value="${f.durationMin || 0}"></div>
  </div>

  <div class="f"><span class="legend">STATUS</span>
    <div class="pickrow" id="f-stat">${STATUSES.map(s => `<button type="button" class="pick" data-stat="${s.id}" aria-pressed="${f.status === s.id}" style="color:${f.status === s.id ? 'var(--paper)' : s.color};border-color:${s.color};${f.status === s.id ? 'background:' + s.color + ';' : ''}">${s.name}</button>`).join('')}</div></div>

  <div class="f">
    <label class="check" for="f-res">
      <input id="f-res" type="checkbox" ${f.needsReservation ? 'checked' : ''}>
      <span><span class="t">This needs a reservation</span><span class="s">Track whether it's booked and keep the confirmation number.</span></span>
    </label>
    <div class="sub" id="f-ressub" ${f.needsReservation ? '' : 'hidden'}>
      <div class="f"><span class="legend">BOOKING</span>
        <div class="pickrow" id="f-booked">
          <button type="button" class="pick" data-booked="no" aria-pressed="${!f.booked}" style="border-color:var(--brick);color:${f.booked ? 'var(--brick)' : 'var(--paper)'};${f.booked ? '' : 'background:var(--brick);'}">Not booked</button>
          <button type="button" class="pick" data-booked="yes" aria-pressed="${f.booked}" style="border-color:var(--olive);color:${f.booked ? 'var(--paper)' : 'var(--olive)'};${f.booked ? 'background:var(--olive);' : ''}">Booked</button>
        </div></div>
      <div class="f f2">
        <div><label for="f-conf">CONFIRMATION</label><input id="f-conf" type="text" value="${esc(f.confirmation)}" placeholder="ABC123"></div>
        <div><label for="f-restime">RES. TIME</label><input id="f-restime" type="time" value="${esc(f.reservationTime)}"></div>
      </div>
    </div>
  </div>

  <div class="f f3">
    <div><label for="f-people">PEOPLE</label><input id="f-people" type="number" min="0" step="1" value="${f.people || 0}"></div>
    <div><label for="f-cpp">COST PER PERSON</label><input id="f-cpp" type="number" min="0" step="0.01" value="${f.costPerPerson || 0}"></div>
  </div>

  <div class="f"><span class="legend">ADDITIONAL COSTS</span>
    <div class="extras" id="f-extras">${(f.extras || []).map((x, i) => extraRow(x, i)).join('')}</div>
    <button type="button" class="addlink" id="f-addextra">+ Add a cost</button>
    <div class="hint" id="f-total"></div></div>

  <div class="f"><label for="f-link">LINK</label><input id="f-link" type="url" value="${esc(f.link)}" placeholder="https://"></div>
  <div class="f"><label for="f-notes">NOTES</label><textarea id="f-notes" placeholder="Anything worth remembering">${esc(f.notes)}</textarea></div>

  <div class="f geobox">
    <div class="geostat" id="f-geostat">${placed ? 'PIN PLACED'
      : f.geoStatus === 'pending' ? 'STILL LOOKING…'
      : f.geoStatus === 'cleared' ? 'LOCATION REMOVED'
      : 'NO PIN YET'}</div>
    <div class="f2">
      <div><label for="f-lat">LATITUDE</label><input id="f-lat" type="text" inputmode="decimal" value="${placed ? f.lat : ''}" placeholder="40.75800"></div>
      <div><label for="f-lng">LONGITUDE</label><input id="f-lng" type="text" inputmode="decimal" value="${placed ? f.lng : ''}" placeholder="-73.98550"></div>
    </div>
    <button type="button" class="addlink" id="f-relookup">↻ Look this up again</button>
    <div class="hint">Type over these any time the pin lands in the wrong spot.</div>
  </div>
  <div class="err" id="f-err" hidden></div>`;
}

function readForm() {
  const f = formState;
  f.title = $('#f-title').value.trim();
  f.address = $('#f-addr').value.trim();
  f.time = $('#f-time').value;
  f.durationMin = Math.max(0, Number($('#f-dur').value) || 0);
  f.people = Math.max(0, Number($('#f-people').value) || 0);
  f.costPerPerson = Math.max(0, Number($('#f-cpp').value) || 0);
  f.link = $('#f-link').value.trim();
  f.notes = $('#f-notes').value.trim();
  f.needsReservation = $('#f-res').checked;
  if (f.needsReservation) {
    f.confirmation = $('#f-conf').value.trim();
    f.reservationTime = $('#f-restime').value;
  } else { f.booked = false; f.confirmation = ''; f.reservationTime = ''; }
  f.extras = [...document.querySelectorAll('#f-extras .extra')].map(r => ({
    label: r.querySelector('[data-ex=label]').value.trim(),
    amount: Math.max(0, Number(r.querySelector('[data-ex=amount]').value) || 0)
  })).filter(x => x.label || x.amount);
  const la = parseFloat($('#f-lat').value), lo = parseFloat($('#f-lng').value);
  f.manualLat = Number.isFinite(la) ? la : null;
  f.manualLng = Number.isFinite(lo) ? lo : null;
  // Both fields empty is meaningfully different from "no valid number typed".
  // saveForm uses it to tell "remove this location" from "left it alone".
  f.coordsBlank = $('#f-lat').value.trim() === '' && $('#f-lng').value.trim() === '';
  return f;
}
function updateTotal() { $('#f-total').textContent = 'Total for this stop: ' + money(totalCost(readForm())); }
function showErr(m) {
  const el = $('#f-err');
  el.textContent = m; el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

function wireForm() {
  const body = $('#sheetBody');
  updateTotal();
  body.addEventListener('input', e => {
    if (e.target.matches('#f-people,#f-cpp,[data-ex]')) updateTotal();
  });
  body.addEventListener('change', e => {
    if (e.target.id === 'f-res') {
      formState.needsReservation = e.target.checked;
      $('#f-ressub').hidden = !e.target.checked;
    }
  });
  body.addEventListener('click', e => {
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) {
      formState.day = dayBtn.dataset.day;
      [...$('#f-days').children].forEach(b => b.setAttribute('aria-pressed', b === dayBtn));
      return;
    }
    const catBtn = e.target.closest('[data-cat]');
    if (catBtn) {
      formState.category = catBtn.dataset.cat;
      [...$('#f-cats').children].forEach(b => {
        const c = CAT[b.dataset.cat], on = b === catBtn;
        b.setAttribute('aria-pressed', on);
        b.style.color = on ? 'var(--paper)' : c.color;
        b.style.background = on ? c.color : 'transparent';
      });
      return;
    }
    const stBtn = e.target.closest('[data-stat]');
    if (stBtn) {
      formState.status = stBtn.dataset.stat;
      [...$('#f-stat').children].forEach(b => {
        const s = STAT[b.dataset.stat], on = b === stBtn;
        b.setAttribute('aria-pressed', on);
        b.style.color = on ? 'var(--paper)' : s.color;
        b.style.background = on ? s.color : 'transparent';
      });
      return;
    }
    const bk = e.target.closest('[data-booked]');
    if (bk) {
      formState.booked = bk.dataset.booked === 'yes';
      [...$('#f-booked').children].forEach(b => {
        const yes = b.dataset.booked === 'yes', on = (yes === formState.booked);
        b.setAttribute('aria-pressed', on);
        const col = yes ? 'var(--olive)' : 'var(--brick)';
        b.style.background = on ? col : 'transparent';
        b.style.color = on ? 'var(--paper)' : col;
      });
      return;
    }
    if (e.target.id === 'f-addextra') {
      readForm();
      formState.extras.push({ label: '', amount: 0 });
      $('#f-extras').insertAdjacentHTML('beforeend', extraRow({ label: '', amount: 0 }, formState.extras.length - 1));
      updateTotal();
      return;
    }
    const del = e.target.closest('[data-exdel]');
    if (del) { del.closest('.extra').remove(); updateTotal(); return; }

    if (e.target.id === 'f-relookup') {
      const f = readForm();
      if (!f.title && !f.address) { showErr('Give it a name or an address first.'); return; }
      if (!f.id) { showErr('Save the stop first — the lookup runs right after.'); return; }
      Data.update(f.id, { lat: null, lng: null, geoStatus: 'pending' }).then(() => Geo.enqueue(f.id));
      $('#f-geostat').textContent = 'STILL LOOKING…';
      $('#f-lat').value = ''; $('#f-lng').value = '';
      toast('Looking it up — the pin will appear when it lands.');
    }
  });
}

async function saveForm() {
  const f = readForm();
  if (!f.title) { showErr('Give the stop a name.'); $('#f-title').focus(); return; }
  const isNew = !f.id;
  const prev = isNew ? null : S.events.find(x => x.id === f.id);

  const ev = {
    id: f.id,
    day: f.day, title: f.title, address: f.address, category: f.category, time: f.time,
    durationMin: f.durationMin, people: f.people, costPerPerson: f.costPerPerson,
    extras: f.extras, link: f.link, notes: f.notes, status: f.status,
    needsReservation: f.needsReservation, booked: f.booked,
    confirmation: f.confirmation, reservationTime: f.reservationTime,
    lat: prev ? prev.lat : null, lng: prev ? prev.lng : null,
    geoStatus: prev ? prev.geoStatus : 'idle',
    geoResolved: prev ? prev.geoResolved : ''
  };

  // hand-typed coordinates always win over the lookup
  if (f.manualLat != null && f.manualLng != null) {
    ev.lat = f.manualLat; ev.lng = f.manualLng;
    ev.geoStatus = 'manual'; ev.geoResolved = 'entered by hand';
  }

  /* Blanking both coordinate fields on a stop that had a pin is an explicit
     "unmap this". Without this branch ev.lat falls back to prev.lat above, so
     the pin silently survives the save — and because ev.lat is then still
     finite, needsLookup stays false and nothing corrects it either.

     'cleared' is a distinct status rather than reusing 'failed'/'none' so the
     geocoder does not simply put the pin back on the next load. "Re-locate
     missing pins" in the ⋯ menu still picks it up, which is the deliberate
     way back. */
  const clearedCoords = !isNew && prev && hasLoc(prev) && f.coordsBlank;
  if (clearedCoords) {
    ev.lat = null; ev.lng = null;
    ev.geoStatus = 'cleared'; ev.geoResolved = '';
  }

  const placeChanged = !prev || prev.title !== ev.title || prev.address !== ev.address;
  const needsLookup = ev.geoStatus !== 'manual' && ev.geoStatus !== 'cleared' &&
    (isNew || placeChanged || !Number.isFinite(ev.lat));
  if (needsLookup) {
    ev.lat = null; ev.lng = null;
    ev.geoStatus = (ev.title || ev.address) ? 'pending' : 'none';
  }

  // Jump to the saved stop's day — unless the whole-trip view is open, which
  // already shows it.
  if (!S.toBookOnly && S.day !== ALL_DAYS) S.day = ev.day;

  let saved;
  if (isNew) saved = await Data.insert(ev);
  else { const ok = await Data.update(ev.id, ev); saved = ok ? ev : null; }
  if (!saved) return;

  closeSheet();
  render();
  if (needsLookup && (ev.title || ev.address)) {
    Geo.enqueue(saved.id);
    toast(isNew ? 'Added. Finding it on the map…' : 'Saved. Re-checking the map pin…');
  } else {
    toast(isNew ? 'Added to the plan.' : 'Saved.');
  }
}

/* ---------- global events ---------- */
document.addEventListener('click', async e => {
  const dayBtn = e.target.closest('#rail [data-day]');
  if (dayBtn) {
    S.day = dayBtn.dataset.day; S.toBookOnly = false; S.selected = null;
    render(); Map_.fit(); return;
  }

  if (e.target.closest('#filterBtn')) { S.filtersOpen = !S.filtersOpen; render(); return; }

  if (e.target.closest('[data-catall]')) { CATS.forEach(c => S.cats.add(c.id)); render(); return; }
  if (e.target.closest('[data-catnone]')) {
    // Leave one category on — an empty set means "show nothing", which reads
    // as a broken screen rather than a filter. Matches the chip rule below.
    S.cats.clear(); S.cats.add(CATS[0].id); render(); return;
  }

  const chip = e.target.closest('#chips [data-cat]');
  if (chip) {
    const id = chip.dataset.cat;
    if (S.cats.has(id)) S.cats.delete(id); else S.cats.add(id);
    if (!S.cats.size) CATS.forEach(c => S.cats.add(c.id));
    render(); return;
  }
  if (e.target.closest('#tobook')) { S.toBookOnly = !S.toBookOnly; S.selected = null; render(); Map_.fit(); return; }

  if (e.target.closest('#budget')) { openBudget(); return; }

  const btab = e.target.closest('[data-btab]');
  if (btab) { openBudget(btab.dataset.btab); return; }

  const open = e.target.closest('[data-open]');
  if (open) { openDetail(open.dataset.open); return; }

  if (e.target.closest('#fab') || e.target.closest('[data-new]')) { openForm(null); return; }

  const edit = e.target.closest('[data-edit]');
  if (edit) { openForm(edit.dataset.edit); return; }

  const del = e.target.closest('[data-del]');
  if (del) {
    const ev = S.events.find(x => x.id === del.dataset.del);
    if (ev && confirm('Delete "' + (ev.title || 'this stop') + '"?')) {
      await Data.remove(del.dataset.del);
      closeSheet(); toast('Deleted.');
    }
    return;
  }

  const tr = e.target.closest('[data-toggleres]');
  if (tr) {
    const ev = S.events.find(x => x.id === tr.dataset.toggleres);
    if (ev) {
      const next = !ev.booked;
      await Data.update(ev.id, { booked: next });
      openDetail(ev.id);
      toast(next ? 'Marked as booked.' : 'Back on the to-book list.');
    }
    return;
  }

  if (e.target.closest('[data-cancel]')) { closeSheet(); return; }
  if (e.target.closest('[data-save]')) { saveForm(); return; }

  const mb = e.target.closest('#menuBtn');
  if (mb) {
    const p = $('#menuPop');
    p.hidden = !p.hidden;
    mb.setAttribute('aria-expanded', !p.hidden);
    return;
  }
  const act = e.target.closest('#menuPop [data-act]');
  if (act) {
    $('#menuPop').hidden = true;
    $('#menuBtn').setAttribute('aria-expanded', false);
    if (act.dataset.act === 'fit') Map_.fit();
    if (act.dataset.act === 'relocate') {
      const miss = S.events.filter(x => !hasLoc(x) && (x.title || x.address) && x.geoStatus !== 'pending' && x.geoStatus !== 'manual');
      if (!miss.length) toast('Every stop with a name is already placed.');
      else { miss.forEach(x => Geo.enqueue(x.id)); toast('Looking up ' + miss.length + ' stop' + (miss.length === 1 ? '' : 's') + '…'); }
    }
    if (act.dataset.act === 'signout') { await sb.auth.signOut(); location.reload(); }
    return;
  }
  if (!e.target.closest('.menu')) {
    const p = $('#menuPop');
    if (p) p.hidden = true;
    $('#menuBtn')?.setAttribute('aria-expanded', false);
  }
});

scrimBind();
function scrimBind() {
  document.addEventListener('DOMContentLoaded', () => {
    scrim().addEventListener('click', closeSheet);
    $('#closeSheet').addEventListener('click', closeSheet);
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheet() && !sheet().hidden) closeSheet();
});

/* ============================================================
   AUTH GATE
   ============================================================ */
function showGate(msg) {
  $('#gate').hidden = false;
  $('#app').hidden = true;
  if (msg) $('#gateMsg').textContent = msg;
}
function showApp() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
}

async function sendMagicLink(email) {
  const btn = $('#gateSend');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split('#')[0] }
  });
  btn.disabled = false;
  btn.textContent = 'Send me a link';
  if (error) { $('#gateMsg').textContent = error.message; return; }
  $('#gateMsg').textContent = 'Check ' + email + ' — the link signs you straight in.';
}

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;

  if (!session) {
    showGate('');
    $('#gateForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const email = $('#gateEmail').value.trim();
      if (email) sendMagicLink(email);
    });
    return;
  }

  showApp();
  Map_.init();
  await Data.load();

  // Signed in but not on the allow-list: RLS returns nothing.
  const { count } = await sb.from('trip_members').select('email', { count: 'exact', head: true });
  if (!count) {
    showGate('That address is signed in but is not on the trip. Add it to trip_members in Supabase.');
    return;
  }

  Data.subscribe();
  render();
  Map_.fit();

  // Anything without a pin gets queued for lookup, one at a time.
  S.events
    // 'cleared' is excluded: the location was removed on purpose, so putting
    // the pin back on every load would just undo the user's edit.
    .filter(e => !hasLoc(e) && (e.title || e.address) &&
      e.geoStatus !== 'manual' && e.geoStatus !== 'pending' && e.geoStatus !== 'cleared')
    .forEach(e => Geo.enqueue(e.id));
}

/* Only react to sign-ins that happen *after* the initial boot has settled.
   boot() is async; while it runs, #app is still hidden. Without this guard a
   SIGNED_IN event fired during boot (magic-link hash detection, or a token
   refresh) triggers a reload, which restarts boot, which reloads again — an
   infinite reload loop that renders the page partially and then discards it. */
let booted = false;

sb.auth.onAuthStateChange((event) => {
  if (!booted) return;
  if (event === 'SIGNED_IN' && $('#app').hidden) location.reload();
});

document.addEventListener('DOMContentLoaded', () => {
  boot().finally(() => { booted = true; });
});

/* exposed for the console and for Claude Code's tests */
window.S = S;
window.Data = Data;
window.Geo = Geo;
window.openDetail = openDetail;
window.openForm = openForm;
