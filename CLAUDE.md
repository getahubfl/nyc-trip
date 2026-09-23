# NYC Trip Dashboard — project context

Read this first. It carries the decisions already made so you don't re-litigate
them, and flags the things that are genuinely still open.

## What this is

A personal itinerary dashboard for a Thanksgiving trip to New York, used by two
people — Paris and his wife Megan — mostly on phones, while walking around the
city. It shows each day's stops in order on a real map, filters by day and
category, tracks what still needs booking, and syncs live between both phones.

It is not a product. It does not need accounts, onboarding, analytics, or a
landing page. It needs to be correct, fast on a phone, and pleasant to open.

## Trip facts

- **Dates:** Wed 25 Nov – Mon 30 Nov 2026
- **Arrival:** JFK, then a Blade helicopter into Manhattan (not car or train)
- **Hotel 1:** Hilton Garden Inn Central Park South, 237 W 54th St — Wed to Sat,
  check-in 15:00 Wed, checkout 12:00 Sat
- **Hotel 2:** Sat to Mon, Manhattan, **not yet booked**
- **Travellers:** Paris and Megan, with Mom & Dad joining for parts
- Megan is gluten-free; the trip is not built around gluten-free dining
- It is Paris' first time in New York, so the goal is classic New York

Two real scheduling conflicts are already in the data and should stay visible
rather than being silently "fixed":

1. **Thursday** — the Turkey Trot is at 06:30 against a 07:20–07:40 parade
   arrival on Central Park West. Tight. Race not yet chosen.
2. **Friday** — the 9/11 Memorial ends 11:10 and the timeshare presentation
   starts 11:15 in Midtown. Not physically possible.

Still open with the family: which Turkey Trot, Thanksgiving lunch, Friday
pre-theater dinner, both "Surprise" activities, comedy club after *Chicago*,
Hotel 2, and all of Sunday and Monday.

## Architecture, and why

Everything here is on a free tier with no credit card anywhere.

| Concern | Choice | Why |
|---|---|---|
| Hosting | GitHub Pages | Free on a free account for public repos. Static only, which is all this is. |
| Map | MapLibre GL JS + OpenFreeMap | Free, no API key, no card, no request limits. OSM data. Google and Mapbox both want a card on file. |
| Data + live sync | Supabase (Postgres + Realtime) | Realtime pushes row changes over a websocket, which is the "both phones update" requirement. |
| Auth | Supabase magic link | No passwords. Restricted to an allow-list of two emails. |
| Geocoding | Nominatim (OpenStreetMap) | Free, no key. Rate limited to one request per second by policy. |
| Keepalive | GitHub Actions cron | Free Supabase projects pause after 7 days idle; a paused project cold-starts in 10–30s. |

**The host and the database are not connected.** The browser loads static files
from GitHub Pages, then talks directly to Supabase over HTTPS. There is no
server, no build-time integration, no environment plumbing between the two.

### Why the repo is public and the trip data is not

GitHub Pages on a free account requires a public repository, and the deployed
page is public regardless of plan. So **no personal detail lives in the repo**.
Hotels, confirmation numbers, names, and the fact that they're away from home
all live in the Supabase database behind auth. `config.js` and `private/` are
gitignored. Keep it that way — do not inline itinerary data into the source,
and do not commit `config.js`.

The Supabase **anon key is public by design** and ships in the page. It
identifies the project; it grants nothing. Access is decided entirely by Row
Level Security in `supabase/schema.sql`, which requires a signed-in user whose
email is in `trip_members`. The **service_role key bypasses RLS** — it belongs
only in a local shell for the one-off seed, never in `config.js`, never in a
GitHub secret used by the Pages workflow, never in the repo.

## Files

```
index.html              page shell, auth gate, map container
styles.css              all styling (mid-century modern, see below)
app.js                  the whole application, ES module
config.example.js       template — copy to config.js with real values
supabase/schema.sql     tables, RLS policies, realtime, heartbeat. Run once.
.github/workflows/
  deploy.yml            builds config.js from secrets, publishes to Pages
  keepalive.yml         pings Supabase every 3 days so it never pauses
private/                gitignored
  itinerary.json        the real 31 stops
  seed.mjs              one-time loader into Supabase
test/smoke.js           Playwright suite, runs fully offline against stubs
```

`app.js` is organised top to bottom as: reference data → utilities → row
mapping → state → data layer → geocoding → map → filtering → rendering →
sheet/detail/form → global event handling → auth gate → boot.

