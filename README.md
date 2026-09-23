# New York — Thanksgiving 2026

A two-person trip dashboard. Real map, live sync between phones, tracks what
still needs booking. Everything on free tiers, no credit card anywhere.

**Stack:** GitHub Pages · MapLibre GL JS + OpenFreeMap · Supabase (Postgres,
Realtime, Auth) · Nominatim geocoding

If you are Claude Code, read `CLAUDE.md` first — it has the decisions and the
reasoning. This file is just the setup sequence.

---

## 1. Supabase

Create a free project at supabase.com. No card needed. Note two things from
**Project Settings → API**: the **Project URL** and the **anon / public** key.

Open **SQL Editor → New query**, paste in `supabase/schema.sql`, and — before
running it — edit the two rows in the `trip_members` insert to the real email
addresses. Those two addresses are the only ones that will ever be able to read
or write the trip. Run it.

Then **Authentication → URL Configuration**: add your GitHub Pages URL (from
step 3, so come back to this) to **Redirect URLs**. Magic links bounce without
it.

## 2. Local config

```bash
cp config.example.js config.js     # gitignored — never committed
```

Fill in the project URL and anon key. Open `index.html` through any local
server and you should get the sign-in screen.

> The anon key is *meant* to be public. It names the project; it grants
> nothing. Row Level Security decides access. The **service_role** key is the
> dangerous one — it bypasses RLS. It belongs only in your shell for step 5.

## 3. GitHub Pages

```bash
gh repo create nyc-trip --public --source=. --push
```

Then **Settings → Pages → Source: GitHub Actions**. The included
`deploy.yml` publishes on every push to `main`.

Because `config.js` is gitignored, the workflow writes it at build time from
repository secrets. Add them under
**Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | your project URL |
| `SUPABASE_ANON_KEY` | the anon / public key |

Do **not** add the service_role key as a secret. The Pages build output is
public.

Push, watch the Actions tab, and take the URL it gives you back to step 1.

## 4. Keepalive

Nothing to do — `keepalive.yml` is already wired to the same two secrets and
runs every 3 days. Free Supabase projects pause after 7 days with no requests,
and a paused project takes 10–30 seconds to wake. This stops that happening the
morning you actually need the app.

Trigger it once by hand from the Actions tab to confirm it returns HTTP 200.

## 5. Seed the itinerary

From **Project Settings → API**, reveal the `service_role` key. Then, once:

```bash
SUPABASE_URL=https://YOUR-REF.supabase.co \
SUPABASE_SERVICE_KEY=eyJ...service_role... \
node private/seed.mjs
```

31 stops go in. Add `--replace` to wipe and reseed.

Open the site and sign in. Pins fill in over roughly 35 seconds — geocoding is
deliberately one request per second to stay inside Nominatim's usage policy.

## 6. Check it actually works

Three things the offline test suite cannot verify:

- **Tiles render.** You should see real streets, not a blank canvas.
- **Auth is tight.** Sign in with an address *not* in `trip_members` — you
  should get in but see nothing.
- **Live sync.** Open the site in two windows, add a stop in one, and watch it
  appear in the other without a refresh.

---

## Using it

Tap a day along the top; the map and list both filter to it. Stops are numbered
in time order, same number on the pin and in the list, with walking distance
between consecutive stops. Category chips filter across food, sightseeing,
shows, travel. **To book** drops the day filter and lists every outstanding
reservation across the whole trip.

**+ New stop** saves immediately and finds the map pin in the background. Every
stop has editable lat/lng; typing coordinates by hand permanently overrides the
lookup.

## Tests

```bash
npm install          # playwright
node test/smoke.cjs
```

Runs fully offline against stubs. 42 assertions.

## Attribution

Map data © OpenStreetMap contributors, tiles by
[OpenFreeMap](https://openfreemap.org), schema
[© OpenMapTiles](https://www.openmaptiles.org/). Geocoding by Nominatim.
Attribution is rendered in the map corner and is required — leave it in place.
