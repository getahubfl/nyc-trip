const { chromium } = require('playwright');
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? ' :: ' + x : '')); } };

// A fake @supabase/supabase-js: in-memory table, fake auth, fake realtime channel.
const SB_STUB = `
const rows = [];
let listeners = [];
const uid = () => 'id' + Math.random().toString(36).slice(2, 10);
function table(name){
  const api = {
    _filters: [],
    select(){ const p = Promise.resolve({ data: rows.slice(), error: null, count: rows.length });
              p.single = () => Promise.resolve({ data: rows[rows.length-1], error: null });
              p.eq = () => p; return p; },
    insert(row){
      const made = Array.isArray(row) ? row.map(r => ({...r, id: uid()})) : [{...row, id: uid()}];
      made.forEach(m => rows.push(m));
      const res = { data: made[0], error: null };
      return { select: () => ({ single: () => Promise.resolve(res) }) };
    },
    update(patch){ return { eq: (_, id) => {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch, id };
      return Promise.resolve({ error: null });
    } }; },
    delete(){ return { eq: (_, id) => {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve({ error: null });
    } }; }
  };
  if (name === 'trip_members') {
    api.select = () => Promise.resolve({ data: [{email:'you@example.com'}], error: null, count: 1 });
  }
  return api;
}
export function createClient(){
  window.__rows = rows;
  return {
    from: table,
    channel(){ return { on(){ return this; }, subscribe(cb){ cb && cb('SUBSCRIBED'); return this; } }; },
    auth: {
      getSession: async () => ({ data: { session: window.__signedIn === false ? null : { user: { email: 'you@example.com' } } } }),
      signInWithOtp: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; }
    }
  };
}
`;

