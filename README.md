# AlbertaCasinoScout bonus-page watcher

Twice-a-month check of every operator's Watch URL. It never edits your
promotion data — it only tells WordPress "this page's text is different
from last time," and flags that promotion in wp-admin for you to review
by hand. See the big comment at the top of `scrape.js` for why it doesn't
try to auto-parse rubric scores.

## One-time setup

### 1. On the WordPress side
Nothing to install — this ships as part of the Operator Manager plugin
(v1.3.0+). For each promotion you want checked:

1. Go to **Operators > Promotions > [edit a promotion]**
2. Paste the operator's offer/terms page into the new **Watch URL** field
3. Save

Only promotions with a Watch URL set get checked. Add or remove URLs any
time in wp-admin — the scraper always asks WordPress for the current list,
it never keeps its own copy.

### 2. Get your cron key
On the **Promotions** screen, the "Hourly check URL" box shows a URL like
`.../wp-json/acs-operators/v1/run-check?key=abc123...` — the part after
`?key=` is your cron key. The same key authenticates this scraper.

### 3. Local/Railway setup
```
npm install
npx playwright install chromium   # only needed once, downloads the browser binary
cp .env.example .env
# edit .env: set WP_BASE_URL and WP_CRON_KEY
npm run scrape
```

## Running it twice a month

**Recommended: Railway Cron Trigger.** Push this repo to Railway as its
own service, set the same environment variables in Railway's dashboard
instead of a `.env` file, and set the service's cron schedule to run on
the 1st and 15th of each month, e.g.:
```
0 9 1,15 * *
```
(9am UTC ≈ 2-3am Alberta time — fine since nothing here is time-
sensitive; pick any time that isn't overlapping a deploy window.)

Railway will run `npm start` (or whatever start command you configure) on
that schedule and exit when done — no server needs to stay running
between checks.

**Alternative: GitHub Actions scheduled workflow**, if you'd rather not
spin up a Railway service just for this — same idea, a `schedule: cron:`
trigger in a workflow file, secrets stored as repo secrets instead of a
`.env`. Ask if you want this written out instead.

## What "changed" actually means

The scraper extracts visible text from the part of the page that looks
like an offer/promo block (falls back to the whole page if it can't find
one) and compares it byte-for-byte against the last successful check. Any
difference — a new dollar figure, a new expiry date, reworded terms, even
a typo fix — flags the promotion. It is deliberately oversensitive: a
false "changed" flag costs you two minutes of reading a page that turned
out to be the same; a missed real change costs you a stale, wrong offer
staying live on the site. Err toward the cheap mistake.

The first time a URL is checked, there's nothing to compare against yet,
so it just records a baseline silently — you won't get a "changed" flag
on a promotion's very first scrape.

## What "fetch_error" means

The scraper couldn't get usable text from the page — timeout, the site
blocked the request, a redirect loop, or the page loaded but came back
basically empty (usually an interstitial or bot-check page, not a
genuinely blank offer). This is never treated as a content change and
never overwrites the last good snapshot. It's recorded so you can see in
wp-admin which sites are currently unreachable to automation — several
operators (bet365, BetMGM, FanDuel, PointsBet, Videoslots) blocked even a
real Chrome browser during earlier manual research, so it's likely some
Watch URLs will need periodic manual rechecking no matter what.

## Extending the watch list

Any promotion with a Watch URL gets checked automatically — there's
nothing to configure in this repo when you add a new operator. Just add
the URL in wp-admin.
