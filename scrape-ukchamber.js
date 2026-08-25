/**
 * UK Chamber of Shipping — Member Directory Scraper
 * ------------------------------------------------
 * Scrapes every member (name, website, email, phone, category) from
 * https://www.ukchamberofshipping.com/join/member-directory/all — a
 * public page, no login required.
 *
 * CONFIRMED by fetching the live page directly: this site is fully
 * server-rendered. Every member (roughly 250, A through Z) is already
 * present in the initial HTML — there is no pagination and no real
 * lazy-loading. The scroll-based "keep loading until no new cards appear"
 * logic below is kept as a defensive no-op in case that ever changes, but
 * in practice it will just confirm the count is stable and move on.
 *
 * ALSO CONFIRMED: the directory listing itself does not show email or
 * phone numbers anywhere — each entry is just "[Company Name](website),
 * Category". The script still fully implements mailto:/tel: + visible-text
 * extraction (safe either way, and future-proof if the site ever adds
 * contact details), but expect the email/phone columns to be empty for
 * virtually every row — that reflects the real page content, not a bug.
 * Some entries also have no link at all (plain text, no href) — those are
 * handled as "no website" rather than an error.
 *
 * Install dependencies first (from the shared project folder):
 *   npm install
 *
 * Run:
 *   node scrape-ukchamber.js
 *
 * Output:
 *   uk-chamber-of-shipping.csv
 *   uk-chamber-of-shipping.json
 *   uk-chamber-of-shipping-errors.log
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ------------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------------
const CONFIG = {
  url: 'https://www.ukchamberofshipping.com/join/member-directory/all',

  csvPath: path.join(__dirname, 'uk-chamber-of-shipping.csv'),
  jsonPath: path.join(__dirname, 'uk-chamber-of-shipping.json'),
  errorLogPath: path.join(__dirname, 'uk-chamber-of-shipping-errors.log'),

  // CONFIRMED: every member is wrapped in exactly one <article> inside
  // this block, so selecting all of them directly is far more robust than
  // walking through the fragile nth-child chain from the original
  // inspected selector — this naturally finds every member regardless of
  // how many there are.
  blockSelector: '#block-views-block-members-list',
  cardSelector: '#block-views-block-members-list article',
  // Relative to a card: the wrapper holding the name link + trailing
  // ", Category" text (matches the originally inspected selector's shape).
  nameAndCategoryContainerSelector: 'div > div',
  nameLinkSelector: 'div > div > a',

  cardWaitTimeoutMs: 20000,
  scrollPauseMs: 800,
  maxScrollAttemptsWithNoChange: 3, // defensive lazy-load safety net (see header comment)

  minDelayMs: 300,
  maxDelayMs: 700,

  maxPageLoadRetries: 3,
  pageLoadRetryDelayMs: 4000,

  // Google Sheets webhook (Apps Script Web App) — receives all rows from
  // a single scrape run in one POST request.
  webhookUrl: 'https://script.google.com/macros/s/AKfycbyDwDbctXQxNnnWuQoKwKOG4r9wjHtgPlSJghERdxBMzg9EXJvTy15X5p5c4lHdC0L_/exec',
  webhookSecret: 'scrapemaster',
  webhookRetryDelayMs: 3000,
};

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function randomDelay(min, max) {
  return new Promise((resolve) => {
    const ms = min + Math.random() * (max - min);
    setTimeout(resolve, ms);
  });
}

function clean(t) {
  return (t || '').replace(/\s+/g, ' ').trim();
}

function normalizeName(name) {
  return clean(name).toLowerCase();
}

function logError(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(CONFIG.errorLogPath, line);
  } catch (e) {
    console.error('(also could not write to error log)', e.message);
  }
}

// ------------------------------------------------------------------
// Data persistence (CSV + JSON, written live; resume support)
// ------------------------------------------------------------------

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCsvAndJson(allResults) {
  fs.writeFileSync(CONFIG.jsonPath, JSON.stringify(allResults, null, 2));

  const header = 'company,website,email,phone,category';
  const rows = allResults.map((r) =>
    [r.company, r.website, r.email, r.phone, r.category].map(csvEscape).join(',')
  );
  fs.writeFileSync(CONFIG.csvPath, [header, ...rows].join('\n') + '\n');
}

function loadExistingResults() {
  if (!fs.existsSync(CONFIG.jsonPath)) return [];
  try {
    const raw = fs.readFileSync(CONFIG.jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.log(`  ⚠ Could not parse existing ${CONFIG.jsonPath} (${e.message}). Starting fresh.`);
    return [];
  }
}

// ------------------------------------------------------------------
// Google Sheets webhook — batch-send all rows from this run in one POST
// ------------------------------------------------------------------

async function postRowsToWebhook(rows, attempt = 1) {
  if (!CONFIG.webhookUrl) return;

  if (!rows.length) {
    console.log('No rows to send to the Sheets webhook — skipping.');
    return;
  }

  const payload = {
    secret: CONFIG.webhookSecret,
    rows,
  };

  console.log(`Sending ${rows.length} row(s) to Sheets webhook (attempt ${attempt})...`);

  try {
    const res = await fetch(CONFIG.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let data;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }

    if (data.status !== 'ok') {
      throw new Error(`Webhook returned non-ok status: ${JSON.stringify(data)}`);
    }

    console.log(`✔ Webhook accepted the rows. rowsAppended: ${data.rowsAppended}`);
    return data;
  } catch (err) {
    const message = `Webhook POST failed (attempt ${attempt}): ${err.message}`;
    console.error(`❌ ${message}`);
    logError(message);

    if (attempt === 1) {
      await randomDelay(CONFIG.webhookRetryDelayMs, CONFIG.webhookRetryDelayMs + 500);
      return postRowsToWebhook(rows, attempt + 1);
    }

    console.error('❌ Webhook POST failed after retry. Continuing without crashing — see error log.');
    logError('Webhook POST gave up after retry.');
    return null;
  }
}

// ------------------------------------------------------------------
// Page loading (with retries) + defensive lazy-load handling
// ------------------------------------------------------------------

async function loadDirectoryPage(page) {
  for (let attempt = 1; attempt <= CONFIG.maxPageLoadRetries; attempt += 1) {
    try {
      await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForSelector(CONFIG.cardSelector, { timeout: CONFIG.cardWaitTimeoutMs });
      return true;
    } catch (e) {
      logError(`Page load failed (attempt ${attempt}/${CONFIG.maxPageLoadRetries}): ${e.message}`);
      console.log(`  ⚠ Page load failed (attempt ${attempt}/${CONFIG.maxPageLoadRetries}): ${e.message}`);
      if (attempt < CONFIG.maxPageLoadRetries) {
        await randomDelay(CONFIG.pageLoadRetryDelayMs, CONFIG.pageLoadRetryDelayMs + 1500);
      }
    }
  }
  return false;
}

// Defensive: scroll toward the bottom and keep checking whether the
// number of cards increases. On this site (fully server-rendered) this
// will typically just confirm the count is stable after one pass and
// return immediately — but it protects against the site changing to a
// lazy-loaded implementation in the future.
async function loadAllCardsIncludingLazy(page) {
  let previousCount = await page.$$eval(CONFIG.cardSelector, (els) => els.length);
  let stableRounds = 0;

  while (stableRounds < CONFIG.maxScrollAttemptsWithNoChange) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(CONFIG.scrollPauseMs, CONFIG.scrollPauseMs + 400);

    const currentCount = await page.$$eval(CONFIG.cardSelector, (els) => els.length);
    if (currentCount > previousCount) {
      console.log(`  Loaded more members while scrolling (${previousCount} → ${currentCount})...`);
      previousCount = currentCount;
      stableRounds = 0;
    } else {
      stableRounds += 1;
    }
  }

  return previousCount;
}

// ------------------------------------------------------------------
// Per-member extraction
// ------------------------------------------------------------------

async function extractMemberData(cardHandle, config) {
  return cardHandle.evaluate((cardEl, cfg) => {
    function clean(t) {
      return (t || '').replace(/\s+/g, ' ').trim();
    }

    const container = cardEl.querySelector(cfg.nameAndCategoryContainerSelector) || cardEl;
    const link = cardEl.querySelector(cfg.nameLinkSelector);

    let name = '';
    let website = '';

    if (link) {
      name = clean(link.textContent);
      const href = (link.getAttribute('href') || '').trim();
      // Only treat it as a company website if it's not an internal
      // ukchamberofshipping.com page (e.g. a link back to a category page).
      if (href && !/ukchamberofshipping\.com/i.test(href)) {
        website = href;
      }
    }

    // Category = whatever text is left in the container after removing
    // the link's own text, then stripping a leading comma/whitespace.
    // This avoids blindly splitting on every comma, since it's based on
    // DOM structure (link vs. surrounding text) rather than string parsing.
    let category = '';
    if (link) {
      const fullText = clean(container.textContent);
      const linkText = clean(link.textContent);
      if (fullText.startsWith(linkText)) {
        category = fullText.slice(linkText.length).replace(/^[,\s]+/, '').trim();
      }
    } else {
      // No link at all — whole text is "Name, Category" as plain text.
      const fullText = clean(container.textContent);
      const commaIndex = fullText.indexOf(',');
      if (commaIndex !== -1) {
        name = fullText.slice(0, commaIndex).trim();
        category = fullText.slice(commaIndex + 1).replace(/^[,\s]+/, '').trim();
      } else {
        name = fullText;
      }
    }

    // --- Emails: mailto: links + any visible email-looking text ---
    const mailtoEmails = Array.from(cardEl.querySelectorAll('a[href^="mailto:"]'))
      .map((a) => (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim())
      .filter(Boolean);
    const textEmailMatches = (cardEl.textContent.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).map((e) => e.trim());
    const emails = Array.from(new Set([...mailtoEmails, ...textEmailMatches].filter(Boolean)));

    // --- Phones: tel: links + any visible phone-looking text ---
    const telPhones = Array.from(cardEl.querySelectorAll('a[href^="tel:"]'))
      .map((a) => (a.getAttribute('href') || '').replace(/^tel:/i, '').trim())
      .filter(Boolean);
    const textPhoneMatches = (
      cardEl.textContent.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || []
    ).map((p) => p.trim());
    const phones = Array.from(new Set([...telPhones, ...textPhoneMatches].filter(Boolean)));

    return { name, website, emails, phones, category };
  }, config);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
  console.log('Starting UK Chamber of Shipping scraper...\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  const loaded = await loadDirectoryPage(page);
  if (!loaded) {
    console.error(`❌ Could not load the directory page after ${CONFIG.maxPageLoadRetries} attempts. Aborting.`);
    logError(`Aborted: could not load directory page after ${CONFIG.maxPageLoadRetries} attempts.`);
    await browser.close();
    process.exit(1);
  }

  const totalCards = await loadAllCardsIncludingLazy(page);
  console.log(`Found ${totalCards} company/member items.\n`);

  // --- Resume support ---
  const existingResults = loadExistingResults();
  const allResults = existingResults;
  const seenNames = new Set(existingResults.map((r) => normalizeName(r.company)));
  if (existingResults.length > 0) {
    console.log(`Resuming: found ${existingResults.length} previously-saved companies. Skipping ones already saved.\n`);
  }

  let duplicateCount = 0;
  let errorCount = 0;
  const newlyScrapedThisRun = [];

  const cardHandles = await page.$$(CONFIG.cardSelector);

  for (let i = 0; i < cardHandles.length; i += 1) {
    const card = cardHandles[i];
    try {
      const data = await extractMemberData(card, CONFIG);
      const name = clean(data.name);

      if (!name) {
        console.log(`[${i + 1}/${cardHandles.length}] (skipped — no name found)`);
        continue;
      }

      const key = normalizeName(name);
      if (seenNames.has(key)) {
        duplicateCount += 1;
        console.log(`[${i + 1}/${cardHandles.length}] ${name}\n  ↳ Skipped (duplicate)`);
      } else {
        seenNames.add(key);
        const record = {
          company: name,
          website: data.website || '',
          email: data.emails.join(' | '),
          phone: data.phones.join(' | '),
          category: data.category || '',
        };
        allResults.push(record);
        newlyScrapedThisRun.push(record);
        writeCsvAndJson(allResults); // live save after every company

        console.log(`[${i + 1}/${cardHandles.length}] ${name}`);
        console.log(`Website: ${record.website || 'N/A'}`);
        console.log(`Email: ${record.email || 'N/A'}`);
        console.log(`Phone: ${record.phone || 'N/A'}`);
        console.log(`Category: ${record.category || 'N/A'}`);
        console.log('Saved\n');
      }
    } catch (err) {
      errorCount += 1;
      logError(`Card ${i + 1}: ${err.message}`);
      console.log(`[${i + 1}/${cardHandles.length}] ⚠ Error processing this company — logged, continuing.`);
    } finally {
      await card.dispose();
      await randomDelay(CONFIG.minDelayMs, CONFIG.maxDelayMs);
    }
  }

  await browser.close();

  console.log('SCRAPE COMPLETE\n');
  console.log(`Companies found: ${cardHandles.length}`);
  console.log(`Unique companies saved: ${allResults.length}`);
  console.log(`Duplicates skipped: ${duplicateCount}`);
  console.log(`Errors: ${errorCount}\n`);
  console.log(`CSV: ${CONFIG.csvPath}`);
  console.log(`JSON: ${CONFIG.jsonPath}\n`);

  // Send this run's newly-scraped rows to the Sheets webhook in one batch.
  await postRowsToWebhook(newlyScrapedThisRun);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  logError(`Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
