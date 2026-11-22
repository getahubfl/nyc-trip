/* ============================================================
   NYC Trip Dashboard
   - data + realtime sync : Supabase
   - auth                 : Supabase email + password, allow-listed emails
   - map                  : MapLibre GL JS + OpenFreeMap tiles
   - geocoding            : Nominatim (OpenStreetMap), rate limited
   ============================================================ */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.47.10/+esm';

/* An emailed sign-in link that has expired, or was already used, lands back
   here with the reason in the URL. Note it and strip it before the Supabase
   client starts: the client reads those parameters as a failed sign-in and
   deletes whatever session this browser already holds, so a stale link would
   sign out a phone that was signed in. The page takes no other parameters. */
const LINK_FAILED = /[?#&]error_description=/.test(location.search + location.hash);
if (LINK_FAILED) history.replaceState(null, '', location.pathname);

const CFG = window.TRIP_CONFIG || {};
const sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/* ---------- reference data ---------- */
const DAYS = [
  { id: '2026-11-25', dow: 'Wed', n: '25', label: 'Wednesday, November 25' },
  { id: '2026-11-26', dow: 'Thu', n: '26', label: 'Thursday, November 26 — Thanksgiving' },
  { id: '2026-11-27', dow: 'Fri', n: '27', label: 'Friday, November 27' },
  { id: '2026-11-28', dow: 'Sat', n: '28', label: 'Saturday, November 28 — departure' }
];
/* Category colours are pastels, drawn as subway bullets: a disc with a dark
   numeral. Measured so every pair stays distinct to normal vision; each pin
   also carries its number and an outline, so colour is never the only cue. */
const CATS = [
  { id: 'breakfast', name: 'Breakfast',   color: '#F6D55C' },   // butter
  { id: 'lunch',     name: 'Lunch',       color: '#7FD3A0' },   // mint
  { id: 'dinner',    name: 'Dinner',      color: '#F48FB1' },   // pink
  { id: 'coffee',    name: 'Coffee',      color: '#B98E6E' },   // mocha
  { id: 'matcha',    name: 'Matcha',      color: '#9DBF57' },   // matcha
  { id: 'snacks',    name: 'Snacks',      color: '#FFC9A3' },   // peach
  { id: 'sights',    name: 'Sightseeing', color: '#7FAEF0' },   // sky
  { id: 'shopping',  name: 'Shopping',    color: '#F7745E' },   // coral
  { id: 'show',      name: 'Show',        color: '#D3B6FA' },   // lavender
  { id: 'travel',    name: 'Travel',      color: '#5FCBD3' },   // aqua
  { id: 'other',     name: 'Other',       color: '#E2E2DD' }    // stone
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
// The custom properties styles.css reads to colour a bullet or a dot.
const catStyle = c => `--c:${c.color};--on:#111111`;
/* Status carries no colour of its own. Only "needs booking" is set apart, in
   the stylesheet, with the red kept for everything not yet booked. */
const STATUSES = [
  { id: 'confirmed', name: 'Confirmed' },
  { id: 'tentative', name: 'Tentative' },
  { id: 'needsres',  name: 'Needs booking' },
  { id: 'question',  name: 'Open question' },
  { id: 'optional',  name: 'Optional' }
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

/* Apple Maps links. On an iPhone these open the Maps app itself, from Safari
   and from the Home Screen app alike; anywhere else they open Maps on the web.
   Each stop is marked as a place or an exact spot (mapKind):
   - a place opens by its business name (placeName), so Maps shows the real
     place card and routes to it. sll biases the search toward the pin.
   - an exact spot opens the pin itself: a parade corner, the start of a walk.
   Without either, the address text is searched, biased toward Midtown so
   "205 E Houston St" finds the one in Manhattan wherever the phone is. */
const MIDTOWN = '40.7580,-73.9855';
const near = e => hasLoc(e) ? e.lat + ',' + e.lng : MIDTOWN;
function mapsUrl(e) {
  if (e.mapKind === 'spot' && hasLoc(e)) return `https://maps.apple.com/?ll=${e.lat},${e.lng}&q=${encodeURIComponent(e.title || 'Stop')}`;
  if (e.mapKind === 'place' && e.placeName) return `https://maps.apple.com/?q=${encodeURIComponent(e.placeName)}&sll=${near(e)}`;
  if (e.address) return `https://maps.apple.com/?q=${encodeURIComponent(e.address)}&sll=${MIDTOWN}`;
  return hasLoc(e) ? `https://maps.apple.com/?ll=${e.lat},${e.lng}&q=${encodeURIComponent(e.title || 'Stop')}` : '';
}
function mapsDirectionsUrl(e) {
  if (e.mapKind === 'place' && e.placeName)
    return 'https://maps.apple.com/?daddr=' + encodeURIComponent(e.placeName + (e.address ? ', ' + e.address : '')) + '&sll=' + near(e);
  return 'https://maps.apple.com/?daddr=' + e.lat + ',' + e.lng;
}
/* The background search may look up a stop by its name only when it is a
   place with no address. An address is always looked up, to place its pin. */
const canLookup = e => !!e.address || (e.mapKind === 'place' && !!(e.placeName || e.title));

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
    mapKind: r.map_kind || '',
    placeName: r.place_name || '',
    party: r.party || '',
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
    geo_resolved: e.geoResolved || '',
    // Only once the columns exist: PostgREST refuses unknown columns, and a
    // refused write would roll back every save.
    ...(Data.hasMapCols ? { map_kind: e.mapKind || null, place_name: e.placeName || '' } : {}),
    ...(Data.hasPartyCol ? { party: e.party || null } : {})
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
  // map_kind and place_name arrive with a one-off schema change. Until they
  // exist the app neither writes them nor shows the place/spot switch.
  hasMapCols: false,
  hasPartyCol: false,

  async load() {
    const { data, error } = await sb.from('events').select('*');
    if (error) { console.error('load', error); toast('Could not load the trip: ' + error.message); return; }
    S.events = data.map(fromRow);
    try {
      const probe = await sb.from('events').select('map_kind', { head: true });
      this.hasMapCols = !probe.error;
    } catch (err) { this.hasMapCols = false; }
    // party ('group' | 'yours') arrived after map_kind, with its own change.
    try {
      const probe = await sb.from('events').select('party', { head: true });
      this.hasPartyCol = !probe.error;
    } catch (err) { this.hasPartyCol = false; }
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
      if (!canLookup(ev)) { await Data.update(id, { geoStatus: 'none' }); continue; }

      const wait = 1100 - (Date.now() - this.last);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.last = Date.now();
      await this.one(ev);
    }
    this.running = false;
  },

  async one(ev) {
    await Data.update(ev.id, { geoStatus: 'pending' });

    /* Address first when there is one. A street address is an unambiguous
       geocode; a name is a guess that Nominatim resolves by popularity, so
       "Surprise 1" or a generic restaurant name can land anywhere in the
       world. Name-plus-address is the second try because an over-specified
       query can miss entirely, and bare name is the last resort. */
    const name = ev.placeName || ev.title;
    const byName = !ev.address;   // only reached for a place, by canLookup
    const tries = [...new Set(ev.address
      ? [ev.address, ev.mapKind === 'place' ? [name, ev.address].join(', ') : '']
      : [name]).values()].filter(Boolean);

    for (const q of tries) {
      try {
        const url = 'https://nominatim.openstreetmap.org/search'
          + '?format=jsonv2&limit=1&addressdetails=1'
          // Manhattan only: every stop is there, and an unbounded "889 Broadway"
          // lands in Brooklyn.
          + '&viewbox=-74.0300,40.8800,-73.9000,40.6800&bounded=1'
          + '&q=' + encodeURIComponent(/new york|ny\b|nyc/i.test(q) ? q : q + ', New York, NY');
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) {
          console.warn('[geo] HTTP', res.status, 'for', q);
        } else {
          const hits = await res.json();
          const lat = hits.length ? Number(hits[0].lat) : NaN;
          const lng = hits.length ? Number(hits[0].lon) : NaN;
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const a = hits[0].address || {};
            const street = [a.house_number, a.road].filter(Boolean).join(' ');
            await Data.update(ev.id, {
              lat, lng, geoStatus: 'ok',
              geoResolved: String(hits[0].display_name || '').slice(0, 160),
              // A place found by name brings its address and name back with it.
              ...(byName && street ? { address: street } : {}),
              ...(byName && !ev.placeName && hits[0].name ? { placeName: hits[0].name } : {})
            });
            return;
          }
          console.warn('[geo] no usable hit for', q);
        }
      } catch (err) {
        // Swallowing this entirely made a CORS or offline failure look
        // identical to "this place does not exist". Say so in the console.
        console.warn('[geo] request failed for', q, err);
      }
      /* This pause used to be skipped whenever a try bailed early, so the
         fallback queries fired back-to-back and Nominatim throttled them —
         turning one bad match into a total failure. It now always runs. */
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
      // One credits control, added below with the sources named. Leaving the
      // built-in one on as well showed the credits twice, one copy floating
      // over the middle of the map.
      attributionControl: false
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'imperial' }), 'bottom-left');
    // OpenFreeMap asks for attribution; MapLibre renders it, we just name the source.
    this.map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · ' +
        '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · ' +
        'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
    }));

    this.map.on('load', () => {
      /* The walking route along real streets between each pair of stops on
         the same day. Static picture, not navigation. */
      const round = { 'line-cap': 'round', 'line-join': 'round' };
      this.map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: round,
        paint: { 'line-color': '#111111', 'line-width': 2.6, 'line-opacity': 0.8 } });
      // MapLibre opens the compact credits expanded, a wide box across the
      // bottom of a phone-sized map. Start it folded to its (i) button.
      document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show').forEach(el => {
        el.classList.remove('maplibregl-compact-show');
        el.removeAttribute('open');
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
    el.style.cssText = catStyle(c);
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

    this.drawRoutes(list);

    const empty = $('#mapEmpty');
    if (!list.length) {
      empty.hidden = false;
      empty.textContent = visibleEvents().length ? 'Finding these stops on the map…' : 'Nothing on the map for this view';
    } else empty.hidden = true;

    if (fit && list.length) this.fit(list);
  },

  // Legs are consecutive stops on the same day, so they follow every edit,
  // reorder and new stop. A leg whose route has not arrived yet, or failed,
  // is drawn as a straight line until it does.
  drawRoutes(list) {
    if (!this.ready) return;
    list = list || visibleEvents().filter(hasLoc);
    const fc = lines => ({ type: 'FeatureCollection',
      features: lines.filter(c => c && c.length > 1).map(c => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c } })) });
    const straight = (a, b) => [[a.lng, a.lat], [b.lng, b.lat]];
    const pairs = [];
    if (!S.toBookOnly) for (let i = 0; i < list.length - 1; i++) if (list[i].day === list[i + 1].day) pairs.push([list[i], list[i + 1]]);
    // Where there is no walking route (from the airport), the car route.
    this.map.getSource('route').setData(fc(pairs.map(([a, b]) =>
      (Route.get('walk', a, b) || {}).path || (Route.get('car', a, b) || {}).path || straight(a, b))));
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
  },

  /* MapLibre sizes its canvas once and only re-measures when told. The
     container changes size for reasons no window resize event covers —
     opening the filter panel, the toolbar wrapping to two rows — so the
     canvas has to be nudged explicitly or it renders at a stale size. */
  resize() {
    if (this.ready && this.map) this.map.resize();
  }
};

