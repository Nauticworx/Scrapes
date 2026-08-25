/**
 * Maritime Directory Scraper
 * ------------------------------------------------
 * Scrapes company listings (name, website, all emails, all phone numbers,
 * country) from every page of https://maritime-directory.com's Shipowner
 * directory, using YOUR OWN legitimately authenticated free-account
 * session. This script does not bypass, defeat, or circumvent the site's
 * login wall, subscription gating, or any access control — it automates
 * clicking/reading exactly what your logged-in account can already see in
 * a normal browser.
 *
 * FIRST RUN: a visible browser window opens. Log in manually with your own
 * Maritime Directory account, then return to the terminal and press ENTER.
 * Your session is then saved locally (in ./browser-session) so future runs
 * don't require logging in again, unless the site's session expires.
 *
 * Install dependencies first:
 *   npm install
 *
 * Run:
 *   node scrape.js
 *
 * Output:
 *   maritime-directory.csv              - live-updated results (CSV)
 *   maritime-directory.json             - live-updated results (JSON)
 *   maritime-directory-progress.json    - last fully-completed page (for resuming)
 *   maritime-directory-errors.log       - any per-company / per-page errors
 *   browser-session/                    - persistent authenticated browser profile
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ------------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------------
const CONFIG = {
  startUrl:
    'https://maritime-directory.com/?ShipownerSearch%5BshipTypes%5D=&ShipownerSearch%5BshipTypeGroups%5D=&ShipownerSearch%5BcountryGroups%5D=&ShipownerSearch%5Bcountries%5D=&ShipownerSearch%5BparticularRanks%5D=&ShipownerSearch%5BshipTonnages%5D=&ShipownerSearch%5BpredictiveBehaviors%5D=&ShipownerSearch%5Bpage%5D=1',

  userDataDir: path.join(__dirname, 'browser-session'),

  csvPath: path.join(__dirname, 'maritime-directory.csv'),
  jsonPath: path.join(__dirname, 'maritime-directory.json'),
  progressPath: path.join(__dirname, 'maritime-directory-progress.json'),
  errorLogPath: path.join(__dirname, 'maritime-directory-errors.log'),

  // CONFIRMED selectors (from your inspection of the live site).
  cardSelector: 'body > div.sections > main > div > div.section__narrow > div > div > div > ul > li',
  nameSelector: 'article > div.company__header > div.company__info > h2',
  websiteSelector: 'a.company__url',
  expandButtonSelector: 'div.company__header > div.company__more > button',
  loadedDataSelector: '.company__data.js-loaded',
  paginationSelector: 'body > div.sections > main > div > div.section__narrow > div > div > div > div:nth-child(3) > div > ul',

  // TODO / best-effort: the exact class pairing each param label
  // ("Email", "Phone", "Country"...) with its value wasn't given, so this
  // tries several common patterns. If email/phone/country still come back
  // empty even though the card visibly shows them after expanding, right-
  // click one of those label/value pairs on the live site, Inspect, and
  // send me the exact class names so I can tighten this up.
  paramRowSelector: '.company__data li',
  paramLabelSelectors: ['.params__label', '.params__name', '.params__title', 'dt', '.label'],
  paramValueSelectors: ['.params__value', '.params__val', 'dd', '.value'],

  cardWaitTimeoutMs: 20000,
  expandWaitTimeoutMs: 8000,
  pageChangeWaitTimeoutMs: 15000,

  minDelayMs: 1000,
  maxDelayMs: 2500,
  minPageDelayMs: 1800,
  maxPageDelayMs: 3500,

  maxPageRetries: 3,
  pageRetryDelayMs: 4000,

  // Google Sheets webhook (Apps Script Web App) — receives all rows from
  // a single scrape run in one POST request.
  webhookUrl:
    'https://script.google.com/macros/s/AKfycbymW_IDpcBZRDsqx2y-QQv518ignm60TyYOhnmLtcEuCflOzmXpHL1e0E6qrummUhxGDA/exec',
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
    // If we can't even write the error log, at least print it.
    console.error('(also could not write to error log)', e.message);
  }
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
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
  // JSON — straightforward full dump.
  fs.writeFileSync(CONFIG.jsonPath, JSON.stringify(allResults, null, 2));

  // CSV — exact column order requested.
  const header = 'company,website,email,phone,country';
  const rows = allResults.map((r) =>
    [r.company, r.website, r.email, r.phone, r.country].map(csvEscape).join(',')
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

function loadProgress() {
  if (!fs.existsSync(CONFIG.progressPath)) return { lastCompletedPage: 0 };
  try {
    const raw = fs.readFileSync(CONFIG.progressPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { lastCompletedPage: Number(parsed.lastCompletedPage) || 0 };
  } catch (e) {
    console.log(`  ⚠ Could not parse ${CONFIG.progressPath} (${e.message}). Starting from page 1.`);
    return { lastCompletedPage: 0 };
  }
}

function saveProgress(lastCompletedPage) {
  fs.writeFileSync(CONFIG.progressPath, JSON.stringify({ lastCompletedPage }, null, 2));
}

// ------------------------------------------------------------------
// Authentication / session handling
// ------------------------------------------------------------------

// A session is "valid" if, after navigating to the directory URL, we can
// actually see company cards (not a login form / access-denied page).
async function isSessionValid(page) {
  try {
    await page.goto(CONFIG.startUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector(CONFIG.cardSelector, { timeout: 8000 });
    const cardCount = await page.$$eval(CONFIG.cardSelector, (els) => els.length);
    return cardCount > 0;
  } catch (e) {
    return false;
  }
}

async function ensureAuthenticated(page, isFirstEverRun) {
  console.log(isFirstEverRun ? 'No authenticated session found.' : 'Checking saved session...');

  const alreadyValid = await isSessionValid(page);
  if (alreadyValid) {
    console.log('Existing authenticated session detected.\nLogin successful.\nStarting scrape...\n');
    return;
  }

  if (isFirstEverRun) {
    console.log(
      '\nA browser window will open.\n' +
        'Please log in using your free Maritime Directory account.\n\n' +
        'After you have successfully logged in and can access the directory,\n' +
        'return to this terminal and press ENTER to continue.\n'
    );
  } else {
    console.log(
      '\nThe saved Maritime Directory session has expired.\n\n' +
        'Please log in again in the browser window.\n' +
        'After logging in, press ENTER to continue.\n'
    );
  }

  await waitForEnter('Press ENTER once you are logged in and can see the directory... ');

  const nowValid = await isSessionValid(page);
  if (!nowValid) {
    console.log(
      '\n⚠ Still could not detect the directory / company cards after login.\n' +
        'Double-check you are logged in and the directory page loads normally in the browser window.\n'
    );
    await waitForEnter('Press ENTER to try again (or Ctrl+C to quit)... ');
    const secondTry = await isSessionValid(page);
    if (!secondTry) {
      throw new Error('Could not verify directory access after login. Aborting.');
    }
  }

  console.log('✅ Login verified. Session saved for future runs.\n');
}

// ------------------------------------------------------------------
// Card discovery + per-company extraction
// ------------------------------------------------------------------

// Not every <li> under the list is necessarily a real company card — only
// keep ones that actually contain the expected article/header structure.
async function getValidCompanyCardHandles(page) {
  const allCards = await page.$$(CONFIG.cardSelector);
  const valid = [];
  for (const card of allCards) {
    const hasStructure = await card.evaluate(
      (el, nameSelector) => !!el.querySelector('article') && !!el.querySelector(nameSelector),
      CONFIG.nameSelector
    );
    if (hasStructure) {
      valid.push(card);
    } else {
      await card.dispose();
    }
  }
  return valid;
}

async function ensureCardExpanded(page, cardHandle) {
  const alreadyLoaded = await cardHandle.evaluate(
    (el, sel) => !!el.querySelector(sel),
    CONFIG.loadedDataSelector
  );
  if (alreadyLoaded) return true;

  const button = await cardHandle.$(CONFIG.expandButtonSelector);
  if (!button) return false; // no expandable section on this card — fine, continue gracefully

  try {
    await button.click();
  } catch (e) {
    return false;
  } finally {
    await button.dispose();
  }

  try {
    await page.waitForFunction(
      (el, sel) => !!el.querySelector(sel),
      { timeout: CONFIG.expandWaitTimeoutMs },
      cardHandle,
      CONFIG.loadedDataSelector
    );
    return true;
  } catch (e) {
    return false; // took too long / didn't load — extraction will just find what it can
  }
}

async function extractCompanyData(cardHandle, config) {
  return cardHandle.evaluate(
    (cardEl, cfg) => {
      function clean(t) {
        return (t || '').replace(/\s+/g, ' ').trim();
      }

      // --- Name ---
      const nameEl = cardEl.querySelector(cfg.nameSelector);
      const name = nameEl ? clean(nameEl.textContent) : '';

      // --- Website ---
      const websiteEl = cardEl.querySelector(cfg.websiteSelector);
      const website = websiteEl ? (websiteEl.getAttribute('href') || '').trim() : '';

      // --- Generic label/value param rows (best-effort; used for country,
      // and as a secondary source for email/phone alongside mailto:/tel:) ---
      const rows = Array.from(cardEl.querySelectorAll(cfg.paramRowSelector));
      const params = rows.map((row) => {
        let label = '';
        for (const sel of cfg.paramLabelSelectors) {
          const el = row.querySelector(sel);
          if (el && clean(el.textContent)) {
            label = clean(el.textContent).toLowerCase();
            break;
          }
        }
        let value = '';
        for (const sel of cfg.paramValueSelectors) {
          const el = row.querySelector(sel);
          if (el && clean(el.textContent)) {
            value = clean(el.textContent);
            break;
          }
        }
        if (!value) value = clean(row.textContent);
        return { label, value };
      });

      function valuesForLabel(pattern) {
        return params.filter((p) => pattern.test(p.label)).map((p) => p.value).filter(Boolean);
      }

      // --- Emails: mailto: links (primary, reliable) + labeled text rows ---
      const mailtoEmails = Array.from(cardEl.querySelectorAll('a[href^="mailto:"]'))
        .map((a) => (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim())
        .filter(Boolean);
      const labeledEmails = valuesForLabel(/e-?mail/i);
      const emails = Array.from(new Set([...mailtoEmails, ...labeledEmails].map((e) => e.trim()).filter(Boolean)));

      // --- Phones: tel: links (primary, reliable) + labeled text rows ---
      const telPhones = Array.from(cardEl.querySelectorAll('a[href^="tel:"]'))
        .map((a) => (a.getAttribute('href') || '').replace(/^tel:/i, '').trim())
        .filter(Boolean);
      const labeledPhones = valuesForLabel(/phone|tel(?:ephone)?|mobile|fax/i);
      const phones = Array.from(new Set([...telPhones, ...labeledPhones].map((p) => p.trim()).filter(Boolean)));

      // --- Country: labeled row only (no reliable link-based fallback) ---
      const countryMatches = valuesForLabel(/countr/i);
      const country = countryMatches[0] || '';

      return { name, website, emails, phones, country };
    },
    config
  );
}

// ------------------------------------------------------------------
// Pagination
// ------------------------------------------------------------------

function buildPageUrl(baseUrl, pageNum) {
  const url = new URL(baseUrl);
  url.searchParams.set('ShipownerSearch[page]', String(pageNum));
  return url.toString();
}

async function getPageFingerprint(page, cardSelector) {
  return page.evaluate((sel) => {
    const first = document.querySelector(sel);
    return first ? first.textContent.replace(/\s+/g, ' ').trim() : '';
  }, cardSelector);
}

// Scans the pagination bar for every numbered link currently visible and
// returns the highest page number seen. Sites with "sliding window"
// pagination reveal more numbers as you approach them, so this is called
// again after loading each page to keep extending our known max.
async function getHighestVisiblePageNumber(page, paginationSelector) {
  return page.evaluate((sel) => {
    const container = document.querySelector(sel);
    if (!container) return 1;
    const texts = Array.from(container.querySelectorAll('a, button, li, span'))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => /^\d+$/.test(t))
      .map(Number);
    return texts.length ? Math.max(...texts) : 1;
  }, paginationSelector);
}

// Try direct URL navigation first (fast, reliable if the site supports
// it); if the content doesn't actually change, fall back to clicking the
// matching numbered pagination link instead.
async function goToPage(page, config, pageNum, previousFingerprint) {
  const targetUrl = buildPageUrl(config.startUrl, pageNum);

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector(config.cardSelector, { timeout: config.cardWaitTimeoutMs });
  } catch (e) {
    // Direct nav didn't even produce cards — try the click-based approach below.
  }

  const fingerprintAfterNav = await getPageFingerprint(page, config.cardSelector);
  const navWorked = pageNum === 1 || (fingerprintAfterNav && fingerprintAfterNav !== previousFingerprint);
  if (navWorked) return { success: true, method: 'url' };

  // Fall back to clicking the pagination link for this page number.
  const clicked = await page.evaluate(
    (sel, targetPageNum) => {
      const container = document.querySelector(sel);
      if (!container) return false;
      const target = Array.from(container.querySelectorAll('a, button')).find(
        (el) => (el.textContent || '').trim() === String(targetPageNum)
      );
      if (!target) return false;
      target.click();
      return true;
    },
    config.paginationSelector,
    pageNum
  );

  if (!clicked) return { success: false };

  try {
    await page.waitForFunction(
      (sel, prevFingerprint) => {
        const first = document.querySelector(sel);
        if (!first) return false;
        const text = first.textContent.replace(/\s+/g, ' ').trim();
        return text && text !== prevFingerprint;
      },
      { timeout: config.pageChangeWaitTimeoutMs },
      config.cardSelector,
      previousFingerprint
    );
    return { success: true, method: 'click' };
  } catch (e) {
    return { success: false };
  }
}

// ------------------------------------------------------------------
// Per-page processing
// ------------------------------------------------------------------

async function processPage(page, pageNum, state) {
  const cards = await getValidCompanyCardHandles(page);
  console.log(`Page ${pageNum}`);
  console.log(`Found ${cards.length} company cards\n`);

  let savedThisPage = 0;

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    try {
      await ensureCardExpanded(page, card);
      await randomDelay(300, 700); // let expanded content settle

      const data = await extractCompanyData(card, CONFIG);
      const name = clean(data.name);

      if (!name) {
        console.log(`[${i + 1}/${cards.length}] (skipped — no name found)`);
        await card.dispose();
        continue;
      }

      const key = normalizeName(name);
      if (state.seenNames.has(key)) {
        state.duplicateCount += 1;
        console.log(`[${i + 1}/${cards.length}] ${name}\n  ↳ Skipped (duplicate)`);
      } else {
        state.seenNames.add(key);
        const record = {
          company: name,
          website: data.website || '',
          email: data.emails.join(' | '),
          phone: data.phones.join(' | '),
          country: data.country || '',
        };
        state.allResults.push(record);
        state.newlyScrapedThisRun.push(record);
        writeCsvAndJson(state.allResults); // live save after every company
        savedThisPage += 1;

        console.log(`[${i + 1}/${cards.length}] ${name}`);
        console.log(`Website: ${record.website || 'N/A'}`);
        console.log(`Emails: ${data.emails.length}`);
        console.log(`Phones: ${data.phones.length}`);
        console.log(`Country: ${record.country || 'N/A'}`);
        console.log('Saved\n');
      }
    } catch (err) {
      state.errorCount += 1;
      logError(`Page ${pageNum}, card ${i + 1}: ${err.message}`);
      console.log(`[${i + 1}/${cards.length}] ⚠ Error processing this company — logged, continuing.`);
    } finally {
      await card.dispose();
      await randomDelay(CONFIG.minDelayMs, CONFIG.maxDelayMs);
    }
  }

  console.log(`Page ${pageNum} completed.`);
  console.log(`Total unique companies: ${state.allResults.length}\n`);

  return savedThisPage;
}

async function processPageWithRetries(page, pageNum, state) {
  for (let attempt = 1; attempt <= CONFIG.maxPageRetries; attempt += 1) {
    try {
      return await processPage(page, pageNum, state);
    } catch (err) {
      logError(`Page ${pageNum} failed (attempt ${attempt}/${CONFIG.maxPageRetries}): ${err.message}`);
      console.log(`  ⚠ Page ${pageNum} failed (attempt ${attempt}/${CONFIG.maxPageRetries}): ${err.message}`);
      if (attempt < CONFIG.maxPageRetries) {
        await randomDelay(CONFIG.pageRetryDelayMs, CONFIG.pageRetryDelayMs + 1500);
      }
    }
  }
  console.log(`  ❌ Page ${pageNum} failed after ${CONFIG.maxPageRetries} attempts. Skipping this page.`);
  logError(`Page ${pageNum} skipped after ${CONFIG.maxPageRetries} failed attempts.`);
  return 0;
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

    const text = await res.text();
    let data;
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
// Main
// ------------------------------------------------------------------

async function main() {
  console.log('Starting Maritime Directory scraper...\n');

  const isFirstEverRun = !fs.existsSync(CONFIG.userDataDir);

  const browser = await puppeteer.launch({
    headless: false, // needs to be visible so manual login is possible whenever a session expires
    userDataDir: CONFIG.userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });

  try {
    await ensureAuthenticated(page, isFirstEverRun);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    await browser.close();
    process.exit(1);
  }

  // --- Resume support ---
  const existingResults = loadExistingResults();
  const progress = loadProgress();
  const state = {
    allResults: existingResults,
    seenNames: new Set(existingResults.map((r) => normalizeName(r.company))),
    duplicateCount: 0,
    errorCount: 0,
    newlyScrapedThisRun: [],
  };

  if (existingResults.length > 0) {
    console.log(
      `Resuming: found ${existingResults.length} previously-saved companies, ` +
        `last fully-completed page was ${progress.lastCompletedPage}.\n`
    );
  }

  const startPage = progress.lastCompletedPage + 1;
  let pageNum = startPage;
  let knownMaxPage = Math.max(pageNum, 1);
  let previousFingerprint = null;
  let pagesScraped = 0;

  while (true) {
    const result = await goToPage(page, CONFIG, pageNum, previousFingerprint);

    if (!result.success) {
      console.log(`\n🏁 Could not reach page ${pageNum} (no more pages, or pagination target not found). Stopping.\n`);
      break;
    }

    await randomDelay(CONFIG.minPageDelayMs, CONFIG.maxPageDelayMs);

    let cardCount = 0;
    try {
      cardCount = await page.$$eval(CONFIG.cardSelector, (els) => els.length);
    } catch (e) {
      cardCount = 0;
    }
    if (cardCount === 0) {
      console.log(`\n🏁 No company cards found on page ${pageNum}. Assuming this is past the last page. Stopping.\n`);
      break;
    }

    await processPageWithRetries(page, pageNum, state);
    pagesScraped += 1;

    saveProgress(pageNum);

    previousFingerprint = await getPageFingerprint(page, CONFIG.cardSelector);

    const visibleMax = await getHighestVisiblePageNumber(page, CONFIG.paginationSelector);
    knownMaxPage = Math.max(knownMaxPage, visibleMax);

    if (pageNum >= knownMaxPage) {
      console.log(`Moving to page ${pageNum + 1}... (checking if it exists)\n`);
    } else {
      console.log(`Moving to page ${pageNum + 1}...\n`);
    }

    pageNum += 1;
  }

  await browser.close();

  console.log('SCRAPE COMPLETE\n');
  console.log(`Pages scraped: ${pagesScraped}`);
  console.log(`Unique companies saved: ${state.allResults.length}`);
  console.log(`Duplicates skipped: ${state.duplicateCount}`);
  console.log(`Errors: ${state.errorCount}\n`);
  console.log(`CSV: ${CONFIG.csvPath}`);
  console.log(`JSON: ${CONFIG.jsonPath}\n`);

  // Send this run's newly-scraped rows to the Sheets webhook in one batch.
  await postRowsToWebhook(state.newlyScrapedThisRun);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  logError(`Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
