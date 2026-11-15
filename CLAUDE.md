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

- **Dates:** Wed 25 Nov – Sat 28 Nov 2026, flying home from JFK on Saturday
- **Arrival:** JFK, then a Blade helicopter into Manhattan (not car or train)
- **Hotel 1:** Hilton Garden Inn Central Park South, 237 W 54th St — Wed to Sat,
  check-in 15:00 Wed, checkout 12:00 Sat
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
and the placeholder stops with no location yet.

## Architecture, and why

Everything here is on a free tier with no credit card anywhere.

| Concern | Choice | Why |
|---|---|---|
| Hosting | GitHub Pages | Free on a free account for public repos. Static only, which is all this is. |
| Map | MapLibre GL JS + OpenFreeMap | Free, no API key, no card, no request limits. OSM data. Google and Mapbox both want a card on file. |
| Data + live sync | Supabase (Postgres + Realtime) | Realtime pushes row changes over a websocket, which is the "both phones update" requirement. |
| Auth | Supabase password, one trip account | Family type one password, no email. Restricted to an allow-list in `trip_members`. An emailed code is the fallback — see Conventions. |
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
manifest.webmanifest    makes "Add to Home Screen" a full-screen app
icons/                  Home Screen icon: icon.svg is the source, PNGs rendered from it
styles.css              all styling (see Design direction)
app.js                  the whole application, ES module
config.example.js       template — copy to config.js with real values
supabase/schema.sql     tables, RLS policies, realtime, heartbeat. Run once.
.github/workflows/
  deploy.yml            builds config.js from secrets, publishes to Pages
  keepalive.yml         pings Supabase every 3 days so it never pauses
private/                gitignored
  itinerary.json        the real 31 stops
  seed.mjs              one-time loader into Supabase
test/smoke.cjs          Playwright suite, runs fully offline against stubs
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
- **Sign-in is one trip password.** `config.js` names a single trip account
  (`tripLogin`, from the `TRIP_LOGIN` repo secret); the gate then asks only
  for the password and signs in to that account. Without `tripLogin` it asks
  for an email too. The account's email is therefore public in the deployed
  config — keep it out of the repo itself. Safari and the Home Screen app
  keep separate sign-ins; each asks once and then stays signed in.
- **Short passwords are padded.** Supabase refuses passwords under 6
  characters, so `pw()` appends `PW_PAD` to a shorter one before sign-in and
  `updateUser`; longer ones go as typed. Sign-in also tries the padded form
  (`pwTries`), because one build padded every password. It adds no secrecy.
- **The emailed code is the fallback, and it is typed, not followed.** It is
  the way in before a password exists and after one is forgotten, and a code
  sign-in opens the Trip password sheet. A link signs in whichever browser
  opens it, which on an iPhone is the mail app's own. The pending code
  survives a reload (`PENDING_KEY`), because leaving for the mail app can
  reload the page. The code field also accepts the email's link pasted in,
  but the page does not advertise that: on an iPhone, pressing and holding a
  link to copy it loads a preview, and the preview spends the one-time link.
- **A refused sign-in must be impossible to miss.** Gate messages go through
  `gateSay`; failures are red and sit above the field. In the status line's
  grey at the foot of the card, a refusal read as a button that did nothing.
- **Never let the Supabase client see an error link.** `supabase-js` deletes
  the saved session when the URL carries `error_description`, which is how an
  expired email link arrives. `app.js` strips it before `createClient` runs.
- **Every stop is a place or an exact spot** (`map_kind`, required for new
  stops once the column exists; `Data.hasMapCols` detects it). A place opens
  Apple Maps by its business name (`place_name`), so Maps shows the real place
  card; an exact spot (parade corner, start of a walk) opens the pin.
  `mapsUrl` / `mapsDirectionsUrl` in `app.js`.
- **Place suggestions come from Photon**, as you type the business name.
  Nominatim's policy forbids search-as-you-type. Guardrails in `Suggest`:
  3+ characters, a pause, one request in flight, Manhattan only, cached, and
  a cap per page load.
- **The background lookup is narrow.** An address is always looked up for
  its pin; a stop is searched by name only when it is a place with no
  address (`canLookup`). Lookups are bounded to Manhattan: unbounded,
  "889 Broadway" lands in Brooklyn. A lookup runs once per save; a failed
  one is not retried on page load (that looped forever on addresses
  OpenStreetMap does not know), only on edit or "Re-locate missing pins".
- **Addresses open Apple Maps.** Both travellers carry iPhones. The list row is a `div.stop` whose title is the button,
  stretched over the row in CSS, so the address can be a real link inside it.

## Design direction

A modern app with New York in the details. Neutral canvas: white surfaces,
near-black ink, the phone's system font, generous radius (14px cards and
inputs, pills for chips). Colour is rationed to where it means something.
The New York accents are three, and only three — don't add more:

- **The sign.** The masthead and day rail are subway-sign black, with the
  white rule across the top.
- **Bullets.** Stop numbers are subway bullets: a pastel disc with a dark
  Helvetica numeral and a fine dark ring (`CATS` in `app.js`; `--c`/`--on`
  via `catStyle`). Pastel is Megan's call; the set was measured so every pair
  stays distinct. The walk between stops is drawn as a line joining them.
- **Taxi yellow** for the one primary action (+ New stop) and the selected day.

Red means "not booked" or failed, and green means booked; nothing else uses
them. "Not booked" reads louder than "Booked". Tags are neutral grey pills
except those two. Category colour appears only on bullets, map pins and the
dots in chips — never on text. Mobile-first, big tap targets, legible in
daylight. Avoid: decorative colour, gradients, all-caps headings (small caps
labels on form fields and detail rows only), emoji as iconography.

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
   redirect URLs, or the emailed link will bounce. In Auth → Emails, add
   `{{ .Token }}` to the **Magic Link** and **Confirm signup** templates so
   the fallback email carries a code that can be typed in.
6. Seed once: `SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node private/seed.mjs`
7. Open the site, sign in, and let the pins fill in (~35 seconds for 31 stops
   at one lookup per second).

## Testing

`node test/smoke.cjs` runs a Playwright suite with Supabase, MapLibre and
Nominatim all stubbed, so it works with no network and no credentials. It
covers sign-in by password, by code and by pasted link, setting the trip
password, day and category filtering, the to-book view, adding and editing and
deleting a stop, the reservation subform, cost maths, geocoding, manual
coordinates, the Apple Maps links, place suggestions, and the desktop layout. 95 assertions, all
passing as shipped.

What it does **not** cover, because it cannot without real credentials:
whether OpenFreeMap tiles actually render, whether Supabase RLS admits the
right people, and whether realtime actually pushes between two browsers. Verify
those three by hand on the first deploy — open the site in two windows and add
a stop in one. It also cannot cover Supabase accepting a real password or
sending a real code email, or anything an iPhone does: the Home Screen app,
its saved sign-in, and Apple Maps opening. Those need a phone.

## Open product questions

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