/* ---------- layout sync ---------- */
/* The sticky header's height is subtracted from the viewport to size and
   offset the map, through a --chrome custom property that styles.css reads
   twice. Nothing ever set it, so it fell back to 0px: on desktop the map was
   laid out a full viewport tall inside a slot that is shorter by exactly the
   header, pushing its bottom off-screen, and it never re-flowed when the
   window changed. Measure it, and keep measuring. */
function syncChromeHeight() {
  const c = $('#chrome');
  if (!c) return;
  document.documentElement.style.setProperty('--chrome', c.offsetHeight + 'px');
}

let layoutTick = null;
function scheduleLayoutSync() {
  if (layoutTick) return;
  layoutTick = requestAnimationFrame(() => {
    layoutTick = null;
    syncChromeHeight();
    Map_.resize();
  });
}

function watchLayout() {
  syncChromeHeight();
  // Observing the elements themselves catches container changes that never
  // fire a window resize — the filter panel opening is the common one.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(scheduleLayoutSync);
    const chromeEl = $('#chrome'), mapEl = $('#map');
    if (chromeEl) ro.observe(chromeEl);
    if (mapEl) ro.observe(mapEl);
  }
  window.addEventListener('resize', scheduleLayoutSync);
  window.addEventListener('orientationchange', scheduleLayoutSync);
}

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
      color: 'var(--ink)',
      total: evs.reduce((s, e) => s + totalCost(e), 0),
      count: evs.filter(e => totalCost(e) > 0).length
    };
  });
}
function budgetByCat() {
  return CATS.map(c => {
    const evs = S.events.filter(e => e.category === c.id);
    return {
      id: c.id,
      label: c.name,
      color: c.color,
      total: evs.reduce((s, e) => s + totalCost(e), 0),
      count: evs.filter(e => totalCost(e) > 0).length,
      // What makes up the total, largest first.
      stops: evs.filter(e => totalCost(e) > 0).sort((a, b) => totalCost(b) - totalCost(a))
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
    return `<button class="chip" data-cat="${c.id}" aria-pressed="${on}" style="${catStyle(c)}">
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
  return `<span class="tag st-${s.id}">${s.name}</span>`;
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
        ? `<div class="daytitle">The whole trip</div>
           <div class="empty"><h3>Nothing matches</h3>
             <p>${S.events.length ? 'Every stop is filtered out — widen the category filter.' : 'No stops on the trip yet.'}</p>
             <button class="btn primary inline" data-new="1">Add the first stop</button>
           </div>`
        : `<div class="daytitle">${esc(d.label)}</div>
           <div class="empty"><h3>Nothing here yet</h3>
             <p>${S.events.some(e => e.day === S.day) ? 'Every stop on this day is filtered out.' : 'This day is wide open.'}</p>
             <button class="btn primary inline" data-new="1">Add the first stop</button>
           </div>`;
    return;
  }

  let html = S.toBookOnly
    ? `<div class="daytitle">Still to book · ${list.length}</div>`
    : allDays
      ? `<div class="daytitle">The whole trip · ${list.length} stop${list.length === 1 ? '' : 's'}</div>`
      : `<div class="daytitle">${esc(d.label)}${wxPill(Weather.day(S.day))}</div>`;

  // A single day is split into morning, afternoon and night, each headed
  // with its own forecast. Stops with no time follow, under "Anytime".
  const byPart = !S.toBookOnly && !allDays;
  let curPart;

  let pinIdx = 0;
  let curDay = null;
  const legs = [];
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
      html += `<div class="daybreak"><span>${esc(dd ? dd.label : e.day)}</span><i>${cnt}</i>${wxPill(Weather.day(e.day))}</div>`;
    }
    if (byPart && partOf(e) !== curPart) {
      // Close the part just finished, then name every part up to this one,
      // so an empty morning still shows with its weather.
      if (curPart) html += partEnd(list.filter(x => partOf(x) === curPart));
      const from = curPart === undefined ? 0 : PARTS.indexOf(curPart) + 1;
      const to = partOf(e) ? PARTS.indexOf(partOf(e)) : PARTS.length - 1;
      for (let k = from; k <= to; k++) {
        html += partHeader(S.day, PARTS[k]);
        if (k < to || !partOf(e)) html += partEnd([]);
      }
      if (!partOf(e)) html += `<div class="part"><span>Anytime<small>no start time</small></span></div>`;
      curPart = partOf(e);
    }

    const dayTag = S.toBookOnly && dd ? `<span class="tag">${dd.dow} ${dd.n}</span>` : '';

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
    /* The trip here from the stop before, on the same day, inside this card:
       time, name, then how to get here, then the map link, then the tags.
       In the whole-trip view the stop before may be yesterday's. */
    const prev = list[i - 1];
    const from = !S.toBookOnly && prev && prev.day === e.day && placed && hasLoc(prev) ? prev : null;
    if (from) legs.push([from, e]);
    const legBit = from ? `<div class="leg" data-leg="${Route.key(from, e)}" data-from="${from.id}" data-to="${e.id}">${legHTML(from, e)}</div>` : '';

    const res = e.needsReservation
      ? `<span class="tag ${e.booked ? 'booked' : 'unbooked'}">${e.booked ? 'Booked' : 'Not booked'}</span>`
      : '';

    /* The title is the button and styles.css stretches it over the whole
       row, so tapping anywhere still opens the stop. The row itself cannot be
       the button any more: the address is a link, and a link may not sit
       inside a button. */
    html += `<div class="stop">
      <div class="marker${placed ? '' : ' hollow'}" style="${catStyle(c)}">${num}</div>
      <div class="card">
        ${e.party ? `<span class="party ${e.party}">${e.party === 'group' ? 'Group' : 'Yours'}</span>` : ''}
        <div class="when">${esc(fmtTime(e.time) || 'Time TBD')}${e.durationMin ? ' · ' + fmtDur(e.durationMin) : ''}</div>
        <h3><button class="stop-open" data-open="${e.id}">${esc(e.title || 'Untitled stop')}</button></h3>
        ${legBit}
        ${(e.address || e.placeName) && mapsUrl(e) ? `<a class="where" href="${esc(mapsUrl(e))}" target="_blank" rel="noopener">${esc(e.mapKind === 'place' && e.placeName ? e.placeName + (e.address ? ' · ' + e.address : '') : e.address)}</a>` : ''}
        <div class="tags">${dayTag}<span class="tag">${c.name}</span>${statusTag(e)}${res}${totalCost(e) ? `<span class="tag">${money(totalCost(e))}</span>` : ''}</div>
        ${locBit}
      </div>
    </div>`;

  });
  // The parts of the day after the last stop still show their weather.
  if (byPart && curPart) {
    html += partEnd(list.filter(x => partOf(x) === curPart));
    for (let k = PARTS.indexOf(curPart) + 1; k < PARTS.length; k++) html += partHeader(S.day, PARTS[k]) + partEnd([]);
  }
  el.innerHTML = html;
  legs.forEach(([a, b]) => Route.request(a, b));
}

/* ============================================================
   TRAVEL BETWEEN STOPS — walking, car and subway, on every leg
   Walking and car follow real streets: OSRM on the OpenStreetMap routing
   service (routing.openstreetmap.de). Subway comes from Transitous
   (api.transitous.org), a free public-transit planner with the MTA timetable,
   asked for the time this stop ends. Both are free, keyless, and run by
   volunteers, so: one request at a time with a gap between them, only for
   the legs on screen, and every answer kept in this browser for days.

   The routing service's car time assumes empty streets — four minutes from
   Midtown to the Upper West Side. The car time shown is instead the route's
   length at Manhattan's typical traffic speed (CAR_MPH), plus a couple of
   minutes to get going, and never faster than the empty-street time.
   ============================================================ */
const CAR_MPH = 8;
const ROUTE_TTL = { walk: 30, car: 30, sub: 7 };   // days
const ROUTE_STORE = 'nyc-trip-route3:';   // 3: subway trips carry their walks to and from stations
const trim = path => path.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
// Google's encoded polyline, which Transitous uses for each leg's shape.
function decodePolyline(str, precision = 6) {
  let i = 0, lat = 0, lng = 0;
  const out = [], f = 10 ** precision;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, sh = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k) lng += d; else lat += d;
    }
    out.push([lng / f, lat / f]);
  }
  return out;
}
const Route = {
  mem: new Map(), queue: [], running: false, inflight: new Set(),

  key(a, b) { return [a.lat, a.lng, b.lat, b.lng].map(n => n.toFixed(5)).join(','); },
  // When the trip leaves the first stop, in New York time (EST in November).
  leaves(a) {
    const t = new Date(`${a.day}T${a.time || '12:00'}:00-05:00`);
    return new Date(t.getTime() + (Number(a.durationMin) || 0) * 60000);
  },
  storeKey(mode, a, b) {
    return ROUTE_STORE + mode + ':' + this.key(a, b) + (mode === 'sub' ? ':' + this.leaves(a).toISOString().slice(0, 16) : '');
  },
  get(mode, a, b) {
    const k = this.storeKey(mode, a, b);
    if (this.mem.has(k)) return this.mem.get(k);
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (v && Date.now() - v.at < ROUTE_TTL[mode] * 864e5) { this.mem.set(k, v.r); return v.r; }
    } catch (err) { /* no storage */ }
    return undefined;
  },
  put(mode, a, b, r) {
    const k = this.storeKey(mode, a, b);
    this.mem.set(k, r);
    try { localStorage.setItem(k, JSON.stringify({ at: Date.now(), r })); } catch (err) { /* no storage */ }
  },

  request(a, b) {
    for (const mode of ['walk', 'car', 'sub']) {
      const k = this.storeKey(mode, a, b);
      if (this.get(mode, a, b) !== undefined || this.inflight.has(k)) continue;
      this.inflight.add(k);
      this.queue.push([mode, a, b, k]);
    }
    this.run();
  },
  async run() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const [mode, a, b, k] = this.queue.shift();
      let r = null;
      try { r = await this.fetch(mode, a, b); } catch (err) { console.warn('[route]', mode, err); }
      // A failure is remembered as null for this page load only, so it is not
      // asked again and again, but is tried afresh next time the app opens.
      if (r) this.put(mode, a, b, r); else this.mem.set(k, null);
      this.inflight.delete(k);
      const el = document.querySelector(`[data-leg="${this.key(a, b)}"]`);
      if (el) el.innerHTML = legHTML(a, b);
      Map_.drawRoutes();
      await new Promise(res => setTimeout(res, 250));
    }
    this.running = false;
  },
  async fetch(mode, a, b) {
    if (mode === 'walk' || mode === 'car') {
      const res = await fetch(`https://routing.openstreetmap.de/routed-${mode === 'walk' ? 'foot' : 'car'}/route/v1/driving/`
        + `${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
      const r = (await res.json()).routes?.[0];
      if (!r) return null;
      // Within Manhattan, surface-street traffic sets the pace. A long leg is
      // mostly highway (the airport), where the street speed would say over two
      // hours: there, the routing time doubled for traffic.
      const miles = r.distance / 1609.34;
      const min = mode === 'walk' ? r.duration / 60
        : Math.max(r.duration / 60, miles <= 5 ? miles / CAR_MPH * 60 + 2 : r.duration / 60 * 2);
      return { m: Math.round(r.distance), min: Math.max(1, Math.round(min)),
        path: r.geometry && r.geometry.coordinates ? trim(r.geometry.coordinates) : null };
    }
    const res = await fetch(`https://api.transitous.org/api/v5/plan?fromPlace=${a.lat},${a.lng}&toPlace=${b.lat},${b.lng}`
      + `&time=${this.leaves(a).toISOString()}&numItineraries=4`);
    const its = ((await res.json()).itineraries || []).filter(it => it.legs.some(l => l.mode === 'SUBWAY'));
    if (!its.length) return { none: true };
    const best = its.reduce((x, y) => (y.duration < x.duration ? y : x));
    const lines = best.legs.filter(l => l.mode === 'SUBWAY' && l.routeShortName).map(l => l.routeShortName);
    // The whole trip is drawn: train legs solid, the walks to, between and
    // from stations dotted. A bus leg in the same trip is drawn as a walk.
    const shape = l => l.legGeometry && l.legGeometry.points ? trim(decodePolyline(l.legGeometry.points, l.legGeometry.precision ?? 6)) : null;
    const paths = best.legs.filter(l => l.mode === 'SUBWAY').map(shape).filter(Boolean);
    const walks = best.legs.filter(l => l.mode !== 'SUBWAY').map(shape).filter(Boolean);
    return { min: Math.max(1, Math.round(best.duration / 60)), lines: [...new Set(lines)], paths, walks };
  }
};

const ICON = {
  walk: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M10.5 8.5 8 21h2.2l1.6-7 2.2 2v5h2v-6.5l-2.1-2 .6-3A6.5 6.5 0 0 0 19 12v-2a4.6 4.6 0 0 1-3.9-2.2l-1-1.6A2 2 0 0 0 12.4 5L7 7.3V12h2V8.7z"/></svg>',
  car: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 6a1.5 1.5 0 0 0-1.4-1h-11a1.5 1.5 0 0 0-1.4 1L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8zM6.5 16A1.5 1.5 0 1 1 8 14.5 1.5 1.5 0 0 1 6.5 16zm11 0a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5zM5 11l1.5-4.5h11L19 11z"/></svg>',
  sub: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2.2l2-2h3.6l2 2H18v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17A1.5 1.5 0 1 1 9 15.5 1.5 1.5 0 0 1 7.5 17zM11 10H6V6h5zm5.5 7a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5zm1.5-7h-5V6h5z"/></svg>'
};
const fmtMin = n => n >= 60 ? Math.floor(n / 60) + 'h' + (n % 60 ? ' ' + (n % 60) + 'm' : '') : n + ' min';

/* Distance and blocks come from the walking route once it is in; until then,
   and if it fails, from the straight line between the pins. A mode with no
   answer yet shows a dash; one with no answer at all is left out. */
function legHTML(a, b) {
  const walk = Route.get('walk', a, b), car = Route.get('car', a, b), sub = Route.get('sub', a, b);
  const m = walk ? walk.m : haversine(a, b);
  const mi = m / 1609.34;
  const dist = mi < 0.1 ? Math.round(m) + ' m' : mi.toFixed(mi < 1 ? 2 : 1) + ' mi';
  const blocks = Math.round(m / 80);
  const chip = (mode, r, label) => r === null ? ''
    : `<span class="mode" title="${label}">${ICON[mode]}${r === undefined ? '…' : esc(fmtMin(r.min))}`
      + (mode === 'sub' && r && r.lines && r.lines.length ? `<i>${r.lines.map(esc).join(' › ')}</i>` : '') + `</span>`;
  return `<span class="dist">${dist} · about ${blocks} block${blocks === 1 ? '' : 's'}</span>`
    + `<span class="modes">${chip('walk', walk, 'Walking')}${chip('car', car, 'By car')}`
    + `${sub && sub.none ? '' : chip('sub', sub, 'By subway')}</span>`;
}
// The same, as one line of plain text, for the stop detail sheet.
function legPlain(a, b) {
  const walk = Route.get('walk', a, b), car = Route.get('car', a, b), sub = Route.get('sub', a, b);
  if (!walk) return legText(haversine(a, b));
  return [(walk.m / 1609.34).toFixed(walk.m < 1609 ? 2 : 1) + ' mi', 'walk ' + fmtMin(walk.min),
    car ? 'car ' + fmtMin(car.min) : '', sub && !sub.none ? 'subway ' + fmtMin(sub.min) : ''].filter(Boolean).join(' · ');
}

/* ============================================================
   WEATHER — Open-Meteo (api.open-meteo.com): free, no key, hourly forecasts
   up to 16 days out. Fetched once per calendar day on the phone and kept,
   so it refreshes by itself the first time the app opens each morning.
   ============================================================ */
const WX_KEY = 'nyc-trip-weather:v1';
const PARTS = [
  { id: 'morning',   name: 'Morning',   from: 0,  to: 12, hours: '6am–12pm' },   // stops before 6am count as morning
  { id: 'afternoon', name: 'Afternoon', from: 12, to: 18, hours: '12–6pm' },
  { id: 'night',     name: 'Night',     from: 18, to: 24, hours: '6pm–12am' }
];
const Weather = {
  data: null, loading: false,
  today() { return new Date().toLocaleDateString('en-CA'); },
  async load() {
    try {
      const v = JSON.parse(localStorage.getItem(WX_KEY));
      if (v && v.on === this.today()) { this.data = v.data; return; }
      if (v) this.data = v.data;   // yesterday's forecast until today's arrives
    } catch (err) { /* no storage */ }
    if (this.loading) return;
    this.loading = true;
    try {
      const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=40.758&longitude=-73.9855'
        + '&hourly=temperature_2m,weather_code,precipitation_probability'
        + '&daily=temperature_2m_max,temperature_2m_min,weather_code'
        + '&temperature_unit=fahrenheit&timezone=America%2FNew_York'
        + `&start_date=${DAYS[0].id}&end_date=${DAYS[DAYS.length - 1].id}`);
      const json = await res.json();
      if (json.daily && json.hourly) {
        this.data = { daily: json.daily, hourly: json.hourly };
        try { localStorage.setItem(WX_KEY, JSON.stringify({ on: this.today(), data: this.data })); } catch (err) { /* no storage */ }
        render();
      }
    } catch (err) { console.warn('[weather]', err); }   // no pill is the fallback
    this.loading = false;
  },
  day(id) {
    const d = this.data && this.data.daily, i = d ? d.time.indexOf(id) : -1;
    return i < 0 ? null : { hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]), code: d.weather_code[i] };
  },
  // The part of a day: its high and low, its wettest hour's chance of rain,
  // and the most telling sky (rain beats cloud beats sun).
  part(id, p) {
    const h = this.data && this.data.hourly;
    if (!h) return null;
    const idx = h.time.map((t, i) => [t, i]).filter(([t]) => t.startsWith(id) && +t.slice(11, 13) >= Math.max(p.from, 6) && +t.slice(11, 13) < p.to).map(([, i]) => i);
    if (!idx.length) return null;
    const temps = idx.map(i => h.temperature_2m[i]);
    return { hi: Math.round(Math.max(...temps)), lo: Math.round(Math.min(...temps)),
      rain: Math.max(...idx.map(i => h.precipitation_probability[i] || 0)),
      code: idx.map(i => h.weather_code[i]).sort((a, b) => wxRank(b) - wxRank(a))[0] };
  }
};
function wxKind(code) {
  if (code >= 95) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 51) return 'rain';
  if (code >= 2) return 'cloud';
  return 'sun';
}
const wxRank = code => ({ sun: 0, cloud: 1, rain: 2, snow: 3 })[wxKind(code)];
const WX_ICON = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 19a5 5 0 0 1-.6-10A6.5 6.5 0 0 1 19 9.5a4.75 4.75 0 0 1-.5 9.5z"/></svg>',
  rain: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15a5 5 0 0 1-.6-10A6.5 6.5 0 0 1 19 5.5a4.75 4.75 0 0 1-.5 9.5z"/><path d="M8 18l-1 3M12.5 18l-1 3M17 18l-1 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  snow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15a5 5 0 0 1-.6-10A6.5 6.5 0 0 1 19 5.5a4.75 4.75 0 0 1-.5 9.5z"/><circle cx="8" cy="19.5" r="1.4"/><circle cx="12.5" cy="20.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/></svg>'
};
function wxPill(w) {
  return w ? `<span class="wx">${WX_ICON[wxKind(w.code)]}${w.hi}°<i>/${w.lo}°</i></span>` : '';
}
function partHeader(dayId, p) {
  const w = Weather.part(dayId, p);
  return `<div class="part"><span>${p.name}<small>${p.hours}</small></span>${w ? `<span class="part-wx">${WX_ICON[wxKind(w.code)]}${w.lo === w.hi ? w.hi + '°' : w.lo + '–' + w.hi + '°'}${w.rain >= 30 ? `<i>${w.rain}% rain</i>` : ''}</span>` : ''}</div>`;
}
const partOf = e => e.time ? PARTS.find(p => +e.time.slice(0, 2) < p.to) : null;
// The close of a part of the day: how many stops, and from the first start
// to the last finish.
function partEnd(stops) {
  if (!stops.length) return `<div class="part-end"><span>Nothing planned</span></div>`;
  const mins = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const start = mins(stops[0].time);
  const end = Math.max(...stops.map(e => mins(e.time) + (Number(e.durationMin) || 0)));
  const clock = m => fmtTime(String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
  return `<div class="part-end"><span>${stops.length} stop${stops.length === 1 ? '' : 's'} · ${clock(start)}–${clock(end)}</span></div>`;
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
const budgetOpenCats = new Set();

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
        <div><span>STILL TO BOOK</span><b class="bad">${money(t.outstanding)}</b></div>
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
    // Each category opens to the stops behind its total. Which ones are open
    // survives a live update from the other phone.
    return rows.map(r => {
      const open = budgetOpenCats.has(r.id);
      return `<div class="bcat${open ? ' open' : ''}">
        <button class="bcat-head" data-bcat="${r.id}" aria-expanded="${open}">
          ${budgetBar(r.label, `${r.count} stop${r.count === 1 ? '' : 's'}`, r.total, max, r.color)}
          <i class="bcat-chev" aria-hidden="true"></i>
        </button>
        ${open ? `<div class="bcat-items">${r.stops.map(e => budgetItem(e, false)).join('')}</div>` : ''}
      </div>`;
    }).join('');
  }

  // 'big' — every priced stop, most expensive first, tap through to the stop.
  const ranked = budgetRanked();
  if (!ranked.length) return `<div class="empty"><h3>No costs yet</h3><p>Add a cost to any stop and it will show up here.</p></div>`;
  return ranked.map(e => budgetItem(e, true)).join('');
}