## Conventions that matter

- **Database columns are snake_case; the app is camelCase.** `fromRow` and
  `toRow` in `app.js` are the only translation layer. If you add a field, add it
  to the table, to both mappers, to the form, and to the detail view.
- **Writes are optimistic.** `Data.update` applies the change locally, renders,
  then writes; on error it rolls back and toasts. Realtime re-applies the same
  row, which is idempotent because everything is keyed by `id`.
- **One event per place.** "Brooklyn Bridge → Financial District → 9/11
  Memorial" is three rows, not one. They are three pins with real walking
  distance between them, which is the point of the map.
- **Order within a day comes from `time`**, never from a manual sort field.
  Stops with no time sort last.
- **Geocoding is asynchronous and never blocks.** A new stop saves and appears
  immediately with no pin; the lookup fills the pin in later. While it is
  pending the UI shows rotating New York flavoured copy ("Asking a cabbie…",
  "Somewhere between 5th and 6th…"). If the lookup *fails*, the copy drops the
  personality and says plainly "No location yet — add coordinates". Keep that
  split: waiting is charming, errors are direct.
- **Hand-typed coordinates always win.** Setting lat/lng by hand marks the row
  `geo_status = 'manual'` and the lookup will not overwrite it.
- **Nominatim is one request per second, serialised.** Do not parallelise the
  geocoding queue. Their usage policy is the constraint, not performance.

## Design direction

Mid-century modern New York — 1958 Manhattan, Saul Bass, travel-poster
graphics. Warm paper ground, deep petrol for structure, dusty period accents
(burnt orange, mustard, olive, brick). Flat colour; no gradients, no soft
shadows, no glassmorphism. Geometric shapes, restrained border radius (crisp
corners or full pills, not a uniform 8px on everything). Big, handsome numerals
— the numbered stops and times are a visual feature.

Mobile-first. Big tap targets, thumb-reachable actions, legible at arm's length
in daylight.

Avoid: generic SaaS cards, all-caps eyebrow labels over every heading, emoji as
iconography, purple/indigo tech gradients.

Colour encodes meaning, not decoration — category colour on markers and chips,
status colour on badges, brick for "not booked" and olive for "booked".
"Not booked" should read louder than "Booked"; unbooked items are the thing
being tracked.

## Setup, in order

See `README.md` for the full walkthrough. Short version:

1. Create the Supabase project. Run `supabase/schema.sql`, with the two real
   emails edited into the `trip_members` insert.
2. `cp config.example.js config.js` and fill in the project URL and anon key.
3. `gh repo create` (public), push, then enable Pages with **Source: GitHub
   Actions**.
4. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` as repository secrets so the
   deploy workflow can write `config.js`.
5. In Supabase Auth → URL Configuration, add the Pages URL to the allowed
   redirect URLs, or the magic link will bounce.
6. Seed once: `SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node private/seed.mjs`
7. Open the site, sign in, and let the pins fill in (~35 seconds for 31 stops
   at one lookup per second).

## Testing

`node test/smoke.cjs` runs a Playwright suite with Supabase, MapLibre and
Nominatim all stubbed, so it works with no network and no credentials. It
covers the auth gate, day and category filtering, the to-book view, adding and
editing and deleting a stop, the reservation subform, cost maths, geocoding,
manual coordinates, and the desktop layout. 42 assertions, all passing as
shipped.

What it does **not** cover, because it cannot without real credentials:
whether OpenFreeMap tiles actually render, whether Supabase RLS admits the
right people, and whether realtime actually pushes between two browsers. Verify
those three by hand on the first deploy — open the site in two windows and add
a stop in one.

## Open product questions

- Sunday and Monday are empty. Once plans firm up they're just more rows.
- ~~Nothing surfaces a trip-wide budget total. Per-event cost only, by
  decision.~~ **Closed.** A Budget view now rolls costs up trip-wide: overview
  (total, committed vs still-to-book), by day, by category, and every priced
  stop largest-first. It reads `S.events` directly and deliberately ignores the
  day and category filters — the question it answers is about the whole trip,
  not the current view. Note the seeded itinerary ships with every
  `cost_per_person` at 0, so the view is empty until costs are entered.
- No offline support. If the subway kills signal mid-walk, the page shows what
  it already loaded but cannot save. A service worker with a write queue would
  fix it and is probably the single highest-value addition before the trip.
- Phase 2 originally imagined shared editing; Supabase Realtime already
  delivers it, so that item is closed.
