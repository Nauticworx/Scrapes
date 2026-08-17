/**
 * Ruzave Directory Scraper (all sections, merged)
 * ------------------------------------------------
 * Combines what used to be five near-identical scripts (chartering-broking,
 * freight-forwarders, ocean-logistics, port-terminal-services, maritime)
 * into one. The scraping logic was identical across all five — only the
 * start URL and output filename differed — so this version loops over the
 * list of sections below and reuses the same code for each.
 *
 * For each company card on a given section's listing page, this script
 * reads the card's name, opens that company's detail link in a separate
 * background browser tab, scrapes website/email/phone/country from it
 * using ICON TYPE (not class names — this site's classes are
 * auto-generated Tailwind utility classes and aren't stable identifiers),
 * closes that tab, and moves to the next card. The main tab (and its
 * pagination state) is never disturbed. Then it paginates and repeats,
 * then moves on to the next section.
 *
 * CONFIRMED from live markup you inspected:
 *   - Card grid container:
 *       div.flex-1.grid.grid-cols-1.sm:grid-cols-2.lg:grid-cols-3.gap-4
 *     Each direct child <div> of that grid is one company card.
 *   - Inside each card, the clickable link to a company's detail info is:
 *       div.p-5.flex.flex-col.items-center.pt-10 > div.flex.gap-2.mt-3 > a
 *   - On the detail view, fields are identified by icon, not class name:
 *       Website -> svg.lucide-globe
 *       Email   -> svg.lucide-mail   (link href="mailto:...")
 *       Phone   -> svg.lucide-phone  (link href="tel:...")
 *       Address -> svg.lucide-map-pin
 *       Owner   -> svg.lucide-users
 *
 * STILL UNCONFIRMED (best-effort defaults below — flagged with TODO):
 *   - Exactly which element holds the company NAME text on the card
 *     (the script tries several common heading patterns).
 *   - Whether "country" is its own field anywhere. The sample detail view
 *     only showed a combined street/city/state/zip address, no separate
 *     country line. The script leaves "country" blank unless it finds a
 *     dedicated field for it — see fieldIconSelectors.country below.
 *   - Whether the detail link's href is a real navigable URL (best case)
 *     or a JS-only trigger like "#" (in which case the script falls back
 *     to clicking it in place and reading a modal from the same tab).
 *
 * Results are POSTed as JSON to a Google Apps Script web app (see
 * CONFIG.webhookUrl). Every record is also written in real time to a
 * local JSON file AND a local CSV file (see CONFIG.jsonOutputFile /
 * CONFIG.csvOutputFile) as soon as it's scraped, so nothing scraped is
 * lost even if the webhook is down or the run gets interrupted partway
 * through — two independent backup formats on disk, not just one.
 *
 * PERFORMANCE: detail pages are scraped CONFIG.concurrency at a time
 * (separate background tabs), image/font/stylesheet requests are
 * blocked on those tabs since only the DOM/icons matter, and navigation
 * uses 'domcontentloaded' + a short explicit wait for the icons rather
 * than waiting for full network-idle. Tune CONFIG.concurrency up/down
 * based on how the site holds up.
 *
 * Install dependencies first:
 *   npm init -y
 *   npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer
 *
 * Run (requires Node 18+ for built-in fetch):
 *   node scrape_ruzave.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ------------------------------------------------------------------
// CONFIG — adjust these if the script isn't picking up data correctly
// ------------------------------------------------------------------
const CONFIG = {
  // Every section that used to be its own script. Each has its own
  // listing URL; results from all of them are combined into one CSV
  // (see outputFile below), tagged with which section they came from.
  sections: [
    { key: 'chartering-broking', label: 'Chartering & Broking', startUrl: 'https://ruzave.com/chartering-broking' },
    { key: 'freight-forwarders', label: 'Freight Forwarders', startUrl: 'https://ruzave.com/freight-forwarders' },
    { key: 'ocean-logistics', label: 'Ocean Logistics', startUrl: 'https://ruzave.com/ocean-logistics' },
    { key: 'port-terminal-services', label: 'Port Terminal Services', startUrl: 'https://ruzave.com/port-terminal-services' },
    { key: 'maritime', label: 'Maritime', startUrl: 'https://ruzave.com/maritime' },
  ],

  // Combined output — one row per company, across all sections above.
  // Sent as JSON to this Google Apps Script web app instead of a CSV file.
  webhookUrl:
    'https://script.google.com/macros/s/AKfycbzGs54MM9Nyx-lx05wMnxkStRKyo6OcIgFE4d413eRKGJVt79tbONQ40yzb0blO6QGd/exec',

  // Sent one section at a time as it finishes (rather than one giant
  // request at the end), so partial results still make it to the sheet
  // even if a later section fails or the run is interrupted.
  sendPerSection: true,

  // Local live backup: every record is written here as soon as it's
  // scraped (in addition to being sent to the webhook), so nothing is
  // lost even if the webhook is down, the script crashes, or you need
  // to stop it partway through a 70-page run. Both files are updated
  // together (JSON + CSV) so you have two independent copies on disk.
  jsonOutputFile: 'ruzave-live.json',
  csvOutputFile: 'ruzave-live.csv',

  // How many detail pages to scrape IN PARALLEL (each gets its own
  // background tab). This is the single biggest speed lever — going from
  // sequential (1) to e.g. 6 can cut total runtime by roughly that factor.
  // Only applies to cards with a real detail link; cards needing the
  // in-page-click fallback are still handled one at a time (see below).
  // Raise this if the site handles it fine; lower it if you start seeing
  // more failures/timeouts (a sign of rate-limiting).
  concurrency: 6,

  // Delay between opening each company's detail tab (ms) — randomized to
  // look more human and reduce chances of being rate-limited / blocked.
  // Kept short since concurrency + the per-tab timeouts below already
  // cap how much load hits the site at once.
  minDelayMs: 300,
  maxDelayMs: 900,

  // Longer delay specifically between paginating to a new list page.
  minPageDelayMs: 1500,
  maxPageDelayMs: 3000,

  // How long to wait for cards / detail content to appear before giving up.
  // Kept fairly tight: a page that hasn't shown its icons within a few
  // seconds essentially never does, and every second here is multiplied
  // by however many companies end up failing, which adds up fast on a
  // multi-thousand-company run.
  cardWaitTimeoutMs: 15000,
  detailNavTimeoutMs: 12000,
  detailWaitTimeoutMs: 5000,

  // CONFIRMED: direct children of the card grid are the company cards.
  // The site renders slightly different grid classes depending on screen
  // width (a mobile/compact layout vs. a desktop layout with a filter
  // sidebar), so both variants are matched here.
  cardSelector:
    'div.flex-1.grid.grid-cols-1.sm\\:grid-cols-2.lg\\:grid-cols-3.gap-4 > div, ' +
    'div.grid.grid-cols-2.sm\\:grid-cols-2.lg\\:grid-cols-4.gap-4 > div',

  // CONFIRMED: the company name is an <h3> inside the card.
  nameSelectors: ['h3', 'h2', 'h4', '.font-semibold', '.font-bold', '[class*="title"]'],

  // CONFIRMED: within each card, this is the link to the company's info.
  detailLinkSelector: 'div.flex.gap-2.mt-3 a',

  // CONFIRMED: the category label shown on each card (relative to the
  // card root, not the page root — so it works no matter which grid
  // position a given card happens to occupy).
  categorySelector: 'div.p-5.flex.flex-col.items-center.pt-10 > p',

  // Icon-based field detection on the detail view (confirmed from live markup).
  fieldIconSelectors: {
    website: 'svg.lucide-globe',
    email: 'svg.lucide-mail',
    phone: 'svg.lucide-phone',
    address: 'svg.lucide-map-pin',
    owner: 'svg.lucide-users',
    // TODO: no confirmed icon for "country" yet — if the site uses one
    // (e.g. a flag icon), tell me its class and I'll wire it in here.
    country: 'svg.lucide-flag',
  },

  // CONFIRMED: exact "Next page" button, from live markup.
  nextButtonSelector:
    '#root > div.min-h-screen.bg-background > section.max-w-6xl.mx-auto.px-4.py-6 > div.flex.justify-center.items-center.gap-2.mt-8 > button:nth-child(3)',
};

// ------------------------------------------------------------------

function randomDelay(min, max) {
  return new Promise((resolve) => {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    setTimeout(resolve, ms);
  });
}

function clean(t) {
  return (t || '').replace(/\s+/g, ' ').trim();
}

// Read each card's name + the href of its detail link (if any), without
// holding onto ElementHandles (the DOM may re-render between steps).
async function getCardSummaries(page, cardSelector, nameSelectors, detailLinkSelector, categorySelector) {
  return page.evaluate(
    (cardSelector, nameSelectors, detailLinkSelector, categorySelector) => {
      function cleanText(t) {
        return (t || '').replace(/\s+/g, ' ').trim();
      }
      const cards = Array.from(document.querySelectorAll(cardSelector));
      return cards.map((card, index) => {
        let name = '';
        for (const sel of nameSelectors) {
          const el = card.querySelector(sel);
          if (el && cleanText(el.textContent)) {
            name = cleanText(el.textContent);
            break;
          }
        }
        const link = card.querySelector(detailLinkSelector);
        const href = link ? link.getAttribute('href') : null;
        const categoryEl = card.querySelector(categorySelector);
        const category = categoryEl ? cleanText(categoryEl.textContent) : '';
        return { index, name, href, category };
      });
    },
    cardSelector,
    nameSelectors,
    detailLinkSelector,
    categorySelector
  );
}

// Extract fields from whatever page/tab is passed in, by searching the
// WHOLE document for the icon rows (works whether it's a full detail page
// or a modal injected into the current page).
async function scrapeDetailFields(targetPage, fieldIconSelectors) {
  return targetPage.evaluate((fieldIconSelectors) => {
    function cleanText(t) {
      return (t || '').replace(/\s+/g, ' ').trim();
    }

    function extractByIcon(iconSelector, hrefPrefix = null) {
      const icon = document.querySelector(iconSelector);
      if (!icon) return '';
      const row = icon.closest('div') || icon.parentElement;
      if (!row) return '';
      if (hrefPrefix) {
        const link = row.querySelector(`a[href^="${hrefPrefix}"]`);
        if (link) {
          const href = link.getAttribute('href') || '';
          return cleanText(href.replace(hrefPrefix, ''));
        }
      }
      const link = row.querySelector('a');
      if (link) {
        const txt = cleanText(link.textContent);
        if (txt) return txt;
      }
      return cleanText(row.textContent);
    }

    return {
      website: extractByIcon(fieldIconSelectors.website),
      email: extractByIcon(fieldIconSelectors.email, 'mailto:'),
      phone: extractByIcon(fieldIconSelectors.phone, 'tel:'),
      address: extractByIcon(fieldIconSelectors.address),
      country: extractByIcon(fieldIconSelectors.country),
    };
  }, fieldIconSelectors);
}

// Wait until at least one of the field icons shows up (used both for a
// freshly opened detail tab and for a same-page modal fallback).
async function waitForDetailContent(targetPage, fieldIconSelectors, timeout) {
  const combinedSelector = Object.values(fieldIconSelectors).join(', ');
  await targetPage.waitForSelector(combinedSelector, { timeout });
}

function hasRealLink(href) {
  return Boolean(href && href.trim() && href.trim() !== '#' && !href.trim().toLowerCase().startsWith('javascript:'));
}

// Blocks image/font/media/stylesheet requests on a page. The scraper only
// needs the DOM (specifically a handful of SVG icons + adjacent text), so
// none of these are needed — skipping them cuts real page-load time
// substantially, especially on pages with lots of photos/logos.
async function blockHeavyResources(targetPage) {
  await targetPage.setRequestInterception(true);
  targetPage.on('request', (req) => {
    const type = req.resourceType();
    if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
      req.abort();
    } else {
      req.continue();
    }
  });
}

// Simple concurrency-limited queue runner — no external deps. Pulls items
// off a shared cursor so N workers stay busy until the list is drained,
// rather than processing everything strictly one at a time.
async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      await worker(items[i], i);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
}

// Scrape one company's detail info. Prefers opening the link in a fresh
// background tab (doesn't disturb the list page / pagination at all, and
// is safe to run concurrently with other calls since each gets its own
// tab). If there's no usable href, falls back to clicking the link in
// place and reading the resulting modal from the same tab — this path is
// NOT concurrency-safe since it shares the single main `page`, so callers
// must run fallback cards one at a time.
async function scrapeCompanyDetail(browser, page, cardIndex, href, config) {
  const isRealLink = hasRealLink(href);

  if (isRealLink) {
    const absoluteUrl = new URL(href, page.url()).toString();
    const detailPage = await browser.newPage();
    try {
      await blockHeavyResources(detailPage);
      await detailPage.goto(absoluteUrl, { waitUntil: 'domcontentloaded', timeout: config.detailNavTimeoutMs });
      await waitForDetailContent(detailPage, config.fieldIconSelectors, config.detailWaitTimeoutMs);
      // The icon (e.g. svg.lucide-mail) can render before the actual
      // email/phone text does — those often arrive via a slightly later
      // fetch. Wait for in-flight requests to quiet down (short timeout,
      // non-fatal) on top of a longer settle pause, so we don't extract
      // before that data has actually landed in the DOM.
      await detailPage.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
      await randomDelay(500, 900); // let content settle
      const data = await scrapeDetailFields(detailPage, config.fieldIconSelectors);
      return data;
    } catch (e) {
      return null;
    } finally {
      await detailPage.close();
    }
  }

  // Fallback: click the link in place on the main page and read a modal.
  try {
    await page.evaluate(
      (cardSelector, detailLinkSelector, cardIndex) => {
        const cards = Array.from(document.querySelectorAll(cardSelector));
        const card = cards[cardIndex];
        if (!card) return;
        const link = card.querySelector(detailLinkSelector) || card;
        link.click();
      },
      config.cardSelector,
      config.detailLinkSelector,
      cardIndex
    );
    await waitForDetailContent(page, config.fieldIconSelectors, config.detailWaitTimeoutMs);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
    await randomDelay(500, 900);
    const data = await scrapeDetailFields(page, config.fieldIconSelectors);

    // Close whatever opened (Radix Dialog-style modals close on Escape).
    await page.keyboard.press('Escape');
    await randomDelay(300, 500);

    return data;
  } catch (e) {
    return null;
  }
}

async function clickNextButton(page, nextButtonSelector) {
  const nextButton = await page.$(nextButtonSelector);
  if (!nextButton) return false;

  const isDisabled = await page.evaluate((el) => {
    return (
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('disabled')
    );
  }, nextButton);

  if (isDisabled) return false;

  await nextButton.click();
  return true;
}

// Grab a fingerprint of the first card's full content — used to detect
// whether clicking "Next" actually swapped in new companies. This doesn't
// depend on the name selector being correct, since it just hashes whatever
// text is inside the card.
async function getFirstCardFingerprint(page, cardSelector) {
  return page.evaluate((cardSelector) => {
    const el = document.querySelector(cardSelector);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }, cardSelector);
}

// This site is a single-page app: clicking "Next" swaps the card content
// in place without changing the URL or triggering a real navigation. So
// instead of waiting for navigation, we wait for the first card's full
// content to become different from what it was before the click. If it
// never changes within the timeout, we treat that as "this was the last
// page" rather than as an error.
async function waitForCardsToChange(page, cardSelector, previousFingerprint, timeout) {
  try {
    await page.waitForFunction(
      (cardSelector, previousFingerprint) => {
        const el = document.querySelector(cardSelector);
        if (!el) return false;
        const text = el.textContent.replace(/\s+/g, ' ').trim();
        return text && text !== previousFingerprint;
      },
      { timeout },
      cardSelector,
      previousFingerprint
    );
    return true;
  } catch (e) {
    return false; // timed out — content never changed
  }
}

async function main() {
  console.log(`🚀 Launching browser... (${CONFIG.sections.length} sections queued)`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  const allResults = [];
  const seenEmails = new Set(); // lowercased/trimmed emails already kept, across all sections
  let duplicateCount = 0;
  let skippedCount = 0;

  for (const section of CONFIG.sections) {
    console.log(`\n\n===== 📂 Section: ${section.label} (${section.startUrl}) =====`);
    let pageNum = 1;
    const sectionResults = [];

    console.log(`🌐 Navigating to ${section.startUrl}`);
    try {
      await page.goto(section.startUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      console.log(`  ⚠ Couldn't load ${section.startUrl} (${e.message}). Skipping this section.`);
      continue;
    }

    while (true) {
      console.log(`\n📄 Scraping page ${pageNum}...`);

      try {
        await page.waitForSelector(CONFIG.cardSelector, { timeout: CONFIG.cardWaitTimeoutMs });
      } catch (e) {
        console.log(`  ⚠ No cards found on page ${pageNum} (selector matched nothing). Stopping this section.`);
        break;
      }

      const cardSummaries = await getCardSummaries(
        page,
        CONFIG.cardSelector,
        CONFIG.nameSelectors,
        CONFIG.detailLinkSelector,
        CONFIG.categorySelector
      );
      console.log(`  Found ${cardSummaries.length} company cards on page ${pageNum}`);

      // Cards with a real detail link can be scraped concurrently (each
      // gets its own background tab). Cards without one need the
      // in-page-click fallback, which shares the single main `page` and
      // so must run one at a time — but those are rare, so this barely
      // affects overall speed.
      const linkedCards = cardSummaries.filter((c) => hasRealLink(c.href));
      const fallbackCards = cardSummaries.filter((c) => !hasRealLink(c.href));

      const handleScraped = ({ name, category }, detailData) => {
        if (!detailData) {
          skippedCount += 1;
          return;
        }
        const record = {
          section: section.label,
          name,
          website: detailData?.website || '',
          email: detailData?.email || '',
          phone: detailData?.phone || '',
          country: detailData?.country || '',
          category: category || '',
        };
        // Dedupe by email: same company can legitimately show up under
        // more than one section (e.g. both "maritime" and "ocean-logistics").
        // Rows with no email can't be deduped this way, so those are
        // always kept.
        const emailKey = record.email.trim().toLowerCase();
        if (emailKey && seenEmails.has(emailKey)) {
          duplicateCount += 1;
        } else {
          if (emailKey) seenEmails.add(emailKey);
          sectionResults.push(record);
          allResults.push(record);
          saveJsonSnapshot(allResults, CONFIG.jsonOutputFile); // write-through after every new record
          saveCsvSnapshot(allResults, CONFIG.csvOutputFile); // same, as a second independent backup format
        }
      };

      await runWithConcurrency(linkedCards, CONFIG.concurrency, async ({ index, name, href, category }) => {
        const label = name || `card #${index + 1}`;
        console.log(`  → (${index + 1}/${cardSummaries.length}) ${label}`);
        const detailData = await scrapeCompanyDetail(browser, page, index, href, CONFIG);
        handleScraped({ name, category }, detailData);
        await randomDelay(CONFIG.minDelayMs, CONFIG.maxDelayMs);
      });

      for (const { index, name, href, category } of fallbackCards) {
        const label = name || `card #${index + 1}`;
        console.log(`  → (${index + 1}/${cardSummaries.length}) ${label} [fallback]`);
        const detailData = await scrapeCompanyDetail(browser, page, index, href, CONFIG);
        handleScraped({ name, category }, detailData);
        await randomDelay(CONFIG.minDelayMs, CONFIG.maxDelayMs);
      }

      console.log(`  ✓ Finished page ${pageNum} of "${section.label}" (${allResults.length} total so far)`);

      // Fingerprint the current first card's full content so we can tell
      // when the click actually swapped in new companies (this SPA doesn't
      // change the URL, so we can't detect it any other way).
      const previousFingerprint = await getFirstCardFingerprint(page, CONFIG.cardSelector);

      await randomDelay(CONFIG.minPageDelayMs, CONFIG.maxPageDelayMs);

      const clicked = await clickNextButton(page, CONFIG.nextButtonSelector);
      if (!clicked) {
        console.log('  🏁 No "Next" button found (or it looks disabled). Moving to next section.');
        break;
      }

      const changed = await waitForCardsToChange(
        page,
        CONFIG.cardSelector,
        previousFingerprint,
        CONFIG.detailWaitTimeoutMs
      );

      if (!changed) {
        console.log('  🏁 Clicking "Next" didn\'t change the cards — must be the last page. Moving to next section.');
        break;
      }

      pageNum += 1;
      await randomDelay(CONFIG.minDelayMs, CONFIG.maxDelayMs); // let content fully settle
    }

    console.log(`✅ Done with "${section.label}" (${allResults.length} total records so far)`);

    if (CONFIG.sendPerSection && sectionResults.length > 0) {
      console.log(`  📤 Sending ${sectionResults.length} "${section.label}" records to Google Sheet...`);
      await sendToWebhookWithRetry(sectionResults, CONFIG.webhookUrl);
    }
  }

  await browser.close();

  if (!CONFIG.sendPerSection) {
    console.log(`\n📤 Sending all ${allResults.length} records to Google Sheet...`);
    await sendToWebhookWithRetry(allResults, CONFIG.webhookUrl);
  } else {
    console.log(`\n✅ All sections sent. ${allResults.length} total records.`);
  }
  if (duplicateCount > 0) {
    console.log(`  (Skipped ${duplicateCount} duplicate record${duplicateCount === 1 ? '' : 's'} with an email already seen elsewhere.)`);
  }
  if (skippedCount > 0) {
    console.log(`  (Skipped ${skippedCount} compan${skippedCount === 1 ? 'y' : 'ies'} whose detail page couldn't be scraped.)`);
  }
}

// Writes the full in-memory results array to a local JSON file, atomically
// (write to a temp file, then rename over the real one). Called after every
// single new record, so ruzave-live.json is always current — if the script
// crashes, gets killed, or the webhook is unreachable, everything scraped
// so far is still safely on disk in valid JSON, not just in memory.
function saveJsonSnapshot(records, filePath) {
  try {
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.log(`  ⚠ Couldn't write live JSON backup (${err.message}).`);
  }
}

const CSV_COLUMNS = ['section', 'name', 'website', 'email', 'phone', 'country', 'category'];

// Quotes a CSV field if it contains a comma, quote, or newline, escaping
// any internal quotes by doubling them (standard CSV escaping).
function toCsvField(value) {
  const str = value == null ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Same fail-safe as saveJsonSnapshot, but as a plain CSV — a second,
// independent local backup (no extra dependency: written by hand rather
// than via csv-writer). Two different formats on disk means one being
// malformed, locked, or hard to open doesn't leave you without any
// usable copy of the data.
function saveCsvSnapshot(records, filePath) {
  try {
    const lines = [CSV_COLUMNS.join(',')];
    for (const record of records) {
      lines.push(CSV_COLUMNS.map((col) => toCsvField(record[col])).join(','));
    }
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.log(`  ⚠ Couldn't write live CSV backup (${err.message}).`);
  }
}

// POSTs a batch of records as JSON to the Google Apps Script web app.
// Apps Script web apps can occasionally return a transient error (cold
// start, temporary quota hiccup), so this retries a few times with a
// short pause before giving up on that batch.
// POSTs a batch of records as JSON to the Google Apps Script web app.
// Apps Script /exec URLs execute the request, then respond with a 302
// redirect to a script.googleusercontent.com URL to actually deliver the
// output. Per the fetch spec, a POST that hits a 301/302 redirect is
// automatically re-sent as a GET with no body — so blindly following it
// (redirect: 'follow') turns into an unauthenticated GET against Google,
// which comes back as 401. The actual doPost() already ran on the
// original POST by that point; we just need to fetch the response body
// without letting fetch silently downgrade the method. So: send with
// redirect: 'manual', and if we get a 3xx back, follow the Location
// ourselves with a plain GET (safe here — that second hop is only
// fetching the already-computed output, not re-executing anything).
async function sendToWebhookWithRetry(records, webhookUrl, maxAttempts = 4) {
  const payload = JSON.stringify({ records });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      let response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        redirect: 'manual',
      });

      // Opaque redirect (type 'opaqueredirect') happens in some fetch
      // implementations under redirect: 'manual' — status won't be
      // readable, but Location usually still is via response.headers.
      const location = response.headers.get('location');
      if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
        if (!location) {
          throw new Error(`Got a redirect (status ${response.status}) but no Location header to follow`);
        }
        response = await fetch(location, { method: 'GET' });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      console.log(`  ✅ Sent ${records.length} records. Response: ${text.slice(0, 200)}`);
      return;
    } catch (err) {
      console.log(`  ⚠ Send attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
      console.error(`❌ Could not send ${records.length} records to the webhook after ${maxAttempts} attempts.`);
      console.error(
        '  If this keeps happening, double-check your Apps Script deployment is set to ' +
          '"Execute as: Me" and "Who has access: Anyone" (Deploy → Manage deployments → Edit).'
      );
      console.error('These records were not delivered. Dumping them to the console so they are not lost:');
      console.error(JSON.stringify(records, null, 2));
    }
  }
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});

/**
 * ------------------------------------------------------------------
 * How to fix remaining selectors:
 * ------------------------------------------------------------------
 * If you see "0 companies found":
 *   - Double-check the CONFIG.cardSelector still matches. Test in
 *     DevTools Console on the live page:
 *       document.querySelectorAll('div.flex-1.grid.grid-cols-1.sm\\:grid-cols-2.lg\\:grid-cols-3.gap-4 > div').length
 *
 * If names come back blank:
 *   - Right-click the company name text on a card -> Inspect, note its
 *     tag/class, and add that selector to the FRONT of CONFIG.nameSelectors.
 *
 * If fields (website/email/phone) come back empty:
 *   - The detail link's href might not be a real navigable URL. Check by
 *     right-clicking the "View" link/button -> Inspect, and look at its
 *     href attribute. If it's "#" or missing, that's expected — the
 *     script automatically falls back to clicking it in place. If THAT
 *     also fails, the modal container might need a specific wait
 *     condition — send me what the console prints and I'll adjust.
 *
 * If "country" always comes back blank:
 *   - There's no confirmed dedicated country field yet. Check the detail
 *     view for a flag icon, badge, or whether the address line ends in a
 *     country name, then tell me and I'll wire it in (either the real
 *     icon class, or logic to parse it out of the address).
 *
 * If records aren't showing up in the Google Sheet:
 *   - Confirm CONFIG.webhookUrl is your Apps Script /exec URL (not /dev),
 *     and that the deployment is set to "Execute as: Me" / "Who has
 *     access: Anyone" (or "Anyone with Google account", matching your
 *     script's auth setup) — otherwise the POST will get redirected to a
 *     login page instead of reaching your doPost(e) function.
 *   - Your Apps Script's doPost(e) needs to parse JSON.parse(e.postData.contents)
 *     and expect a shape of { records: [ {section, name, website, email,
 *     phone, country, category}, ... ] }.
 *   - Check the terminal output — failed sends are retried 4 times, then
 *     the undelivered batch is dumped to the console as JSON so nothing
 *     scraped is lost even if the webhook is down.
 *
 * Tip: test any selector live in the DevTools Console with
 *    document.querySelectorAll('your-selector-here').length
 * ------------------------------------------------------------------
 */
