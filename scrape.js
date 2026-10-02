/**
 * AlbertaCasinoScout.ca — bonus-page watcher.
 *
 * What this does, in one sentence: visit each operator's Watch URL with a
 * real headless browser, pull out the visible offer/promo text, and tell
 * WordPress whether that text is different from last time.
 *
 * What this deliberately does NOT do: parse wagering multipliers, deposit
 * minimums, or anything else into the site's Value Score rubric. A flagged
 * change means "a human should read this page and decide what changed" —
 * never "the scraper decided the new numbers." Free-text bonus copy is
 * too inconsistent across operators (see the "15x on deposit only" vs.
 * "50/50 proportional" vs. plain "31x wagering" cases already found in
 * this project) to auto-classify safely. Getting this wrong doesn't just
 * mis-tag a promotion — it can push a worse offer above a better one in
 * the "Highest Value" sort, which is the entire point of the tool.
 *
 * Run schedule: intended to run twice a month via a Railway cron trigger
 * (or GitHub Actions scheduled workflow, or `node scrape.js` by hand).
 * Not hourly — these are welcome-bonus terms, not odds; they don't need
 * anything close to real-time checking, and running less often makes each
 * site less likely to notice/block this as automated traffic.
 */

const { chromium } = require('playwright');
require('dotenv').config();

const WP_BASE_URL = (process.env.WP_BASE_URL || '').replace(/\/$/, '');
const WP_CRON_KEY = process.env.WP_CRON_KEY || '';
const PAGE_TIMEOUT_MS = parseInt(process.env.PAGE_TIMEOUT_MS || '25000', 10);
const DELAY_BETWEEN_SITES_MS = parseInt(process.env.DELAY_BETWEEN_SITES_MS || '8000', 10);

if (!WP_BASE_URL || !WP_CRON_KEY) {
  console.error('Missing WP_BASE_URL or WP_CRON_KEY. Copy .env.example to .env and fill both in.');
  process.exit(1);
}

const WATCH_LIST_URL = `${WP_BASE_URL}/wp-json/acs-operators/v1/watch-list?key=${encodeURIComponent(WP_CRON_KEY)}`;
const RESULT_URL = `${WP_BASE_URL}/wp-json/acs-operators/v1/scrape-result?key=${encodeURIComponent(WP_CRON_KEY)}`;

/**
 * A realistic desktop user-agent + viewport. Several of these operator
 * sites (bet365, BetMGM, FanDuel, PointsBet, Videoslots) previously
 * blocked automated fetches outright — this alone won't guarantee past
 * bot-detection the way a real residential IP did in the earlier manual
 * Chrome-extension pass, but it's the ceiling of what server-side
 * automation can do. Sites that still block this are expected to report
 * fetch_error, not silently succeed with garbage content.
 */
const CONTEXT_OPTIONS = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'en-CA',
  timezoneId: 'America/Edmonton',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${options.method || 'GET'} ${url} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Pulls visible text from the page, trying to skip nav/footer/cookie-
 * banner noise so the diff is sensitive to actual offer-copy changes,
 * not to a footer year or a cookie-consent wording tweak. This is a
 * best-effort heuristic, not a guarantee — if a site's markup doesn't
 * match these common patterns, it falls back to the full <main> or
 * <body> text, which just means the diff is a bit noisier for that one
 * site (more false "changed" flags), never a missed real change.
 */
async function extractOfferText(page) {
  return page.evaluate(() => {
    const KILL_SELECTORS = [
      'nav', 'footer', 'header',
      '[class*="cookie" i]', '[id*="cookie" i]',
      '[class*="banner-consent" i]',
      'script', 'style', 'noscript',
    ];

    const clone = document.body.cloneNode(true);
    KILL_SELECTORS.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Prefer a narrower content container if one obviously exists —
    // this is what keeps a slider/modal offer (PlayOJO, Golden Nugget)
    // in scope while dropping global chrome around it.
    const candidates = [
      '[class*="promo" i]',
      '[class*="bonus" i]',
      '[class*="offer" i]',
      'main',
    ];

    let target = null;
    for (const sel of candidates) {
      const found = clone.querySelector(sel);
      if (found && found.innerText && found.innerText.trim().length > 40) {
        target = found;
        break;
      }
    }
    if (!target) target = clone;

    return target.innerText
      .replace(/[ \t]+/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000); // WordPress side also caps this; keep payloads sane
  });
}

async function checkOne(browser, item) {
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    console.log(`  -> ${item.operator || item.label}: ${item.url}`);
    await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });

    // Give client-side sliders/modals (PlayOJO's rotating slider, Golden
    // Nugget's homepage modal) a moment to render before we read the DOM.
    // This is a fixed wait rather than waiting for a specific selector
    // because every site's markup differs and there's no single selector
    // that generalizes across 20 different operators.
    await page.waitForTimeout(3000);

    const text = await extractOfferText(page);

    if (!text || text.length < 20) {
      // A page that loaded but yielded almost no text is more likely a
      // bot-detection wall or interstitial than a genuinely empty offer
      // page — treat it as a fetch problem, not "the offer is blank",
      // so it doesn't get silently recorded as a false "no current offer"
      // snapshot.
      return {
        promotion_id: item.promotion_id,
        url: item.url,
        status: 'fetch_error',
        error: 'Page loaded but almost no text was extracted (likely blocked or an interstitial).',
      };
    }

    return { promotion_id: item.promotion_id, url: item.url, status: 'ok', text };
  } catch (err) {
    return {
      promotion_id: item.promotion_id,
      url: item.url,
      status: 'fetch_error',
      error: String(err.message || err).slice(0, 500),
    };
  } finally {
    await context.close();
  }
}

async function main() {
  console.log(`Fetching watch list from ${WP_BASE_URL} ...`);
  const watchList = await fetchJson(WATCH_LIST_URL);

  if (!Array.isArray(watchList) || watchList.length === 0) {
    console.log('Watch list is empty — nothing to check. Add a Watch URL to a promotion in wp-admin first.');
    return;
  }

  console.log(`${watchList.length} URL(s) to check.\n`);

  const browser = await chromium.launch({ headless: true });
  const summary = { ok_unchanged: 0, ok_changed: 0, fetch_error: 0 };

  try {
    for (let i = 0; i < watchList.length; i++) {
      const item = watchList[i];
      const result = await checkOne(browser, item);

      try {
        const posted = await fetchJson(RESULT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });

        if (result.status === 'fetch_error') {
          summary.fetch_error++;
          console.log(`     fetch_error: ${result.error}`);
        } else if (posted.changed) {
          summary.ok_changed++;
          console.log('     CHANGED since last check — flagged for review.');
        } else {
          summary.ok_unchanged++;
          console.log('     no change.');
        }
      } catch (postErr) {
        console.error(`     Failed to report result to WordPress: ${postErr.message}`);
      }

      if (i < watchList.length - 1) {
        await sleep(DELAY_BETWEEN_SITES_MS);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\nDone.');
  console.log(`  Unchanged: ${summary.ok_unchanged}`);
  console.log(`  Changed (needs review): ${summary.ok_changed}`);
  console.log(`  Fetch errors: ${summary.fetch_error}`);

  if (summary.ok_changed > 0) {
    console.log('\nCheck wp-admin > Operators > Promotions — flagged rows are marked "Changed".');
  }
}

main().catch((err) => {
  console.error('Scrape run failed:', err);
  process.exit(1);
});