// A fake maplibre-gl global.
const ML_STUB = `
window.maplibregl = {
  Map: class {
    constructor(o){ this._h = {}; this._src = {}; this._z = 12;
      setTimeout(() => (this._h.load || []).forEach(f => f()), 10); }
    on(e, f){ (this._h[e] = this._h[e] || []).push(f); }
    addControl(){} addSource(id, s){ this._src[id] = { setData(d){ this.data = d; } }; }
    addLayer(){} getSource(id){ return this._src[id]; }
    getZoom(){ return this._z; } easeTo(){} fitBounds(){}
  },
  Marker: class {
    constructor(o){ this.el = o && o.element; }
    setLngLat(){ return this; }
    addTo(){ if (this.el) { this.el.classList.add('marker-live'); document.body.appendChild(this.el); } window.__markers = (window.__markers||0)+1; return this; }
    remove(){ if (this.el && this.el.parentNode) this.el.remove(); }
  },
  NavigationControl: class {}, ScaleControl: class {}, AttributionControl: class {},
  LngLatBounds: class { extend(){ return this; } }
};
`;

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/fonts\.|favicon|net::ERR/.test(t)) errs.push('console: ' + t); });

  // serve local files + stubs, block everything else
  await ctx.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: SB_STUB });
    if (url.includes('maplibre-gl') && url.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: ML_STUB });
    if (url.includes('maplibre-gl') && url.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.startsWith('https://fonts.')) return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.startsWith('http://local/')) {
      const f = url.replace('http://local/', '') || 'index.html';
      const path = ROOT + '/' + f.split('?')[0];
      if (!fs.existsSync(path)) return route.fulfill({ status: 404, body: '' });
      const type = f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : 'text/html';
      return route.fulfill({ contentType: type, body: fs.readFileSync(path, 'utf8') });
    }
    if (url.includes('nominatim')) return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify([{ lat: '40.7223', lon: '-73.9874', display_name: 'stubbed match, New York' }]) });
    return route.abort();
  });

  fs.writeFileSync(ROOT + '/config.js', `window.TRIP_CONFIG={supabaseUrl:'http://stub',supabaseAnonKey:'stub'};`);

  console.log('\n— SIGNED OUT —');
  await p.addInitScript(() => { window.__signedIn = false; });
  await p.goto('http://local/index.html');
  await p.waitForTimeout(600);
  ok('gate shown when signed out', await p.locator('#gate:not([hidden])').count() === 1);
  ok('app hidden when signed out', await p.locator('#app[hidden]').count() === 1);
  await p.fill('#gateEmail', 'you@example.com');
  await p.locator('#gateSend').click();
  await p.waitForTimeout(300);
  ok('magic-link confirmation shown', (await p.locator('#gateMsg').innerText()).includes('Check you@example.com'));
  ok('no errors on the gate', errs.length === 0, errs.join(' | '));

  console.log('\n— SIGNED IN, EMPTY TRIP —');
  const q = await ctx.newPage();
  const e2 = [];
  q.on('pageerror', e => e2.push(String(e)));
  q.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/fonts\.|favicon|net::ERR/.test(t)) e2.push('console: ' + t); });
  await q.goto('http://local/index.html');
  await q.waitForTimeout(800);
  ok('app shown when signed in', await q.locator('#app:not([hidden])').count() === 1);
  ok('six day tabs', await q.locator('#rail .day').count() === 6);
  ok('eight category chips', await q.locator('#chips .chip').count() === 8);
  ok('empty day renders a prompt', (await q.locator('#list').innerText()).includes('wide open'));
  ok('sync badge is live', await q.locator('#sync.on').count() === 1);

  console.log('\n— ADD A STOP —');
  await q.locator('#fab').click();
  await q.waitForTimeout(400);
  ok('form opens', (await q.locator('#sheetTitle').innerText()) === 'New stop');
  ok('reservation subform hidden by default', await q.locator('#f-ressub[hidden]').count() === 1);
  await q.locator('[data-save]').click();
  await q.waitForTimeout(250);
  ok('blank title rejected', await q.locator('#f-err:not([hidden])').count() === 1);

  await q.fill('#f-title', "Katz's Delicatessen");
  await q.fill('#f-addr', '205 E Houston St');
  await q.locator('#f-cats [data-cat="lunch"]').click();
  await q.fill('#f-time', '12:30');
  await q.fill('#f-people', '4');
  await q.fill('#f-cpp', '32');
  await q.locator('#f-res').check();
  await q.waitForTimeout(150);
  ok('reservation subform expands', await q.locator('#f-ressub[hidden]').count() === 0);
  await q.locator('#f-booked [data-booked="yes"]').click();
  await q.fill('#f-conf', 'KZ-8841');
  await q.locator('#f-addextra').click();
  await q.waitForTimeout(150);
  await q.locator('#f-extras [data-ex=label]').last().fill('Egg creams');
  await q.locator('#f-extras [data-ex=amount]').last().fill('18');
  await q.waitForTimeout(250);
  ok('total = per-person x people + extras', (await q.locator('#f-total').innerText()).includes('$146'),
     await q.locator('#f-total').innerText());

  await q.locator('[data-save]').click();
  await q.waitForTimeout(600);
  ok('stop saved to the database', await q.evaluate(() => window.__rows.length) === 1);
  const row = await q.evaluate(() => window.__rows[0]);
  ok('saved as snake_case columns', 'cost_per_person' in row && 'needs_reservation' in row, JSON.stringify(Object.keys(row)).slice(0,120));
  ok('reservation captured', row.needs_reservation === true && row.booked === true && row.confirmation === 'KZ-8841');
  ok('extras captured', Array.isArray(row.extras) && row.extras[0].amount === 18);
  ok('queued for geocoding', row.geo_status === 'pending' || row.geo_status === 'ok', row.geo_status);
  ok('stop appears in the list', await q.locator('.stop').count() === 1);
  ok('day jumped to the stop\'s day', (await q.locator('.daytitle').innerText()).includes('NOVEMBER 25'));

  console.log('\n— GEOCODING —');
  await q.waitForTimeout(2600);
  const geo = await q.evaluate(() => window.S.events[0]);
  ok('coordinates resolved from Nominatim', Math.abs(geo.lat - 40.7223) < 1e-6, JSON.stringify([geo.lat, geo.lng, geo.geoStatus]));
  ok('marker drawn on the map', await q.evaluate(() => window.__markers > 0));

  console.log('\n— DETAIL SHEET —');
  await q.locator('.stop').first().click();
  await q.waitForTimeout(400);
  ok('sheet opens', await q.locator('#sheet.open').count() === 1);
  ok('cost grid shown for a priced stop', await q.locator('.costgrid b').count() === 2);
  const cg = await q.locator('.costgrid b').allTextContents();
  ok('per-person and total correct', cg[0] === '$32' && cg[1] === '$146', JSON.stringify(cg));
  ok('reservation bar reads Booked', (await q.locator('.resbar h4').innerText()).includes('Booked'));
  ok('directions link offered', await q.locator('.d-row a[href*="google.com/maps"]').count() === 1);

  console.log('\n— TOGGLE BOOKED —');
  await q.locator('[data-toggleres]').click();
  await q.waitForTimeout(500);
  ok('flips to not booked', (await q.locator('.resbar h4').innerText()).includes('Not booked'));
  ok('persisted to the database', await q.evaluate(() => window.__rows[0].booked) === false);
  ok('to-book counter appears', parseInt(await q.locator('#tobookN').innerText(), 10) === 1);

  console.log('\n— TO BOOK VIEW —');
  await q.locator('#closeSheet').click();
  await q.waitForTimeout(350);
  await q.locator('#tobook').click();
  await q.waitForTimeout(300);
  ok('to-book header shown', (await q.locator('.daytitle').innerText()).includes('STILL TO BOOK'));
  ok('lists the outstanding stop', await q.locator('.stop').count() === 1);
  await q.locator('#tobook').click();
  await q.waitForTimeout(250);

  console.log('\n— MANUAL COORDINATES —');
  const id = await q.evaluate(() => window.S.events[0].id);
  await q.evaluate(i => window.openForm(i), id);
  await q.waitForTimeout(400);
  ok('lat/lng prefilled', (await q.inputValue('#f-lat')).length > 0);
  await q.fill('#f-lat', '40.71000');
  await q.fill('#f-lng', '-74.00000');
  await q.locator('[data-save]').click();
  await q.waitForTimeout(600);
  const man = await q.evaluate(() => window.S.events[0]);
  ok('hand-typed coordinates stored exactly', Math.abs(man.lat - 40.71) < 1e-9 && Math.abs(man.lng + 74) < 1e-9);
  ok('marked manual so the lookup leaves it alone', man.geoStatus === 'manual', man.geoStatus);

  console.log('\n— CATEGORY FILTER —');
  await q.locator('#chips .chip[data-cat="lunch"]').click();
  await q.waitForTimeout(250);
  ok('deselecting the category hides the stop', await q.locator('.stop').count() === 0);
  await q.locator('#chips .chip[data-cat="lunch"]').click();
  await q.waitForTimeout(250);
  ok('reselecting brings it back', await q.locator('.stop').count() === 1);

  console.log('\n— DELETE —');
  q.on('dialog', d => d.accept());
  await q.evaluate(i => window.openDetail(i), id);
  await q.waitForTimeout(350);
  await q.locator('[data-del]').click();
  await q.waitForTimeout(600);
  ok('removed from the database', await q.evaluate(() => window.__rows.length) === 0);
  ok('removed from the list', await q.locator('.stop').count() === 0);

  console.log('\n— DESKTOP LAYOUT —');
  await q.setViewportSize({ width: 1280, height: 900 });
  await q.waitForTimeout(400);
  ok('two-column layout', await q.evaluate(() => getComputedStyle(document.querySelector('.body-grid')).display) === 'grid');

  ok('no runtime errors across the whole run', e2.length === 0, e2.slice(0, 3).join(' | '));

  console.log('\n========================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  console.log('========================');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
