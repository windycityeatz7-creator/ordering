# Windy City Eatz — Inventory Ordering & Management

A mobile-friendly, PIN-based inventory ordering system for Windy City Eatz's
three locations (Soul, Raceway, Trailer). Built as a vanilla HTML/CSS/JS
single-page app backed by Supabase (Postgres + Realtime + RLS), with email
notifications via EmailJS and hosting on Netlify.

## How it works

Four roles, each gated by a PIN (no email/password accounts):

| Role | Default PIN | Can do |
|---|---|---|
| Employee | `1111` | Submit inventory requests (urgent any day, regular orders on Mondays only), view their location's request history |
| Order Team | `2222` | Review pending requests, place orders with a chosen supplier, view dashboard & order history |
| Receiving | `3333` | Check in deliveries, confirm quantities received, view history |
| Admin | `4444` | Everything above, plus Settings (items, categories, suppliers, locations, PINs) |

All PINs are changeable from the Admin Settings tab (minimum 3 characters).

## Project structure

```
public/               static site source (deployed as-is or via the build script)
  index.html
  css/styles.css
  js/
    config.template.js   placeholder env-var template, filled in at build time
    supabaseClient.js    Supabase client + data access helpers
    email.js             EmailJS notification helper
    app.js                app state, rendering, and all tab logic
scripts/build.js       copies public/ -> dist/, injects env vars into config.js
supabase/migrations/20260718000000_init.sql   full schema + seed data
.github/workflows/supabase-migrations.yml   auto-applies new migrations on push
netlify.toml           build command, publish dir, SPA redirect
```

## 1. Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run `supabase/migrations/20260718000000_init.sql`.
   This creates the `config` and `orders` tables, enables Row Level
   Security, adds permissive anon policies (see note below), enables
   Realtime on both tables, and seeds the default locations, categories,
   suppliers, starting inventory items, and PINs. The whole file is safe
   to re-run if it fails partway through — every statement is written to
   be idempotent.
3. From **Project Settings -> API**, copy the **Project URL** and the
   **anon public key** — you'll need both for step 3.

### A note on Row Level Security

This app authenticates with simple in-app PIN checks rather than Supabase
Auth (per the product requirement of PIN-only login, no accounts). Because
every request uses the public anon key with no per-user JWT, the RLS
policies in the migration are intentionally permissive (`using (true)`)
rather than locked to a role — they exist to keep the tables deliberately
exposed rather than default-denied, and to document intent. Role
authorization (who can submit vs. place orders vs. receive vs. edit
settings) is enforced in the client UI only. If you need real
per-role database security, put a Supabase Edge Function (or small server)
in front of writes that validates the caller's PIN/role server-side, and
tighten the RLS policies to require it.

### Automatic migrations (optional)

`.github/workflows/supabase-migrations.yml` uses the Supabase CLI to
automatically apply any file added under `supabase/migrations/` whenever
it's pushed to the deploy branch — so future schema changes just need a
new `supabase/migrations/<timestamp>_description.sql` file committed and
pushed, no manual SQL Editor step required.

To enable it, add three repository secrets (GitHub repo -> **Settings ->
Secrets and variables -> Actions -> New repository secret**):

| Secret | Where to find it |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase dashboard -> your account menu (top right) -> **Account -> Access Tokens** -> Generate new token |
| `SUPABASE_PROJECT_ID` | Project Settings -> General -> **Reference ID** (also the subdomain in your Project URL, e.g. `xxxxx` in `https://xxxxx.supabase.co`) |
| `SUPABASE_DB_PASSWORD` | The database password you set when creating the project. If forgotten, reset it under Project Settings -> Database -> **Reset database password** |

Without these secrets the workflow will simply fail (harmlessly) on the
`supabase link` step — the site itself is unaffected either way, since
Netlify deploys are a separate pipeline. This is entirely optional; you
can always keep applying migrations by hand in the SQL Editor instead.

## 2. Set up EmailJS

1. Create a free account at [emailjs.com](https://www.emailjs.com).
2. Add an email service and note its **Service ID** (this project expects
   `service_umcj6lb`, or update `public/js/config.template.js` if you use
   a different one).
3. Create an email template with the ID `wce_order` that uses exactly two
   variables in its body/subject: `{{subject}}` and `{{message}}`.
4. In the template's **To Email** field, enter the fixed recipient list
   (comma-separated): `windycityeatz7@gmail.com, pcashay@gmail.com`. The
   app only ever sends `{{subject}}` and `{{message}}` — recipients are
   configured on the template itself, not passed from the client.
5. Copy your **Public Key** from Account -> API Keys (this project expects
   `v8nPd6OHNuUkGfuGW`; update the template file if yours differs).

## 3. Configure environment variables

The app needs your Supabase URL and anon key at runtime. Since this is a
static site, a tiny build step (`scripts/build.js`) injects them into
`dist/js/config.js` at deploy time.

**On Netlify** (Site settings -> Environment variables), add:

- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_ANON_KEY` — your Supabase anon public key

**For local development**, copy the template and fill in the values:

```bash
cp public/js/config.template.js public/js/config.js
```

Edit `public/js/config.js` and replace `__SUPABASE_URL__` and
`__SUPABASE_ANON_KEY__` with your real values. This file is gitignored so
your local credentials never get committed. Then serve `public/` directly
(e.g. `npm run dev`, or any static file server) — no build step is needed
for local dev since `config.js` already has real values.

## 4. Deploy

1. Push this repo to GitHub.
2. In Netlify, "Add new site -> Import an existing project" and pick the
   repo. Netlify will read `netlify.toml` automatically:
   - Build command: `node scripts/build.js`
   - Publish directory: `dist`
3. Add the `SUPABASE_URL` / `SUPABASE_ANON_KEY` environment variables
   (step 3 above) before the first deploy, or trigger a redeploy after
   adding them.
4. Every push to `main` auto-deploys.

## Data model

**`config`** — single row (`id = 1`) holding all app-wide settings:
`locations`, `categories`, `suppliers`, `items` (array of
`{id, name, unit, category}`), and `pins` (`{employee, orderteam,
receiving, admin}`). Editable live from Admin -> Settings.

**`orders`** — one row per line item within a submission batch (rows
sharing a `batch_id` were submitted together). Status flows:

```
pending  --(Order Team places order)-->  ordered  --(Receiving checks in)-->  received | partial
   |
   +--(Order Team dismisses)--> dismissed
```

Realtime is enabled on both tables, so every connected screen (dashboard,
review queue, receiving queue, history) updates live without a refresh.
The sync indicator dot in the top nav reflects the realtime connection
state (green = live, yellow = connecting, red = offline).

## Order window rule

Employees can submit **regular** quantities only on Mondays. Any day of
the week they can flag an item 🔴 **Urgent** to submit it immediately —
outside of Monday, quantity controls stay locked for an item until its
Urgent toggle is turned on, and the Submit tab shows an amber banner
explaining this.
