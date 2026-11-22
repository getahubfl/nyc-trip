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
  window.__urlAtClientStart = location.href;
  return {
    from: table,
    channel(){ return { on(){ return this; }, subscribe(cb){ cb && cb('SUBSCRIBED'); return this; } }; },
    auth: {
      // sessionStorage stands in for the saved session: per tab, and it
      // survives the reload that follows a successful sign-in.
      getSession: async () => ({ data: { session: (window.__signedIn === false && !sessionStorage.getItem('stubSession'))
        ? null : { user: { email: 'you@example.com' } } } }),
      signInWithOtp: async ({ email }) => email === 'limit@example.com'
        ? { error: { message: 'email rate limit exceeded' } }
        : { error: null },
      // Accepts the code 123456 or the link token abc123, as /verify would.
      verifyOtp: async (a) => {
        if (a.token !== '123456' && a.token_hash !== 'abc123') return { error: { message: 'Token has expired or is invalid' } };
        sessionStorage.setItem('stubSession', JSON.stringify(a));
        return { data: {}, error: null };
      },
      // The trip password is "paris". The app pads what is typed before
      // sending it, because Supabase refuses passwords under 6 characters.
      signInWithPassword: async ({ email, password }) => {
        // "paris123" is stored as typed; shorter "paris" is stored padded.
        if (password !== 'paris-nyc-trip' && password !== 'paris123') return { error: { message: 'Invalid login credentials' } };
        sessionStorage.setItem('stubSession', JSON.stringify({ email, via: 'password' }));
        return { data: {}, error: null };
      },
      updateUser: async (a) => { sessionStorage.setItem('stubUpdate', JSON.stringify(a)); return { data: {}, error: null }; },
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
    constructor(o){ this._h = {}; this._src = {}; this._z = 12; window.__map = this;
      setTimeout(() => (this._h.load || []).forEach(f => f()), 10); }
    on(e, f){ (this._h[e] = this._h[e] || []).push(f); }
    addControl(){} addSource(id, s){ this._src[id] = { setData(d){ this.data = d; } }; }
    addLayer(){} getSource(id){ return this._src[id]; }
    getZoom(){ return this._z; } easeTo(){} fitBounds(){} resize(){}
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
      const p0 = f.split('?')[0];
      const type = p0.endsWith('.css') ? 'text/css' : p0.endsWith('.js') ? 'text/javascript' : p0.endsWith('.json') ? 'application/json' : 'text/html';
      return route.fulfill({ contentType: type, body: fs.readFileSync(path, 'utf8') });
    }
    if (url.includes('routing.openstreetmap.de/routed-foot')) return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ routes: [{ distance: 2080, duration: 1680, geometry: { coordinates: [[-73.983, 40.7645], [-73.9855, 40.7700], [-73.9810, 40.7760], [-73.9797, 40.7813]] } }] }) });
    if (url.includes('routing.openstreetmap.de/routed-car')) return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ routes: [{ distance: 2400, duration: 240, geometry: { coordinates: [[-73.983, 40.7645], [-73.9870, 40.7720], [-73.9797, 40.7813]] } }] }) });
    if (url.includes('api.transitous.org')) return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ itineraries: [
        { duration: 1140, legs: [{ mode: 'WALK' }, { mode: 'BUS', routeShortName: 'M7' }, { mode: 'WALK' }] },
        { duration: 960, legs: [{ mode: 'WALK', legGeometry: { points: '_p~iF~ps|U_ulL', precision: 5 } }, { mode: 'SUBWAY', routeShortName: 'D', legGeometry: { points: '_p~iF~ps|U_ulLnnqC', precision: 5 } }, { mode: 'SUBWAY', routeShortName: '1' }, { mode: 'WALK', legGeometry: { points: '_p~iF~ps|U_ulL', precision: 5 } }] }] }) });
    if (url.includes('photon.komoot.io')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [
        { properties: { name: 'Quality Italian', housenumber: '57', street: 'West 57th Street' }, geometry: { coordinates: [-73.97677, 40.76457] } }] }) }); }
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
  ok('asks for email and password', await p.locator('#gateForm:not([hidden]) #gatePass').count() === 1 && await p.locator('#gateCodeForm[hidden]').count() === 1);

  console.log('\n— SIGN IN BY PASSWORD —');
  await p.fill('#gateEmail', 'you@example.com');
  await p.fill('#gatePass', 'not-the-password');
  await p.locator('#gateSignIn').click();
  await p.waitForTimeout(300);
  // A refusal has to be impossible to miss: marked, and beside the fields
  // rather than at the foot of the card, where the keyboard covers it.
  const seen = await p.evaluate(() => {
    const m = document.querySelector('#gateMsg'), f = document.querySelector('#gateEmail');
    return { text: m.textContent, bad: m.classList.contains('bad'), colour: getComputedStyle(m).color,
             above: m.getBoundingClientRect().bottom <= f.getBoundingClientRect().top };
  });
  ok('wrong password refused with a reason', seen.text.includes('do not match') && await p.locator('#gate:not([hidden])').count() === 1, seen.text);
  ok('the refusal is marked and sits above the fields', seen.bad && seen.above && seen.colour === 'rgb(196, 40, 28)', JSON.stringify(seen));

  await p.fill('#gatePass', 'paris');
  await p.locator('#gateSignIn').click();
  await p.waitForTimeout(900);
  ok('right password signs this browser in', await p.locator('#app:not([hidden])').count() === 1);
  const viaPass = await p.evaluate(() => JSON.parse(sessionStorage.getItem('stubSession')));
  ok('signed in with the email typed', viaPass.email === 'you@example.com' && viaPass.via === 'password', JSON.stringify(viaPass));
  ok('no password prompt after a password sign-in', await p.locator('#sheet.open').count() === 0);
  ok('no errors on the gate', errs.length === 0, errs.join(' | '));

  // Signed out again later, the phone only has to supply the password.
  const back = await ctx.newPage();
  await back.addInitScript(() => { window.__signedIn = false; });
  await back.goto('http://local/index.html');
  await back.waitForTimeout(600);
  ok('email remembered for next time', await back.inputValue('#gateEmail') === 'you@example.com');
  await back.close();

  console.log('\n— SIGN IN BY EMAILED CODE —');
  const c = await ctx.newPage();
  await c.addInitScript(() => { window.__signedIn = false; });
  await c.goto('http://local/index.html');
  await c.waitForTimeout(600);
  await c.fill('#gateEmail', 'limit@example.com');
  await c.locator('#gateUseCode').click();
  await c.waitForTimeout(200);
  ok('code step opens without the password', await c.locator('#gateCodeForm:not([hidden])').count() === 1 && await c.locator('#gateForm[hidden]').count() === 1);
  await c.locator('#gateSend').click();
  await c.waitForTimeout(300);
  ok('rate limit explained in plain words', (await c.locator('#gateMsg').innerText()).includes('few sign-in emails an hour'));
  ok('a failure is marked as one', await c.locator('#gateMsg.bad').count() === 1);
  await c.reload();
  await c.waitForTimeout(600);
  ok('nothing is awaited when nothing was sent', await c.locator('#gateForm:not([hidden])').count() === 1);

  await c.fill('#gateEmail', 'you@example.com');
  await c.locator('#gateUseCode').click();
  await c.locator('#gateSend').click();
  await c.waitForTimeout(300);
  ok('code confirmation shown', (await c.locator('#gateMsg').innerText()).includes('Check you@example.com'));
  ok('a confirmation is not marked as a failure', await c.locator('#gateMsg.bad').count() === 0);

  // Leaving for the mail app can cost the page its state. It must come back
  // asking for the code, not start again.
  await c.reload();
  await c.waitForTimeout(600);
  ok('a reload comes back to the code step', await c.locator('#gateCodeForm:not([hidden])').count() === 1);

  await c.fill('#gateCode', '000000');
  await c.locator('#gateVerify').click();
  await c.waitForTimeout(300);
  ok('wrong code refused with a reason', (await c.locator('#gateMsg.bad').innerText()).includes('did not work') && await c.locator('#gate:not([hidden])').count() === 1);

  await c.fill('#gateCode', 'https://x.supabase.co/auth/v1/verify?token=spent&type=magiclink');
  await c.locator('#gateVerify').click();
  await c.waitForTimeout(300);
  ok('a spent link says why', (await c.locator('#gateMsg').innerText()).includes('already used or has expired'));

  await c.fill('#gateCode', '123456');
  await c.locator('#gateVerify').click();
  await c.waitForTimeout(1100);
  ok('right code signs this browser in', await c.locator('#app:not([hidden])').count() === 1);
  const viaCode = await c.evaluate(() => JSON.parse(sessionStorage.getItem('stubSession')));
  ok('code checked against the email it was sent to', viaCode.email === 'you@example.com' && viaCode.token === '123456' && viaCode.type === 'email', JSON.stringify(viaCode));

  console.log('\n— TRIP PASSWORD —');
  ok('a code sign-in offers to set a password', await c.locator('#sheet.open').count() === 1 && (await c.locator('#sheetTitle').innerText()) === 'Trip password');
  ok('sheet names the email the password belongs to', await c.inputValue('#pw-email') === 'you@example.com');
  await c.fill('#pw-new', 'abc');
  await c.locator('[data-savepw]').click();
  await c.waitForTimeout(200);
  ok('short password rejected', await c.locator('#pw-err:not([hidden])').count() === 1 && await c.evaluate(() => sessionStorage.getItem('stubUpdate')) === null);
  await c.fill('#pw-new', 'paris');
  await c.locator('[data-savepw]').click();
  await c.waitForTimeout(500);
  ok('password saved to the account', (await c.evaluate(() => JSON.parse(sessionStorage.getItem('stubUpdate')))).password === 'paris-nyc-trip');
  ok('sheet closes once saved', await c.locator('#sheet.open').count() === 0);
  await c.reload();
  await c.waitForTimeout(800);
  ok('the offer is made once', await c.locator('#sheet.open').count() === 0);
  await c.locator('#menuBtn').click();
  await c.locator('#menuPop [data-act="password"]').click();
  await c.waitForTimeout(400);
  ok('password can be changed from the menu', (await c.locator('#sheetTitle').innerText()) === 'Trip password');
  await c.close();

  console.log('\n— ONE TRIP PASSWORD —');
  const CONF = `window.TRIP_CONFIG={supabaseUrl:'http://stub',supabaseAnonKey:'stub'`;
  fs.writeFileSync(ROOT + '/config.js', CONF + `,tripLogin:'trip@example.com'};`);
  const t = await ctx.newPage();
  await t.addInitScript(() => { window.__signedIn = false; });
  await t.goto('http://local/index.html');
  await t.waitForTimeout(600);
  ok('only the password is asked for', await t.locator('#gateEmailRow[hidden]').count() === 1 && await t.locator('#gatePass').isVisible());
  await t.fill('#gatePass', 'rome');
  await t.locator('#gateSignIn').click();
  await t.waitForTimeout(300);
  ok('wrong trip password refused', (await t.locator('#gateMsg.bad').innerText()).includes('not the trip password'));
  await t.fill('#gatePass', 'paris');
  await t.locator('#gateSignIn').click();
  await t.waitForTimeout(900);
  ok('trip password signs in', await t.locator('#app:not([hidden])').count() === 1);
  ok('signed in to the trip account', (await t.evaluate(() => JSON.parse(sessionStorage.getItem('stubSession')))).email === 'trip@example.com');
  await t.close();
  const t8 = await ctx.newPage();
  await t8.addInitScript(() => { window.__signedIn = false; });
  await t8.goto('http://local/index.html');
  await t8.waitForTimeout(600);
  await t8.fill('#gatePass', 'paris123');
  await t8.locator('#gateSignIn').click();
  await t8.waitForTimeout(900);
  ok('a longer password is sent as typed', await t8.locator('#app:not([hidden])').count() === 1);
  await t8.close();
  fs.writeFileSync(ROOT + '/config.js', CONF + '};');

  console.log('\n— SIGN IN BY PASTED LINK —');
  const r = await ctx.newPage();
  await r.addInitScript(() => { window.__signedIn = false; });
  await r.goto('http://local/index.html');
  await r.waitForTimeout(600);
  ok('signing in clears the awaited code', await r.locator('#gateForm:not([hidden])').count() === 1);
  await r.locator('#gateUseCode').click();
  await r.fill('#gateCode', 'https://x.supabase.co/auth/v1/verify?token=abc123&type=magiclink&redirect_to=http://local/');
  await r.locator('#gateVerify').click();
  await r.waitForTimeout(900);
  ok('pasted link signs this browser in', await r.locator('#app:not([hidden])').count() === 1);
  const viaLink = await r.evaluate(() => JSON.parse(sessionStorage.getItem('stubSession')));
  ok('link redeemed by its token', viaLink.token_hash === 'abc123' && viaLink.type === 'email', JSON.stringify(viaLink));
  await r.close();

  // A mail app may copy the link wrapped inside its own redirect.
  const w = await ctx.newPage();
  await w.addInitScript(() => { window.__signedIn = false; });
  await w.goto('http://local/index.html');
  await w.waitForTimeout(600);
  await w.locator('#gateUseCode').click();
  await w.fill('#gateCode', 'https://www.google.com/url?q=' + encodeURIComponent('https://x.supabase.co/auth/v1/verify?token=abc123&type=magiclink'));
  await w.locator('#gateVerify').click();
  await w.waitForTimeout(900);
  ok('wrapped link still signs in', await w.locator('#app:not([hidden])').count() === 1);
  await w.close();

  console.log('\n— EXPIRED LINK —');
  const x = await ctx.newPage();
  await x.addInitScript(() => { window.__signedIn = false; });
  await x.goto('http://local/index.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await x.waitForTimeout(600);
  ok('expired link explained on the gate', (await x.locator('#gateMsg').innerText()).includes('expired or was already used'));
  // supabase-js deletes the saved session if it sees these parameters.
  ok('error stripped before the Supabase client starts', !(await x.evaluate(() => window.__urlAtClientStart)).includes('error'));
  await x.close();

  console.log('\n— SIGNED IN, EMPTY TRIP —');
  const q = await ctx.newPage();
  const e2 = [];
  q.on('pageerror', e => e2.push(String(e)));
  q.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/fonts\.|favicon|net::ERR/.test(t)) e2.push('console: ' + t); });
  await q.goto('http://local/index.html');
  await q.waitForTimeout(800);
  ok('app shown when signed in', await q.locator('#app:not([hidden])').count() === 1);
  ok('four day tabs, ending Saturday', await q.locator('#rail .day:not(.day-all)').count() === 4);
  ok('eleven category chips, with Shopping and Matcha', await q.locator('#chips .chip').count() === 11 &&
     await q.locator('#chips [data-cat="shopping"]').count() === 1 && await q.locator('#chips [data-cat="matcha"]').count() === 1);
  ok('empty day renders a prompt', (await q.locator('#list').innerText()).includes('wide open'));
  ok('sync badge is live', await q.locator('#sync.on').count() === 1);

  console.log('\n— HOME SCREEN APP —');
  const manifest = JSON.parse(fs.readFileSync(ROOT + '/' + await q.locator('link[rel="manifest"]').getAttribute('href'), 'utf8'));
  ok('manifest opens full screen', manifest.display === 'standalone');
  ok('manifest icons exist', manifest.icons.length > 0 && manifest.icons.every(i => fs.existsSync(ROOT + '/' + i.src)));
  ok('iOS icon exists', fs.existsSync(ROOT + '/' + await q.locator('link[rel="apple-touch-icon"]').getAttribute('href')));

  console.log('\n— ADD A STOP —');
  await q.locator('#fab').click();
  await q.waitForTimeout(400);
  ok('form opens', (await q.locator('#sheetTitle').innerText()) === 'New stop');
  ok('reservation subform hidden by default', await q.locator('#f-ressub[hidden]').count() === 1);
  await q.locator('[data-save]').click();
  await q.waitForTimeout(250);
  ok('blank title rejected', await q.locator('#f-err:not([hidden])').count() === 1);

  await q.fill('#f-title', "Katz's Delicatessen");
  ok('the place/spot switch is shown', await q.locator('#f-kindrow:not([hidden])').count() === 1);
  await q.locator('[data-save]').click();
  await q.waitForTimeout(250);
  ok('saving without place or spot is refused', (await q.locator('#f-err').innerText()).includes('place or an exact spot'));
  await q.locator('#f-kind [data-kind="place"]').click();
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
  ok('place or spot saved', row.map_kind === 'place');
  ok('reservation captured', row.needs_reservation === true && row.booked === true && row.confirmation === 'KZ-8841');
  ok('extras captured', Array.isArray(row.extras) && row.extras[0].amount === 18);
  ok('queued for geocoding', row.geo_status === 'pending' || row.geo_status === 'ok', row.geo_status);
  ok('stop appears in the list', await q.locator('.stop').count() === 1);
  ok('day jumped to the stop\'s day', (await q.locator('.daytitle').innerText()).includes('November 25'));

  console.log('\n— GEOCODING —');
  await q.waitForTimeout(2600);
  const geo = await q.evaluate(() => window.S.events[0]);
  ok('coordinates resolved from Nominatim', Math.abs(geo.lat - 40.7223) < 1e-6, JSON.stringify([geo.lat, geo.lng, geo.geoStatus]));
  ok('marker drawn on the map', await q.evaluate(() => window.__markers > 0));

  console.log('\n— APPLE MAPS —');
  const whereHref = await q.locator('.stop a.where').getAttribute('href');
  ok('list address links to Apple Maps', whereHref.startsWith('https://maps.apple.com/?q=205%20E%20Houston%20St'), whereHref);
  const hits = await q.evaluate(() => {
    document.querySelector('.stop').scrollIntoView({ block: 'center' });
    const at = el => { const b = el.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); };
    return { link: at(document.querySelector('.stop a.where')).className, marker: at(document.querySelector('.stop .marker')).className };
  });
  ok('a tap on the address lands on the link', hits.link === 'where', hits.link);
  ok('a tap elsewhere on the card opens the stop', hits.marker === 'stop-open', hits.marker);

  console.log('\n— DETAIL SHEET —');
  await q.locator('.stop-open').first().click();
  await q.waitForTimeout(400);
  ok('sheet opens', await q.locator('#sheet.open').count() === 1);
  ok('cost grid shown for a priced stop', await q.locator('.costgrid b').count() === 2);
  const cg = await q.locator('.costgrid b').allTextContents();
  ok('per-person and total correct', cg[0] === '$32' && cg[1] === '$146', JSON.stringify(cg));
  ok('the sum is spelled out with the extras', (await q.locator('.costmath').innerText()).replace(/\s+/g, ' ') === '$32 × 4 people = $128 + Egg creams $18 = $146',
     await q.locator('.costmath').innerText());
  ok('the trip budget counts the extras', (await q.locator('#budgetN').innerText()) === '$146', await q.locator('#budgetN').innerText());
  ok('the total is labelled as including extras', (await q.locator('.costgrid span').nth(1).innerText()).includes('WITH EXTRAS'));
  ok('reservation bar reads Booked', (await q.locator('.resbar h4').innerText()).includes('Booked'));
  ok('address opens in Apple Maps', await q.locator('.d-row a[href^="https://maps.apple.com/?q=205%20E%20Houston%20St"]').count() === 1);
  ok('directions open in Apple Maps', await q.locator('.d-row a[href="https://maps.apple.com/?daddr=40.7223,-73.9874"]').count() === 1);

  console.log('\n— BUDGET BY CATEGORY —');
  await q.locator('#closeSheet').click();
  await q.waitForTimeout(350);
  await q.locator('#budget').click();
  await q.waitForTimeout(400);
  await q.locator('[data-btab="cat"]').click();
  await q.waitForTimeout(200);
  ok('categories start closed', await q.locator('.bcat-items').count() === 0);
  await q.locator('[data-bcat="lunch"]').click();
  await q.waitForTimeout(200);
  const inside = await q.locator('.bcat.open .bitem').allInnerTexts();
  ok('a category opens to the stops behind its total', inside.length === 1 && inside[0].includes("Katz's") && inside[0].includes('$146'), JSON.stringify(inside));
  await q.locator('.bcat.open .bitem').first().click();
  await q.waitForTimeout(400);
  ok('a stop in the list opens that stop', (await q.locator('#sheetTitle').innerText()).startsWith('Wed'));

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
  ok('to-book header shown', (await q.locator('.daytitle').innerText()).includes('Still to book'));
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
  await q.locator('#filterBtn').click();
  await q.waitForTimeout(200);
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

  console.log('\n— SNACKS CATEGORY —');
  await q.locator('#fab').click();
  await q.waitForTimeout(400);
  await q.fill('#f-title', 'Levain Bakery');
  await q.locator('#f-cats [data-cat="snacks"]').click();
  await q.locator('#f-kind [data-kind="spot"]').click();
  await q.locator('[data-save]').click();
  await q.waitForTimeout(600);
  ok('snacks saved as the category', await q.evaluate(() => window.__rows[0].category) === 'snacks');
  ok('snacks shown on the stop', (await q.locator('.stop .tags').innerText()).includes('Snacks'));

  ok('an exact spot with no address is not searched by name', await q.evaluate(() => window.__rows[0].geo_status) === 'none');

  console.log('\n— PLACE SUGGESTIONS —');
  await q.locator('#fab').click();
  await q.waitForTimeout(400);
  await q.fill('#f-title', 'Dinner @ Quality Italian');
  await q.locator('#f-kind [data-kind="place"]').click();
  await q.locator('#f-place').pressSequentially('qu', { delay: 30 });
  await q.waitForTimeout(600);
  ok('no suggestions under 3 characters', await q.locator('#f-suggest[hidden]').count() === 1);
  await q.locator('#f-place').pressSequentially('ality', { delay: 30 });
  await q.waitForTimeout(800);
  ok('suggestions appear as you type', await q.locator('#f-suggest button').count() === 1);
  await q.locator('#f-suggest button').first().click();
  ok('picking one fills the address and pin', await q.inputValue('#f-addr') === '57 West 57th Street' && (await q.inputValue('#f-lat')).startsWith('40.7645'));
  await q.locator('[data-save]').click();
  await q.waitForTimeout(600);
  const qi = await q.evaluate(() => window.__rows.find(r => r.place_name === 'Quality Italian'));
  ok('business name saved', !!qi && qi.address === '57 West 57th Street');
  const link = await q.locator('.stop a.where').first().getAttribute('href');
  ok('a place opens Apple Maps by name', link.startsWith('https://maps.apple.com/?q=Quality%20Italian&sll=40.76457'), link);

  console.log('\n— TRAVEL BETWEEN STOPS —');
  await q.evaluate(async () => {
    const base = { day: '2026-11-25', duration_min: 60, status: 'confirmed', category: 'sights', people: 2, cost_per_person: 0, extras: [],
      needs_reservation: false, booked: false, geo_status: 'manual', map_kind: 'place', place_name: '' };
    window.__rows.length = 0;
    window.__rows.push({ ...base, id: 'leg-a', time: '15:00', title: 'Hotel', address: '237 W 54th St', lat: 40.7645, lng: -73.9830 },
                       { ...base, id: 'leg-b', time: '16:30', title: 'Levain', address: '351 Amsterdam Ave', lat: 40.7813, lng: -73.9797 });
    await window.Data.load();
    window.S.day = '2026-11-25'; window.S.toBookOnly = false;
  });
  await q.locator('#rail [data-day="2026-11-25"]').click();
  await q.waitForTimeout(1500);
  const leg = await q.locator('.leg').first().innerText();
  ok('distance and blocks follow the walking route', leg.includes('1.3 mi') && leg.includes('26 blocks'), leg);
  ok('walking time from the street route', leg.includes('28 min'), leg);
  ok('car time at Manhattan traffic speed, not empty streets', leg.includes('13 min'), leg);
  ok('subway: the fastest trip that uses the subway, with its lines', leg.includes('16 min') && leg.includes('D › 1'), leg);
  ok('three mode icons on the card', await q.locator('.leg .mode svg').count() === 3);
  ok('the trip here sits inside the card, under the name and above the map link', await q.evaluate(() => {
    const card = document.querySelectorAll('.stop .card')[1], kids = [...card.children].map(k => k.className);
    return kids.indexOf('leg') === kids.indexOf('when') + 2 && kids.indexOf('leg') < kids.indexOf('where'); }));
  ok('no routes button', await q.locator('.legcta').count() === 0);

  // The section end carries the last stop's rule, and moves when a later stop arrives.
  const rules = () => q.evaluate(() => [...document.querySelectorAll('.stop')].map(s =>
    s.querySelector('[data-open]').dataset.open + ':' + getComputedStyle(s.querySelector('.card')).borderBottomWidth).join(' '));
  ok('the last stop of a section has no rule of its own', await rules() === 'leg-a:1px leg-b:0px', await rules());
  await q.evaluate(async () => {
    window.__rows.push({ ...window.__rows[1], id: 'leg-c', time: '17:30', title: 'Late stop' });
    await window.Data.load();
  });
  await q.locator('#rail [data-day="2026-11-25"]').click();
  await q.waitForTimeout(300);
  ok('a new last stop takes over, and the one before gets its rule back', await rules() === 'leg-a:1px leg-b:1px leg-c:0px', await rules());
  await q.evaluate(async () => { window.__rows.splice(2, 1); await window.Data.load(); });
  await q.locator('#rail [data-day="2026-11-25"]').click();
  await q.waitForTimeout(1200);

  console.log('\n— ROUTES ON THE MAP —');
  const lineLen = id => q.evaluate(i => { const d = window.__map._src[i].data; return d.features.map(f => f.geometry.coordinates.length); }, id);
  ok('the map draws the walking route along streets, not a straight line', JSON.stringify(await lineLen('route')) === '[4]', JSON.stringify(await lineLen('route')));
  // Reordering: move the second stop before the first and the legs follow.
  await q.evaluate(async () => { const r = window.__rows.find(x => x.id === 'leg-b'); r.time = '14:00'; await window.Data.load(); });
  await q.locator('#rail [data-day="2026-11-25"]').click();
  await q.waitForTimeout(1500);
  ok('reordered stops are re-paired and routed', await q.locator('.leg[data-from="leg-b"][data-to="leg-a"]').count() === 1);

  console.log('\n— PICKING UP A NEW DEPLOY —');
  // A page built as version aaaa1111, with version.json saying bbbb2222 is out.
  const u = await ctx.newPage();
  await u.route('http://local/index.html*', r => r.fulfill({ contentType: 'text/html',
    body: fs.readFileSync(ROOT + '/index.html', 'utf8').replace('src="app.js"', 'src="app.js?v=aaaa1111"') }));
  await u.route('http://local/version.json*', r => r.fulfill({ contentType: 'application/json', body: '{"v":"bbbb2222"}' }));
  await u.goto('http://local/index.html');
  await u.waitForTimeout(1500);
  ok('an out-of-date page reloads itself at the new version', u.url().includes('?v=bbbb2222'), u.url());
  // The cached page is served again, still old: it must not reload a second time.
  const before = u.url();
  await u.reload();
  await u.waitForTimeout(1500);
  ok('it does not keep reloading if the new version does not arrive', u.url() === before, u.url());
  await u.close();

  console.log('\n— NOTES —');
  // Old plain-text notes keep their line breaks when shown.
  await q.evaluate(async () => {
    window.__rows.push({ id: 'n1', day: '2026-11-25', time: '09:00', duration_min: 30, title: 'Notes test', category: 'other', status: 'confirmed',
      people: 2, cost_per_person: 0, extras: [], needs_reservation: false, booked: false, geo_status: 'none', map_kind: 'spot',
      notes: 'Line one\nLine two\n\nAfter a gap' });
    await window.Data.load();
  });
  await q.evaluate(() => window.openDetail('n1'));
  await q.waitForTimeout(400);
  ok('plain notes keep their line breaks', (await q.locator('dd.note').innerText()) === 'Line one\nLine two\n\nAfter a gap', JSON.stringify(await q.locator('dd.note').innerText()));
  // Write formatted notes in the editor.
  await q.evaluate(() => window.openForm('n1'));
  await q.waitForTimeout(400);
  ok('the notes box has a formatting toolbar', await q.locator('.notebar [data-fmt]').count() === 6);
  await q.locator('#f-notes').click();
  await q.keyboard.press('ControlOrMeta+a');
  await q.keyboard.press('Delete');
  await q.keyboard.type('Pack layers');
  await q.keyboard.press('ControlOrMeta+a');
  await q.locator('[data-fmt="bold"]').click();
  await q.keyboard.press('End');
  await q.keyboard.press('Enter');
  await q.locator('[data-fmt="bold"]').click();   // bold off for the list, as in any editor
  await q.locator('[data-fmt="insertUnorderedList"]').click();
  await q.keyboard.type('Gloves');
  await q.keyboard.press('Enter');
  await q.keyboard.type('Hat');
  await q.locator('[data-save]').click();
  await q.waitForTimeout(600);
  const saved = await q.evaluate(() => window.__rows.find(r => r.id === 'n1').notes);
  ok('bold and bullets are saved', /<b>Pack layers<\/b>/.test(saved) && /<ul><li>Gloves<\/li><li>Hat<\/li><\/ul>/.test(saved), saved);
  await q.evaluate(() => window.openDetail('n1'));
  await q.waitForTimeout(400);
  ok('and shown that way', await q.locator('dd.note b').count() === 1 && await q.locator('dd.note li').count() === 2);
  // Highlight in a pin-family colour.
  await q.evaluate(() => window.openForm('n1'));
  await q.waitForTimeout(400);
  await q.locator('#f-notes').click();
  await q.keyboard.press('ControlOrMeta+End');
  await q.keyboard.press('Enter');
  await q.keyboard.type('Pink bit');
  for (let k = 0; k < 'Pink bit'.length; k++) await q.keyboard.press('Shift+ArrowLeft');
  await q.locator('[data-fmt="hilite"]').click();
  { const n = await q.locator('#f-hlbar:not([hidden]) [data-hl]').count(); ok('highlight opens a row of colours', n === 7, n); }
  await q.locator('[data-hl="pink"]').click();
  await q.locator('[data-save]').click();
  await q.waitForTimeout(600);
  ok('the highlight colour is kept', /<mark class="hl-pink">Pink bit<\/mark>/.test(await q.evaluate(() => window.__rows.find(r => r.id === 'n1').notes)),
     await q.evaluate(() => window.__rows.find(r => r.id === 'n1').notes));
  // The form has been opened many times by now; a tap must still act once.
  await q.evaluate(() => window.openForm('n1'));
  await q.waitForTimeout(300);
  const ex0 = await q.locator('#f-extras .extra').count();
  await q.locator('#f-addextra').click();
  ok('a tap acts once however often the form has opened', await q.locator('#f-extras .extra').count() === ex0 + 1);
  await q.locator('[data-cancel]').click();
  await q.waitForTimeout(300);
  // Pasted or stored markup is reduced to the allowed tags, no attributes.
  await q.evaluate(async () => {
    const r = window.__rows.find(x => x.id === 'n1');
    r.notes = '<div>Hi <img src=x onerror="window.__xss=1"><a href="https://x">link</a> <b onclick="x()">bold</b><script>window.__xss=2<\/script></div>';
    await window.Data.load(); window.openDetail('n1');
  });
  await q.waitForTimeout(400);
  ok('unsafe markup in notes is stripped', await q.evaluate(() => !window.__xss && !document.querySelector('dd.note img, dd.note a, dd.note script, dd.note [onclick]'))
     && (await q.locator('dd.note').innerText()).includes('link'));
  await q.locator('#closeSheet').click();
  await q.waitForTimeout(300);

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