// One priced stop, tapping through to it. The category tag is left off
// inside a category, where it would only repeat the heading.
function budgetItem(e, showCat) {
  const c = CAT[e.category] || CAT.other;
  const d = DAYS.find(x => x.id === e.day);
  const out = e.needsReservation && !e.booked;
  return `<button class="bitem" data-open="${e.id}">
    <div class="bitem-main">
      <h4>${esc(e.title || 'Untitled stop')}</h4>
      <div class="tags">
        <span class="tag">${d ? d.dow + ' ' + d.n : ''}</span>
        ${showCat ? `<span class="tag">${c.name}</span>` : ''}
        ${out ? `<span class="tag unbooked">Not booked</span>` : ''}
      </div>
    </div>
    <b>${money(totalCost(e))}</b>
  </button>`;
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
      ? (label === 'BEFORE' ? legPlain(o, e) : legPlain(e, o))
      : 'distance unknown';
    return `<button class="nb" data-open="${o.id}"><span>${label}</span><div>
      <b>${esc(o.title)}</b>
      <small>${esc(fmtTime(o.time) || 'time TBD')} · ${esc(dtxt)}</small>
    </div></button>`;
  };

  const numInView = visibleEvents().filter(hasLoc).findIndex(x => x.id === e.id) + 1;

  const body = `
    <div class="d-hero">
      <div class="marker${placed ? '' : ' hollow'}" style="${catStyle(c)}">${placed && numInView ? numInView : '·'}</div>
      <div>
        <div class="when">${esc(day.dow)} ${esc(day.n)} · ${esc(fmtTime(e.time) || 'time TBD')}${e.durationMin ? ' · ' + fmtDur(e.durationMin) : ''}</div>
        <h3>${esc(e.title || 'Untitled stop')}</h3>
      </div>
    </div>
    <div class="tags d-tags">
      ${e.party ? `<span class="party ${e.party}">${e.party === 'group' ? 'Group' : 'Yours'}</span>` : ''}<span class="tag">${c.name}</span>${statusTag(e)}
    </div>
    ${resHTML}
    ${(per || totalCost(e) || extras.length)
      ? `<div class="costgrid">
           <div><span>PER PERSON</span><b>${money(per)}</b></div>
           <div><span>TOTAL${extras.length ? ' · WITH EXTRAS' : ' · ' + (Number(e.people) || 0) + ' PEOPLE'}</span><b>${money(totalCost(e))}</b></div>
         </div>
         ${extras.length ? `<div class="costmath">${money(per)} × ${Number(e.people) || 0} people = ${money(per * (Number(e.people) || 0))}`
           + extras.map(x => ` + ${esc(x.label || 'extra')} ${money(x.amount)}`).join('')
           + ` = <b>${money(totalCost(e))}</b></div>` : ''}`
      : `<div class="nocost">No cost recorded — add one when you know it</div>`}
    <dl class="d-rows">
      ${e.mapKind === 'place' && e.placeName ? `<div class="d-row"><dt>PLACE</dt><dd><a href="${esc(mapsUrl(e))}" target="_blank" rel="noopener">${esc(e.placeName)}</a></dd></div>` : ''}
      ${e.address ? `<div class="d-row"><dt>ADDRESS</dt><dd>${mapsUrl(e) && !(e.mapKind === 'place' && e.placeName) ? `<a href="${esc(mapsUrl(e))}" target="_blank" rel="noopener">${esc(e.address)}</a>` : esc(e.address)}</dd></div>` : ''}
      ${e.mapKind ? `<div class="d-row"><dt>MAPS OPENS</dt><dd>${e.mapKind === 'spot' ? 'The exact spot' : 'The place'}</dd></div>` : ''}
      <div class="d-row"><dt>LOCATION</dt><dd>${placed
        ? `${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}${e.geoResolved ? `<br><span class="muted small">matched: ${esc(e.geoResolved)}</span>` : ''}
           <br><a href="${mapsDirectionsUrl(e)}" target="_blank" rel="noopener">Directions</a>`
        : (e.geoStatus === 'pending'
            ? `<span class="muted">Still looking…</span>`
            : e.geoStatus === 'cleared'
              ? `<span class="muted">Location removed. Use “Re-locate missing pins” to look it up again.</span>`
              : `<span class="bad">Not placed on the map yet</span>`)}</dd></div>
      ${extras.length ? `<div class="d-row"><dt>EXTRAS</dt><dd>${extras.map(x => `${esc(x.label || 'Extra')} — ${money(x.amount)}`).join('<br>')}</dd></div>` : ''}
      ${e.link ? `<div class="d-row"><dt>LINK</dt><dd><a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.link.replace(/^https?:\/\//, ''))}</a></dd></div>` : ''}
      ${e.notes ? `<div class="d-row"><dt>NOTES</dt><dd class="note">${noteHTML(e.notes)}</dd></div>` : ''}
      ${e.updatedBy ? `<div class="d-row"><dt>LAST EDIT</dt><dd>${esc(e.updatedBy)}</dd></div>` : ''}
    </dl>
    ${(prev || next) ? `<div class="neighbors">${walk(prev, 'BEFORE')}${walk(next, 'AFTER')}</div>` : ''}
  `;
  sheetMode = 'detail';
  openSheet(day.dow + ' ' + day.n, body,
    `<button class="btn primary" data-edit="${e.id}">Edit stop</button>
     <button class="btn danger" data-del="${e.id}">Delete</button>`);
}

/* ---------- notes: light formatting ----------
   Notes are written in a small rich-text box (bold, italic, highlight,
   bullets, numbers) and stored as HTML holding only those few tags, with
   every attribute stripped, so pasted web content cannot carry scripts,
   links or styles into the app. Notes written before this, as plain text,
   are shown with their line breaks kept. */
const NOTE_TAGS = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', MARK: 'mark', UL: 'ul', OL: 'ol', LI: 'li', BR: 'br', DIV: 'div', P: 'div' };
const isRichNote = t => /<(b|i|mark|ul|ol|li|br|div)\b/i.test(t || '');
function cleanNote(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const walk = node => [...node.childNodes].map(n => {
    if (n.nodeType === 3) return esc(n.textContent);
    if (n.nodeType !== 1) return '';
    const inner = walk(n);
    const st = (n.getAttribute('style') || '').toLowerCase();
    // Safari's highlight and bold arrive as styled spans.
    if (n.tagName === 'SPAN' && /background/.test(st) && !/transparent|initial|inherit/.test(st)) return `<mark>${inner}</mark>`;
    if (n.tagName === 'SPAN' && /font-weight:\s*(bold|[6-9]00)/.test(st)) return `<b>${inner}</b>`;
    const tag = NOTE_TAGS[n.tagName];
    if (!tag) return inner;                    // unknown element: keep its text only
    return tag === 'br' ? '<br>' : `<${tag}>${inner}</${tag}>`;
  }).join('');
  const out = walk(doc.body).trim();
  // An emptied box leaves "<br>" or "<div><br></div>" behind: that is no note.
  return out.replace(/<[^>]+>/g, '').trim() ? out : '';
}
function noteHTML(t) {
  if (!t) return '';
  return isRichNote(t) ? cleanNote(t) : esc(t).replace(/\n/g, '<br>');
}

/* ---------- place suggestions ----------
   Photon (photon.komoot.io): free OpenStreetMap search built for
   search-as-you-type, with no key. Nominatim forbids that use, so it stays
   for the background lookup only. Guardrails: nothing under 3 characters, a
   pause after typing before asking, one request in flight (a newer one
   cancels it), Manhattan only, answers remembered, and a hard cap per page
   load so a stuck field cannot run up requests. */
const Suggest = {
  cache: new Map(), sent: 0, MAX: 60, timer: null, ctl: null, last: [],
  query(q, cb) {
    clearTimeout(this.timer);
    if (q.length < 3) { this.last = []; cb([]); return; }
    this.timer = setTimeout(async () => {
      const key = q.toLowerCase();
      if (this.cache.has(key)) { this.last = this.cache.get(key); cb(this.last); return; }
      if (this.sent >= this.MAX) return;
      if (this.ctl) this.ctl.abort();
      this.ctl = new AbortController();
      this.sent++;
      try {
        const res = await fetch('https://photon.komoot.io/api/?limit=5&lang=en'
          + '&bbox=-74.03,40.68,-73.90,40.88&lat=40.758&lon=-73.985&q=' + encodeURIComponent(q),
          { signal: this.ctl.signal });
        const json = await res.json();
        const hits = (json.features || []).map(f => ({
          name: f.properties.name || '',
          address: [f.properties.housenumber, f.properties.street].filter(Boolean).join(' '),
          lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0]
        })).filter(h => h.name && Number.isFinite(h.lat) && Number.isFinite(h.lng));
        this.cache.set(key, hits);
        this.last = hits;
        cb(hits);
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('[suggest]', err);
      }
    }, 350);
  }
};
function showSuggestions(hits) {
  const box = $('#f-suggest');
  if (!box) return;
  box.hidden = !hits.length;
  box.innerHTML = hits.map((h, i) =>
    `<button type="button" data-sug="${i}"><b>${esc(h.name)}</b>${h.address ? `<span>${esc(h.address)}</span>` : ''}</button>`).join('');
}

/* ---------- form ---------- */
let formState = null;

function openForm(id) {
  const existing = id ? S.events.find(e => e.id === id) : null;
  formState = existing ? JSON.parse(JSON.stringify(existing)) : {
    id: null, day: S.toBookOnly ? DAYS[0].id : S.day, title: '', address: '', category: 'sights',
    time: '', durationMin: 60, people: 4, costPerPerson: 0, extras: [], link: '', notes: '',
    status: 'confirmed', needsReservation: false, booked: false, confirmation: '',
    reservationTime: '', lat: null, lng: null, geoStatus: 'idle', mapKind: '', placeName: '', party: ''
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

  <div class="f" id="f-kindrow" ${Data.hasMapCols ? '' : 'hidden'}><span class="legend">MAPS OPENS</span>
    <div class="pickrow" id="f-kind">
      <button type="button" class="pick" data-kind="place" aria-pressed="${f.mapKind === 'place'}">A place</button>
      <button type="button" class="pick" data-kind="spot" aria-pressed="${f.mapKind === 'spot'}">An exact spot</button>
    </div>
    <div class="hint">A place opens its card in Apple Maps, by name. An exact spot opens the pin — a parade corner, the start of a walk.</div></div>

  <div class="f" ${Data.hasPartyCol ? '' : 'hidden'}><span class="legend">WHO</span>
    <div class="pickrow" id="f-party">
      <button type="button" class="pick" data-party="yours" aria-pressed="${f.party === 'yours'}">Yours</button>
      <button type="button" class="pick" data-party="group" aria-pressed="${f.party === 'group'}">Group</button>
    </div></div>

  <div class="f" id="f-placerow" ${f.mapKind === 'place' ? '' : 'hidden'}><label for="f-place">BUSINESS NAME</label>
    <input id="f-place" type="text" value="${esc(f.placeName)}" placeholder="Start typing — Quality Italian" autocomplete="off">
    <div class="suggest" id="f-suggest" hidden></div>
    <div class="hint">Pick a match to fill in the address and pin.</div></div>

  <div class="f"><label for="f-addr">ADDRESS OR NEIGHBOURHOOD</label>
    <input id="f-addr" type="text" value="${esc(f.address)}" placeholder="205 E Houston St" autocomplete="off">
    <div class="hint">For a place with no address, it is looked up by name after you save.</div></div>

  <div class="f"><span class="legend">DAY</span>
    <div class="pickrow" id="f-days">${DAYS.map(d => `<button type="button" class="pick" data-day="${d.id}" aria-pressed="${f.day === d.id}">${d.dow} ${d.n}</button>`).join('')}</div></div>

  <div class="f"><span class="legend">CATEGORY</span>
    <div class="pickrow" id="f-cats">${CATS.map(c => `<button type="button" class="pick" data-cat="${c.id}" aria-pressed="${f.category === c.id}" style="${catStyle(c)}"><i class="sw"></i>${c.name}</button>`).join('')}</div></div>

  <div class="f f2">
    <div><label for="f-time">START</label><input id="f-time" type="time" value="${esc(f.time)}"></div>
    <div><label for="f-dur">MINUTES</label><input id="f-dur" type="number" min="0" step="15" value="${f.durationMin || 0}"></div>
  </div>

  <div class="f"><span class="legend">STATUS</span>
    <div class="pickrow" id="f-stat">${STATUSES.map(s => `<button type="button" class="pick" data-stat="${s.id}" aria-pressed="${f.status === s.id}">${s.name}</button>`).join('')}</div></div>

  <div class="f">
    <label class="check" for="f-res">
      <input id="f-res" type="checkbox" ${f.needsReservation ? 'checked' : ''}>
      <span><span class="t">This needs a reservation</span><span class="s">Track whether it's booked and keep the confirmation number.</span></span>
    </label>
    <div class="sub" id="f-ressub" ${f.needsReservation ? '' : 'hidden'}>
      <div class="f"><span class="legend">BOOKING</span>
        <div class="pickrow" id="f-booked">
          <button type="button" class="pick no" data-booked="no" aria-pressed="${!f.booked}">Not booked</button>
          <button type="button" class="pick yes" data-booked="yes" aria-pressed="${f.booked}">Booked</button>
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
  <div class="f"><span class="legend" id="f-notes-label">NOTES</span>
    <div class="notebar" role="toolbar" aria-label="Note formatting">
      <button type="button" data-fmt="bold" aria-label="Bold"><b>B</b></button>
      <button type="button" data-fmt="italic" aria-label="Italic"><i>I</i></button>
      <button type="button" data-fmt="hilite" aria-label="Highlight"><mark>H</mark></button>
      <button type="button" data-fmt="insertUnorderedList" aria-label="Bulleted list">•&#8201;List</button>
      <button type="button" data-fmt="insertOrderedList" aria-label="Numbered list">1.&#8201;List</button>
      <button type="button" data-fmt="removeFormat" aria-label="Clear formatting">Clear</button>
    </div>
    <div id="f-notes" class="note noteedit" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="f-notes-label"
      data-placeholder="Anything worth remembering">${noteHTML(f.notes)}</div></div>

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
  f.placeName = f.mapKind === 'place' ? $('#f-place').value.trim() : '';
  f.time = $('#f-time').value;
  f.durationMin = Math.max(0, Number($('#f-dur').value) || 0);
  f.people = Math.max(0, Number($('#f-people').value) || 0);
  f.costPerPerson = Math.max(0, Number($('#f-cpp').value) || 0);
  f.link = $('#f-link').value.trim();
  f.notes = cleanNote($('#f-notes').innerHTML);
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
    if (e.target.id === 'f-place') Suggest.query(e.target.value.trim(), showSuggestions);
    if (e.target.matches('#f-people,#f-cpp,[data-ex]')) updateTotal();
  });
  body.addEventListener('change', e => {
    if (e.target.id === 'f-res') {
      formState.needsReservation = e.target.checked;
      $('#f-ressub').hidden = !e.target.checked;
    }
  });
  // A toolbar tap must not take the cursor out of the note box, or the
  // format has nothing to apply to.
  body.addEventListener('pointerdown', e => { if (e.target.closest('[data-fmt]')) e.preventDefault(); });
  body.addEventListener('mousedown', e => { if (e.target.closest('[data-fmt]')) e.preventDefault(); });
  body.addEventListener('click', e => {
    const fmt = e.target.closest('[data-fmt]');
    if (fmt) {
      const box = $('#f-notes');
      if (document.activeElement !== box) box.focus();
      const cmd = fmt.dataset.fmt;
      if (cmd === 'hilite') {
        // Toggle: an already highlighted selection is cleared.
        const sel = getSelection();
        const on = sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('mark, span[style*="background"]');
        document.execCommand('hiliteColor', false, on ? 'transparent' : '#FFF1A8');
      } else document.execCommand(cmd, false, null);
      return;
    }
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) {
      formState.day = dayBtn.dataset.day;
      [...$('#f-days').children].forEach(b => b.setAttribute('aria-pressed', b === dayBtn));
      return;
    }
    const partyBtn = e.target.closest('[data-party]');
    if (partyBtn) {
      // Tapping the chosen one again clears it.
      formState.party = formState.party === partyBtn.dataset.party ? '' : partyBtn.dataset.party;
      [...$('#f-party').children].forEach(b => b.setAttribute('aria-pressed', b.dataset.party === formState.party));
      return;
    }
    const kindBtn = e.target.closest('[data-kind]');
    if (kindBtn) {
      formState.mapKind = kindBtn.dataset.kind;
      [...$('#f-kind').children].forEach(b => b.setAttribute('aria-pressed', b === kindBtn));
      $('#f-placerow').hidden = formState.mapKind !== 'place';
      return;
    }
    const sug = e.target.closest('[data-sug]');
    if (sug) {
      const hit = Suggest.last[Number(sug.dataset.sug)];
      if (hit) {
        $('#f-place').value = hit.name;
        if (hit.address) $('#f-addr').value = hit.address;
        $('#f-lat').value = hit.lat.toFixed(6);
        $('#f-lng').value = hit.lng.toFixed(6);
        if (!$('#f-title').value.trim()) $('#f-title').value = hit.name;
      }
      $('#f-suggest').hidden = true;
      return;
    }
    const catBtn = e.target.closest('[data-cat]');
    if (catBtn) {
      formState.category = catBtn.dataset.cat;
      [...$('#f-cats').children].forEach(b => b.setAttribute('aria-pressed', b === catBtn));
      return;
    }
    const stBtn = e.target.closest('[data-stat]');
    if (stBtn) {
      formState.status = stBtn.dataset.stat;
      [...$('#f-stat').children].forEach(b => b.setAttribute('aria-pressed', b === stBtn));
      return;
    }
    const bk = e.target.closest('[data-booked]');
    if (bk) {
      formState.booked = bk.dataset.booked === 'yes';
      [...$('#f-booked').children].forEach(b =>
        b.setAttribute('aria-pressed', (b.dataset.booked === 'yes') === formState.booked));
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
  if (Data.hasMapCols && !f.mapKind) { showErr('Choose whether Maps opens a place or an exact spot.'); return; }
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
    geoResolved: prev ? prev.geoResolved : '',
    mapKind: f.mapKind, placeName: f.placeName, party: f.party || ''
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

  const placeChanged = !prev || prev.title !== ev.title || prev.address !== ev.address ||
    prev.placeName !== ev.placeName || prev.mapKind !== ev.mapKind;

  /* Editing the title or address of a cleared stop releases the block.
     "Cleared" means "this pin was wrong, forget it" — but typing a new
     address is an unambiguous request to place it again, and making the user
     dig through the ⋯ menu for that is a trap. Only skip this when the same
     save also blanked the coordinate fields, which is an explicit re-clear. */
  if (ev.geoStatus === 'cleared' && placeChanged && !clearedCoords) ev.geoStatus = 'idle';

  const needsLookup = ev.geoStatus !== 'manual' && ev.geoStatus !== 'cleared' &&
    (isNew || placeChanged || !Number.isFinite(ev.lat));
  if (needsLookup) {
    ev.lat = null; ev.lng = null;
    ev.geoStatus = canLookup(ev) ? 'pending' : 'none';
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
  if (needsLookup && canLookup(ev)) {
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

  const bcat = e.target.closest('[data-bcat]');
  if (bcat) {
    const id = bcat.dataset.bcat;
    if (budgetOpenCats.has(id)) budgetOpenCats.delete(id); else budgetOpenCats.add(id);
    refreshBudgetIfOpen();
    return;
  }

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
  if (e.target.closest('[data-savepw]')) { savePassword(); return; }
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
      /* Deliberately includes 'pending' and 'cleared'. This is an explicit
         "go find the missing pins" request, so a stop stranded mid-lookup is
         exactly what the user means, and a cleared one is theirs to undo. */
      const miss = S.events.filter(x => !hasLoc(x) && canLookup(x) && x.geoStatus !== 'manual');
      if (!miss.length) toast('Every stop with a name is already placed.');
      else { miss.forEach(x => Geo.enqueue(x.id)); toast('Looking up ' + miss.length + ' stop' + (miss.length === 1 ? '' : 's') + '…'); }
    }
    if (act.dataset.act === 'password') openPassword();
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
document.addEventListener('submit', e => {
  if (e.target.id === 'pwForm') { e.preventDefault(); savePassword(); }
});

/* ============================================================
   AUTH GATE
   Sign-in is an email and a trip password. A password signs in whichever
   browser it is typed into, with no email to wait for. That matters because
   Safari and the Home Screen app keep separate sign-ins: each asks once, then
   stays signed in. The password belongs to the account, so sharing the trip
   means handing over that account's email and its password.

   The emailed code stays as the way in before a password exists and after
   one is forgotten. It is typed, not followed as a link: a link signs in
   whichever browser happens to open it, which on a phone is the mail app's
   own and never the one that asked.
   ============================================================ */
// Every reason the gate is given is a problem, so it is shown as one.
function showGate(msg) {
  $('#gate').hidden = false;
  $('#app').hidden = true;
  if (msg) gateSay(msg, true);
}
function gateSay(msg, bad = false) {
  const el = $('#gateMsg');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
}
function showApp() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
}

/* Small things kept in this browser's storage so sign-in survives the page
   being reloaded or signed out. Storage can be unavailable; nothing here is
   required, so a failure only costs the convenience. */
function stash(store, key, value) {
  try {
    if (value == null || value === '') store.removeItem(key);
    else store.setItem(key, value);
  } catch (err) { /* no storage */ }
}
function unstash(store, key) {
  try { return store.getItem(key) || ''; } catch (err) { return ''; }
}

// The email last signed in here. A phone that gets signed out, as every other
// phone is when the password changes, then only has to supply the password.
const LOGIN_KEY = 'nyc-trip-login';

/* Reading the email means leaving this page, and iOS may reload it on the way
   back, the Home Screen app especially. Remembering that a code is on its way
   lets the reload land on the code step. Without it the page comes back at
   the start, and a second email voids the first code and spends one of the
   few sign-in emails Supabase sends per hour. */
const PENDING_KEY = 'nyc-trip-awaiting-code';
const PENDING_MS = 60 * 60 * 1000;   // Supabase's default code lifetime
function pendingEmail() {
  try {
    const p = JSON.parse(unstash(localStorage, PENDING_KEY));
    return p && Date.now() - p.at < PENDING_MS ? p.email : '';
  } catch (err) { return ''; }
}
function setPending(email) {
  stash(localStorage, PENDING_KEY, email ? JSON.stringify({ email, at: Date.now() }) : '');
}

// Set by a code sign-in, read once after the reload that follows it.
const OFFER_PASSWORD_KEY = 'nyc-trip-offer-password';

/* One trip password, no email. When config.js names a trip account, the
   gate asks only for the password and signs in to that account, so family
   can be given a single word. The email ships in the public config.

   Supabase refuses passwords under 6 characters, so a shorter one is padded
   with this fixed suffix before it is sent, both when signing in and when
   the password is set. It adds no secrecy: it is in this public file.
   Longer passwords go as typed. Sign-in still tries the padded form after
   the plain one, because the app briefly padded every password. */
const TRIP_LOGIN = String(CFG.tripLogin || '').trim();
const PW_PAD = '-nyc-trip';
const PW_MIN = 6;
const pw = typed => typed.length < PW_MIN ? typed + PW_PAD : typed;
const pwTries = typed => typed.length < PW_MIN ? [typed + PW_PAD] : [typed, typed + PW_PAD];

let gateEmail = '';
function gateStep(step) {
  $('#gateForm').hidden = step !== 'password';
  $('#gateCodeForm').hidden = step !== 'code';
}
function awaitCode(email, msg) {
  gateEmail = email;
  gateStep('code');
  gateSay(msg);
  $('#gateCode').focus();
}

async function signIn(email, password) {
  const btn = $('#gateSignIn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  // A thrown error is shown like a returned one. Left uncaught it would
  // strand the button on "Signing in…" with nothing said.
  let error;
  try {
    for (const tryPw of pwTries(password)) {
      ({ error } = await sb.auth.signInWithPassword({ email, password: tryPw }));
      if (!error || !/invalid login/i.test(error.message)) break;
    }
  } catch (err) { error = err; }
  if (error) {
    btn.disabled = false;
    btn.textContent = 'Sign in';
    gateSay(!/invalid login/i.test(error.message) ? error.message
      : TRIP_LOGIN ? 'That is not the trip password.'
      : 'That email and password do not match. If this email has no trip password yet, use an emailed code.', true);
    return;
  }
  location.reload();
}

async function sendCode() {
  const btn = $('#gateSend');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  let error;
  try {
    ({ error } = await sb.auth.signInWithOtp({
      email: gateEmail,
      options: { emailRedirectTo: window.location.href.split('#')[0] }
    }));
  } catch (err) { error = err; }
  btn.disabled = false;
  btn.textContent = 'Email me a code';
  if (error) {
    gateSay(/rate limit/i.test(error.message)
      ? 'Supabase only sends a few sign-in emails an hour, and that limit is used up. Wait an hour, or type the code from the newest email you already have.'
      : error.message, true);
    return;
  }
  setPending(gateEmail);
  gateSay('Check ' + gateEmail + ' for the code.');
  $('#gateCode').focus();
}

async function verifyCode(entered) {
  /* The field also takes the email's sign-in link, pasted in. The link
     carries its one-time token in the query string; redeeming it here signs
     in this browser instead of whichever one would have opened the link.
     Decoded first, because a mail app may hand the link over wrapped inside
     a redirect of its own.

     The page does not advertise this, because on an iPhone it rarely works:
     pressing and holding a link to copy it loads a preview of it, and that
     preview spends the link before it can be pasted. */
  let pasted = entered;
  try { pasted = decodeURIComponent(entered); } catch (err) { /* not encoded */ }
  const link = pasted.match(/[?&]token=([\w-]+)/);
  const code = entered.replace(/\D/g, '');
  if (!link && !code) { gateSay('Type the code from the email.', true); return; }

  const btn = $('#gateVerify');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  let error;
  try {
    ({ error } = await sb.auth.verifyOtp(link
      ? { token_hash: link[1], type: 'email' }
      : { email: gateEmail, token: code, type: 'email' }));
  } catch (err) { error = err; }
  if (error) {
    btn.disabled = false;
    btn.textContent = 'Sign in';
    gateSay(!/expired|invalid/i.test(error.message) ? error.message
      : link ? 'That link was already used or has expired. On an iPhone, pressing and holding a link to copy it uses it up. Type the code instead.'
      : 'That code did not work. It is wrong, already used or expired. Check the newest email, or send another.', true);
    return;
  }
  // Whoever needed a code has no working password. Offer one once they are in.
  stash(sessionStorage, OFFER_PASSWORD_KEY, '1');
  location.reload();
}

/* Wired in both the signed-out path and the unreachable-database path, so the
   sign-in form always works once the backend comes back. */
let gateWired = false;
function wireGate() {
  if (gateWired) return;
  gateWired = true;
  if (TRIP_LOGIN) {
    $('#gateEmailRow').hidden = true;
    $('#gateEmail').required = false;
    $('#gatePassHint').textContent = 'One password for the whole trip.';
  } else {
    $('#gateEmail').value = unstash(localStorage, LOGIN_KEY);
  }
  $('#gateForm').addEventListener('submit', ev => {
    ev.preventDefault();
    signIn(TRIP_LOGIN || $('#gateEmail').value.trim(), $('#gatePass').value);
  });
  // Nothing is sent on the way in: a code may already be waiting in the
  // inbox, and the hourly limit makes every unneeded email expensive.
  $('#gateUseCode').addEventListener('click', () => {
    if (!TRIP_LOGIN && !$('#gateEmail').reportValidity()) return;
    awaitCode(TRIP_LOGIN || $('#gateEmail').value.trim(), 'Tap “Email me a code”, or type one you already have.');
  });
  $('#gateSend').addEventListener('click', sendCode);
  $('#gateCodeForm').addEventListener('submit', ev => {
    ev.preventDefault();
    verifyCode($('#gateCode').value);
  });
  $('#gateRestart').addEventListener('click', () => {
    setPending('');
    gateStep('password');
    gateSay('');
  });
}

/* ---------- trip password ---------- */
function openPassword() {
  const email = S.session.user.email;
  sheetMode = 'password';
  // The email field is there for the phone's password manager, which files
  // the new password under whatever username it can see in the form.
  openSheet('Trip password', `
    <p class="sheet-lead">${TRIP_LOGIN
      ? 'This is the one password for the trip. Anyone who has it can open and edit the plan.'
      : 'With a password, this email signs in on any phone straight away, with no email to wait for. To share the trip, give someone this email and the password.'}</p>
    <form id="pwForm">
      <div class="f"><label for="pw-email">SIGN-IN EMAIL</label>
        <input id="pw-email" type="email" autocomplete="username" value="${esc(email)}" readonly></div>
      <div class="f"><label for="pw-new">NEW PASSWORD</label>
        <input id="pw-new" type="password" autocomplete="new-password" required>
        <div class="hint">At least 4 characters, and not one you use anywhere else.</div></div>
    </form>
    <div class="bnote">Saving signs this email out on every other phone. Each signs back in with the new password.</div>
    <div class="err" id="pw-err" hidden></div>`,
    `<button class="btn ghost" data-cancel="1">Cancel</button>
     <button class="btn primary" data-savepw="1">Save password</button>`);
}

async function savePassword() {
  const say = m => { const el = $('#pw-err'); el.textContent = m; el.hidden = false; };
  const password = $('#pw-new').value;
  if (password.length < 4) { say('Use at least 4 characters.'); $('#pw-new').focus(); return; }

  const btn = $('[data-savepw]');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  let error;
  try {
    ({ error } = await sb.auth.updateUser({ password: pw(password) }));
  } catch (err) { error = err; }
  if (error) {
    btn.disabled = false;
    btn.textContent = 'Save password';
    say(error.message);
    return;
  }
  closeSheet();
  toast('Trip password saved.');
}

async function boot() {
  /* #gate and #app both start hidden, and only this function un-hides either.
     getSession() throws outright when Supabase cannot be reached — a paused
     free project loses its DNS record entirely — which killed boot here and
     left a blank page with no sign-in box and no explanation. Fall back to
     the gate carrying the real reason. */
  let session = null;
  try {
    ({ data: { session } } = await sb.auth.getSession());
  } catch (err) {
    console.error('[boot] cannot reach Supabase', err);
    showGate('Cannot reach the trip database right now. If it was paused it takes a few minutes to wake up — wait, then reload.');
    wireGate();
    return;
  }
  S.session = session;

  if (!session) {
    wireGate();
    if (LINK_FAILED) {
      // Whatever code was being waited for is in doubt too. Start clean.
      setPending('');
      showGate('That sign-in link has expired or was already used. Sign in with the trip password, or use an emailed code and type it in rather than tapping its link.');
    } else {
      showGate('');
      const waiting = pendingEmail();
      if (waiting) awaitCode(waiting, 'Type the code sent to ' + waiting + '.');
    }
    return;
  }
  setPending('');
  stash(localStorage, LOGIN_KEY, session.user.email);

  showApp();
  Map_.init();
  watchLayout();
  await Data.load();

  // Signed in but not on the allow-list: RLS returns nothing.
  let count = null;
  try {
    ({ count } = await sb.from('trip_members').select('email', { count: 'exact', head: true }));
  } catch (err) {
    console.error('[boot] allow-list check failed', err);
    showGate('Signed in, but the trip database is not responding. Wait a moment and reload.');
    wireGate();
    return;
  }
  if (!count) {
    showGate('That address is signed in but is not on the trip. Add it to trip_members in Supabase.');
    wireGate();
    return;
  }

  Data.subscribe();
  render();
  Weather.load();

  /* Queue lookups BEFORE touching the map. This used to run after Map_.fit(),
     so anything that threw while fitting bounds took the geocoder down with
     it and no stop was ever looked up — with no error surfaced anywhere. */
  // Anything without a pin gets queued for lookup, one at a time.
  S.events
    /* 'pending' IS included. The queue only lives in memory, so a stop still
       marked pending at page load is one whose lookup never finished — the
       tab closed, the network dropped, the page navigated. Excluding it meant
       that stop was never retried again by anything, leaving it permanently
       unmapped and stuck on "Asking a cabbie…".

       Only unfinished lookups are resumed. 'failed' is not retried here: an
       address the lookup cannot find was otherwise looked up again on every
       page load, for ever. A failed stop is retried when it is edited, or by
       "Re-locate missing pins". 'manual' and 'cleared' mean the user decided
       where this stop is, or that it has no location. */
    .filter(e => !hasLoc(e) && canLookup(e) &&
      (e.geoStatus === 'pending' || e.geoStatus === 'idle'))
    .forEach(e => Geo.enqueue(e.id));

  try { Map_.fit(); } catch (err) { console.warn('[boot] map fit failed', err); }

  if (unstash(sessionStorage, OFFER_PASSWORD_KEY)) {
    stash(sessionStorage, OFFER_PASSWORD_KEY, '');
    openPassword();
  }
}

/* Console helper: reports what the app actually believes about each stop's
   location, which is the only way to tell "the lookup failed" apart from
   "the lookup was never attempted". Run geoDebug() in the browser console. */
window.geoDebug = () => {
  const rows = S.events.map(e => ({
    title: (e.title || '').slice(0, 28),
    address: (e.address || '').slice(0, 28),
    geo: e.geoStatus,
    pinned: hasLoc(e) ? `${e.lat.toFixed(4)},${e.lng.toFixed(4)}` : '—'
  }));
  console.table(rows);
  const stuck = rows.filter(r => r.pinned === '—');
  console.log(`${rows.length} stops, ${stuck.length} without a pin`);
  console.log('queue:', Geo.queue.length, 'running:', Geo.running);
  return rows;
};

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

/* ---------- picking up a new deploy ----------
   GitHub Pages lets a phone reuse the page for 10 minutes, and closing the
   Home Screen app does not clear that, so a deploy could take that long to
   appear. Each deploy writes version.json; this build knows its own version
   from the ?v= on its own URL. When the app opens or comes back to the front
   (at most once every 5 minutes) it asks for version.json past the cache, and
   if a newer deploy is out it reloads at a new address, which the phone has
   not cached. It never reloads mid-edit, and tries each version once, so a
   stale page cannot loop. A local copy (no ?v=) never checks. */
const BUILD = new URL(import.meta.url).searchParams.get('v');
const UPDATE_TRIED = 'nyc-trip-update-tried';
let lastUpdateCheck = 0;
async function checkForUpdate() {
  if (!BUILD || Date.now() - lastUpdateCheck < 5 * 60 * 1000) return;
  lastUpdateCheck = Date.now();
  let latest;
  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    latest = (await res.json()).v;
  } catch (err) { return; }   // offline, or no version file yet: carry on
  if (!latest || latest === BUILD) return;
  if (sheetMode === 'form') { lastUpdateCheck = 0; return; }   // not mid-edit
  if (unstash(sessionStorage, UPDATE_TRIED) === latest) return;
  stash(sessionStorage, UPDATE_TRIED, latest);
  location.replace(location.pathname + '?v=' + latest);
}
checkForUpdate();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });

/* exposed for the console and for Claude Code's tests */
window.S = S;
window.Data = Data;
window.Geo = Geo;
window.openDetail = openDetail;
window.openForm = openForm;
