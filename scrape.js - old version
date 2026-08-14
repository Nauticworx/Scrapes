/**
 * Ruzave Chartering & Broking Directory Scraper
 * ------------------------------------------------
 * For each company card on https://ruzave.com/chartering-broking, this
 * script reads the card's name, opens that company's detail link in a
 * separate background browser tab, scrapes website/email/phone/country
 * from it using ICON TYPE (not class names — this site's classes are
 * auto-generated Tailwind utility classes and aren't stable identifiers),
 * closes that tab, and moves to the next card. The main tab (and its
 * pagination state) is never disturbed. Then it paginates and repeats.
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
 * Install dependencies first:
 *   npm init -y
 *   npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer csv-writer
 *
 * Run:
 *   node scrape.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createObjectCsvWriter } = require('csv-writer');

puppeteer.use(StealthPlugin());

// ------------------------------------------------------------------
// CONFIG — adjust these if the script isn't picking up data correctly
// ------------------------------------------------------------------
const CONFIG = {
  startUrl: 'https://ruzave.com/chartering-broking',
  outputFile: 'ruzave-companies.csv',

  // Delay between opening each company's detail tab (ms) — randomized to
  // look more human and reduce chances of being rate-limited / blocked.
  minDelayMs: 1200,
  maxDelayMs: 2800,

  // Longer delay specifically between paginating to a new list page.
  minPageDelayMs: 2500,
  maxPageDelayMs: 5000,

  // How long to wait for cards / detail content to appear before giving up.
  cardWaitTimeoutMs: 15000,
  detailWaitTimeoutMs: 10000,

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

// Scrape one company's detail info. Prefers opening the link in a fresh
// background tab (doesn't disturb the list page / pagination at all). If
// there's no usable href, falls back to clicking the link in place and
// reading the resulting modal from the same tab.
async function scrapeCompanyDetail(browser, page, cardIndex, href, config) {
  const isRealLink =
    href && href.trim() && href.trim() !== '#' && !href.trim().toLowerCase().startsWith('javascript:');

  if (isRealLink) {
    const absoluteUrl = new URL(href, page.url()).toString();
    const detailPage = await browser.newPage();
    try {
      await detailPage.goto(absoluteUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await waitForDetailContent(detailPage, config.fieldIconSelectors, config.detailWaitTimeoutMs);
      await randomDelay(300, 700); // let content settle
      const data = await scrapeDetailFields(detailPage, config.fieldIconSelectors);
      return data;
    } catch (e) {
      console.log(`    ⚠ Couldn't load detail page directly (${e.message}). Will try in-page click instead.`);
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
    await randomDelay(300, 700);
    const data = await scrapeDetailFields(page, config.fieldIconSelectors);

    // Close whatever opened (Radix Dialog-style modals close on Escape).
    await page.keyboard.press('Escape');
    await randomDelay(300, 500);

    return data;
  } catch (e) {
    console.log(`    ⚠ In-page click fallback also failed: ${e.message}`);
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
  console.log('🚀 Launching browser...');
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
  let pageNum = 1;

  console.log(`🌐 Navigating to ${CONFIG.startUrl}`);
  await page.goto(CONFIG.startUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  while (true) {
    console.log(`\n📄 Scraping page ${pageNum}...`);

    try {
      await page.waitForSelector(CONFIG.cardSelector, { timeout: CONFIG.cardWaitTimeoutMs });
    } catch (e) {
      console.log(`  ⚠ No cards found on page ${pageNum} (selector matched nothing). Stopping.`);
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

    for (const { index, name, href, category } of cardSummaries) {
      const label = name || `card #${index + 1}`;
      console.log(`  → (${index + 1}/${cardSummaries.length}) ${label}`);

      const detailData = await scrapeCompanyDetail(browser, page, index, href, CONFIG);

      allResults.push({
        name,
        website: detailData?.website || '',
        email: detailData?.email || '',
        phone: detailData?.phone || '',
        country: detailData?.country || '',
        category: category || '',
      });

      await randomDelay(CONFIG.minDelayMs, CONFIG.maxDelayMs);
    }

    console.log(`  ✓ Finished page ${pageNum} (${allResults.length} total so far)`);

    // Fingerprint the current first card's full content so we can tell
    // when the click actually swapped in new companies (this SPA doesn't
    // change the URL, so we can't detect it any other way).
    const previousFingerprint = await getFirstCardFingerprint(page, CONFIG.cardSelector);

    await randomDelay(CONFIG.minPageDelayMs, CONFIG.maxPageDelayMs);

    const clicked = await clickNextButton(page, CONFIG.nextButtonSelector);
    if (!clicked) {
      console.log('\n🏁 No "Next" button found (or it looks disabled). Finishing up.');
      break;
    }

    const changed = await waitForCardsToChange(
      page,
      CONFIG.cardSelector,
      previousFingerprint,
      CONFIG.detailWaitTimeoutMs
    );

    if (!changed) {
      console.log('\n🏁 Clicking "Next" didn\'t change the cards — must be the last page. Finishing up.');
      break;
    }

    pageNum += 1;
    await randomDelay(CONFIG.minDelayMs, CONFIG.maxDelayMs); // let content fully settle
  }

  await browser.close();

  console.log(`\n💾 Writing ${allResults.length} total records to ${CONFIG.outputFile}...`);
  await writeCsvWithRetry(allResults, CONFIG.outputFile);
}

// Windows sometimes locks the CSV file briefly (antivirus scan, Explorer
// preview pane, OneDrive sync, or the file simply being open in Excel).
// Retry a few times with a short pause, then fall back to a timestamped
// filename so the scraped data is never lost even if the original file
// stays locked.
async function writeCsvWithRetry(records, preferredPath, maxAttempts = 4) {
  const header = [
    { id: 'name', title: 'company' },
    { id: 'website', title: 'website' },
    { id: 'email', title: 'email' },
    { id: 'phone', title: 'phone' },
    { id: 'country', title: 'country' },
    { id: 'category', title: 'category' },
  ];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const csvWriter = createObjectCsvWriter({ path: preferredPath, header });
      await csvWriter.writeRecords(records);
      console.log(`✅ Done! Saved ${records.length} companies to ${preferredPath}`);
      return;
    } catch (err) {
      const isLockError = err.code === 'EBUSY' || err.code === 'EPERM';
      if (isLockError && attempt < maxAttempts) {
        console.log(
          `  ⚠ ${preferredPath} is locked by another program (attempt ${attempt}/${maxAttempts}). ` +
            `Close it if it's open in Excel — retrying in 3s...`
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
      // Out of retries (or a non-lock error) — fall back to a filename
      // that can't collide, so the scraped data is never lost.
      const fallbackPath = preferredPath.replace(
        /\.csv$/i,
        `-${Date.now()}.csv`
      );
      console.log(`  ⚠ Still couldn't write ${preferredPath} (${err.message}).`);
      console.log(`  Trying a fresh filename instead: ${fallbackPath}`);
      try {
        const csvWriter = createObjectCsvWriter({ path: fallbackPath, header });
        await csvWriter.writeRecords(records);
        console.log(`✅ Done! Saved ${records.length} companies to ${fallbackPath}`);
      } catch (fallbackErr) {
        console.error(`❌ Could not save the CSV at all: ${fallbackErr.message}`);
        console.error('Your scraped data is still in memory but could not be written to disk.');
      }
      return;
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
 * Tip: test any selector live in the DevTools Console with
 *    document.querySelectorAll('your-selector-here').length
 * ------------------------------------------------------------------
 */
