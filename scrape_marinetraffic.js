/**
 * MarineTraffic Company Directory Scraper (Puppeteer + stealth)
 * ------------------------------------------------
 * Rewritten from the original axios+cheerio version: MarineTraffic sits
 * behind bot detection, so plain HTTP requests get served a near-empty
 * stub page instead of real content. This version drives a real
 * (stealth-patched) browser instead, so JavaScript actually executes and
 * any bot-check has a chance to resolve the same way it would for a
 * normal visitor.
 *
 * All the parsing/dedup/save logic below is UNCHANGED from the original —
 * it still runs on the page's HTML via cheerio. The only thing that
 * changed is how that HTML gets fetched (page.goto + page.content()
 * instead of axios).
 *
 * IMPORTANT — read before running:
 *   - Runs in a VISIBLE browser window by default (headless: false in
 *     CONFIG below). On first launch it navigates to the directory and
 *     then PAUSES, asking you to press Enter in the terminal. If you see
 *     a "verify you're human" / Cloudflare-style challenge in that
 *     window, solve it manually, wait for the real directory page to
 *     appear, THEN press Enter. The session/cookies from that should
 *     carry through the rest of the run.
 *   - Runs sequentially (one profile page at a time, no concurrency) —
 *     deliberately conservative, since triggering more bot-detection
 *     scrutiny is a bigger risk here than on a site with no protection.
 *   - This is not guaranteed to get past every anti-bot measure —
 *     stealth patches common headless-browser tells, but stronger
 *     interactive challenges can still block it. Make sure this fits
 *     MarineTraffic's Terms of Service before relying on it.
 *   - If clicking into a company's profile keeps landing on a blank
 *     page even with the above (confirmed: manual clicks work fine,
 *     automated ones don't), see the CHROME_USER_DATA_DIR block in
 *     CONFIG below — pointing this at a copy of your real Chrome
 *     profile (real cookies/history) instead of a fresh one is worth
 *     trying, since that's a trust/fingerprint signal no amount of
 *     mouse-movement realism can fake.
 *
 * Install dependencies first:
 *   npm init -y
 *   npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer cheerio csv-writer
 *
 * Run (requires Node 18+):
 *   node scrape_marinetraffic.js
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;

puppeteer.use(StealthPlugin());

// ============================================================
// CONFIGURATION
// ============================================================

// All the industry/category directory pages to scrape — each gets its
// own full run (with its own pagination) before moving to the next.
const CATEGORY_URLS = [
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:21/industry:brokerage",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:36/industry:charterers",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:37/industry:chartering",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:6/industry:construction",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:43/industry:crewing%20services",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:44/industry:diving%20and%20underwater%20services",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:45/industry:dredging",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:92/industry:energy",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:52/industry:heavy%20lifting",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:87/industry:logistics%20%20%20transport%20%20%20freight",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:99/industry:manufacturing",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:56/industry:offshore%20services",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:14/industry:oil%20and%20gas",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:58/industry:pilots",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:91/industry:port%20%20%20terminal%20services",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:59/industry:port%20agents",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:62/industry:sale%20and%20purchase",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:63/industry:search%20and%20rescue",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:70/industry:ship%20builders%20%20%20engineering",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:82/industry:ship%20owners%20%20%20managers%20%20%20operators",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:68/industry:ship%20repairs",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:94/industry:ship%20services%20%20%20suppliers",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:81/industry:surveyors",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:74/industry:towage%20%20%20salvage",
  "https://www.marinetraffic.com/en/maritime-companies/directory/ind:75/industry:underwater%20cable%20operators",
];

// Kept for anything that still refers to a single starting URL (e.g. the
// very first pause-for-challenge navigation) — just the first category.
const BASE_URL = CATEGORY_URLS[0];

const OUTPUT_DIR = path.join(__dirname, "output");

const JSON_FILE = path.join(
  OUTPUT_DIR,
  "marinetraffic-companies.json"
);

const CSV_FILE = path.join(
  OUTPUT_DIR,
  "marinetraffic-companies.csv"
);

// Number of directory pages to scrape.
// Set to null if you want to continue until no companies are found.
const MAX_PAGES = null;

// Delay between requests.
// This is deliberately conservative and is NOT intended to bypass
// anti-bot controls.
const DELAY_MIN = 2000;
const DELAY_MAX = 4000;

// Navigation timeout — generous, since a bot-check challenge resolving
// itself can take longer than a normal page load.
const NAV_TIMEOUT_MS = 45000;

// Extra pause after a page looks "loaded", to let any client-side
// rendering or challenge-resolution JS finish before reading the HTML.
const PAGE_SETTLE_MS = 3000;

// Show the browser window (recommended — see notes above). Only switch
// this to 'new' (headless) once you've confirmed a headed run gets past
// any bot-check reliably.
const HEADLESS = false;

// ------------------------------------------------------------------
// REAL CHROME PROFILE (optional but recommended if bot-checks persist)
// ------------------------------------------------------------------
// Manual clicking works fine on this site; automated clicking (even with
// human-like mouse movement) consistently gets stuck on blank pages.
// That points at a trust/fingerprint difference rather than the click
// itself — a fresh, no-history automation profile looks inherently more
// suspicious than a real, long-used Chrome profile with real cookies,
// history, and extensions.
//
// To test that: point this at a COPY of your real Chrome profile (never
// the live one — Chrome won't let two processes share a profile anyway,
// and copying protects your actual browser from any risk).
//
// How to set this up (Windows):
//   1. Fully close Chrome first (all windows).
//   2. Copy your profile folder somewhere separate, e.g. in PowerShell:
//        Copy-Item -Recurse "$env:LOCALAPPDATA\Google\Chrome\User Data" `
//          "$env:LOCALAPPDATA\Google\ChromeAutomationProfile"
//      (this can take a minute — profiles can be large)
//   3. Set CHROME_USER_DATA_DIR below to that copy's path, e.g.:
//        "C:\\Users\\Gebruiker\\AppData\\Local\\Google\\ChromeAutomationProfile"
//   4. Optionally set CHROME_EXECUTABLE_PATH to your real Chrome.exe
//      (typically "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
//      so it launches actual Chrome rather than Puppeteer's bundled one.
//
// Leave both null to use a fresh, blank automation profile as before.
const CHROME_USER_DATA_DIR = null; // e.g. "C:\\Users\\Gebruiker\\AppData\\Local\\Google\\ChromeAutomationProfile"
const CHROME_PROFILE_DIRECTORY = "Default"; // which profile inside that folder — "Default", "Profile 1", etc.
const CHROME_EXECUTABLE_PATH = null; // e.g. "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"

// ------------------------------------------------------------------
// GOOGLE SHEETS WEBHOOK
// ------------------------------------------------------------------
// After a scrape run finishes, all results are POSTed in a single batch
// to this Apps Script web app.
const WEBHOOK_URL =
  "https://script.google.com/macros/s/AKfycbzM1GQMa84ITKgAqIE7_FKOvDgjZDXd95dFyrACcL62ChqhQxhvsHw33HsIHN2zfk_Ezg/exec";
const WEBHOOK_SECRET = "scrapemaster";

// Confirmed selector for one company card in the directory listing —
// shared between parseDirectoryPage (to extract data) and fetchPage
// (to know what to wait for before considering a listing page "loaded").
const CARD_SELECTOR = "div.panel-body.text-left > article";

// ============================================================
// UTILITIES
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return (
    DELAY_MIN +
    Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1))
  );
}

function ensureOutputDirectory() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function cleanText(value) {
  if (!value) return "";

  return value
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function normalizeEmail(email) {
  if (!email) return "";

  return email
    .trim()
    .toLowerCase()
    .replace(/^mailto:/i, "")
    .split("?")[0];
}

function normalizeWebsite(url) {
  if (!url) return "";

  url = url.trim();

  if (url.startsWith("//")) {
    return "https:" + url;
  }

  if (!/^https?:\/\//i.test(url)) {
    return "https://" + url;
  }

  return url;
}

function extractEmail(text) {
  if (!text) return "";

  const match = text.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  );

  return match ? normalizeEmail(match[0]) : "";
}

// ============================================================
// LOAD EXISTING DATA
// ============================================================

function loadExistingData() {
  ensureOutputDirectory();

  if (!fs.existsSync(JSON_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(JSON_FILE, "utf8");

    if (!raw.trim()) {
      return [];
    }

    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      console.warn("Existing JSON file is not an array. Starting fresh.");
      return [];
    }

    return data;
  } catch (error) {
    console.error(
      "Could not read existing JSON file:",
      error.message
    );

    return [];
  }
}

// ============================================================
// SAVE DATA
// ============================================================

function saveJson(data) {
  fs.writeFileSync(
    JSON_FILE,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function saveCsv(data) {
  const csvWriter = createCsvWriter({
    path: CSV_FILE,

    header: [
      {
        id: "name",
        title: "name",
      },
      {
        id: "website",
        title: "website",
      },
      {
        id: "email",
        title: "email",
      },
      {
        id: "phone",
        title: "phone",
      },
      {
        id: "country",
        title: "country",
      },
      {
        id: "category",
        title: "category",
      },
    ],
  });

  return csvWriter.writeRecords(data);
}

// ============================================================
// REQUEST PAGE (via a real browser tab, not a raw HTTP request)
// ============================================================

async function fetchPage(page, url, waitForSelector = null) {
  console.log(`\nRequesting: ${url}`);

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });

    // If the caller told us what to expect (e.g. the company cards),
    // wait for it explicitly rather than trusting a fixed timer — the
    // results list can be injected via AJAX well after networkidle2
    // fires, and a fixed few-second wait can easily be too short.
    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: 15000 });
      } catch (e) {
        console.log(`  ⚠ "${waitForSelector}" never appeared within 15s — continuing anyway with whatever loaded.`);
      }
    }

    // Extra settle time on top of the above — some challenge/render
    // scripts keep running a little after the selector first appears.
    await sleep(PAGE_SETTLE_MS);

    const html = await page.content();

    console.log(`Loaded page | ${html.length} characters`);

    return html;
  } catch (error) {
    console.error(`Request failed: ${error.message}`);
    return null;
  }
}

// Writes the current frame's (or page's) HTML + a full-viewport screenshot
// to output/debug-*, so when something isn't matching as expected there's
// something concrete to inspect instead of guessing blind from a log.
async function saveDebugSnapshot(page, frameOrNull, label) {
  try {
    ensureOutputDirectory();
    const htmlPath = path.join(OUTPUT_DIR, `debug-${label}.html`);
    const pngPath = path.join(OUTPUT_DIR, `debug-${label}.png`);
    const html = await (frameOrNull || page).content();
    fs.writeFileSync(htmlPath, html, "utf8");
    await page.screenshot({ path: pngPath, fullPage: true });
    console.log(`  🩺 Saved debug snapshot: ${htmlPath} / ${pngPath}`);
  } catch (e) {
    console.log(`  ⚠ Couldn't save debug snapshot (${e.message}).`);
  }
}

// CONFIRMED from a live debug dump: MarineTraffic's outer page (a
// React/MUI shell) embeds the ACTUAL directory — the classic Bootstrap
// markup with .panel-body/article cards this scraper targets — inside a
// nested <iframe id="forwardContainer" title="Forward Iframe">.
//
// A direct top-level navigation (to a listing URL OR a profile URL) was
// tried and did NOT work either way — the site serves the bare outer
// shell (no real content, ~1.17M characters every time) when a request
// doesn't look properly embedded. So instead of navigating away from the
// iframe, this resolves and returns the live Puppeteer Frame object
// itself — all further reads/navigation happen ON that frame, while it
// stays properly embedded in the outer page. Used for BOTH the listing
// and, separately, a second dedicated frame for profile pages.
async function resolveForwardFrame(page) {
  try {
    await page.waitForSelector("#forwardContainer", { timeout: 15000 });
  } catch (e) {
    console.log('  ⚠ No "#forwardContainer" iframe found — the site structure may have changed again.');
    return null;
  }

  const handle = await page.$("#forwardContainer");
  const frame = handle ? await handle.contentFrame() : null;
  if (!frame) {
    console.log("  ⚠ Found the iframe element but couldn't attach to its frame.");
  }

  // DIAGNOSTIC (once): if the iframe's `sandbox` attribute exists but
  // doesn't include allow-popups, the browser will silently create an
  // empty popup on window.open()/target="_blank" and refuse to ever
  // navigate it anywhere — which would look exactly like getting stuck
  // on permanent about:blank tabs.
  if (handle && !sandboxLogged) {
    sandboxLogged = true;
    try {
      const attrs = await handle.evaluate((el) => ({
        sandbox: el.getAttribute("sandbox"),
        allow: el.getAttribute("allow"),
        referrerpolicy: el.getAttribute("referrerpolicy"),
      }));
      console.log(`  🔎 #forwardContainer attributes: ${JSON.stringify(attrs)}`);
    } catch (e) {
      console.log(`  🔎 Couldn't read #forwardContainer attributes (${e.message}).`);
    }
  }

  return frame;
}
let sandboxLogged = false;

// Opens a listing page URL in a plain new tab — LISTING pages (unlike
// profile pages) always render their real content inside the same
// #forwardContainer iframe, even on pages after the very first one. An
// earlier version of this function waited for CARD_SELECTOR directly on
// the top-level tab and missed that entirely — it would time out on the
// bare outer shell every time, even though the shell itself loaded fine
// (this matched what you saw visually: the page "opening", just never
// actually finishing the part that matters).
async function fetchListingDirect(browser, url) {
  const tab = await browser.newPage();
  let html = null;
  try {
    await tab.setViewport({ width: 1366, height: 900 });
    console.log(`  🌐 Opening listing page directly: ${url}`);
    try {
      await tab.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    } catch (e) {
      console.log(`  ⚠ Navigation failed: ${e.message}`);
    }

    const frame = await resolveForwardFrame(tab);
    if (!frame) {
      console.log("  ⚠ No forwardContainer iframe found on this listing page.");
      html = await tab.content(); // fall back to whatever the shell has, for debugging
      await saveDebugSnapshot(tab, null, "listing-no-frame");
      return html;
    }

    // Bootstrap (very first ever page) gets a long manual pause before
    // anyone checks anything, which incidentally gives the site's own
    // backend fetch+render plenty of time. A fully-automated page like
    // this one moves much faster, so it may genuinely need longer than
    // the original 20s for that same fetch+render to finish — bumped up
    // rather than assuming it's actually empty.
    try {
      await frame.waitForSelector(CARD_SELECTOR, { timeout: 45000 });
    } catch (e) {
      console.log(`  ⚠ "${CARD_SELECTOR}" never appeared inside the iframe within 45s (current url: ${tab.url()}).`);
      // Capture BOTH the tab and the frame's actual content before this
      // tab gets closed below — a debug snapshot taken after closing
      // (from outside this function) would just show unrelated leftover
      // state from a different tab entirely.
      await saveDebugSnapshot(tab, frame, "listing-card-selector-timeout");
    }
    await sleep(PAGE_SETTLE_MS);
    html = await frame.content();
  } finally {
    await tab.close().catch(() => {});
  }
  return html;
}

// ============================================================
// PARSE DIRECTORY PAGE
// ============================================================

function parseDirectoryPage(html) {
  const $ = cheerio.load(html);

  const companies = [];
  const seenProfiles = new Set();

  /*
   * CONFIRMED from live markup:
   *   Each company card is an <article> directly inside
   *   div.panel-body.text-left (the directory results list).
   *   Within a card:
   *     - Name + profile link: header h2 a
   *     - Category (e.g. "Brokerage"): the first <a> inside
   *       .row.vertical-offset-20.font-110
   *     - Website + location live in ul.list-horizontal > li:
   *         a list item containing an <a> = the website link
   *         a list item with plain text = "City, COUNTRY"
   */

  $(CARD_SELECTOR).each((index, element) => {
    const article = $(element);

    const nameLink = article.find("header h2 a").first();
    const name = cleanText(nameLink.text());
    const href = nameLink.attr("href") || "";

    if (!href || !name) {
      return;
    }

    const absoluteUrl = new URL(
      href,
      "https://www.marinetraffic.com"
    ).href;

    if (seenProfiles.has(absoluteUrl)) {
      return;
    }

    seenProfiles.add(absoluteUrl);

    const category = cleanText(
      article.find(".row.vertical-offset-20.font-110 a").first().text()
    );

    let website = "";
    let country = "";

    article.find("ul.list-horizontal > li").each((i, liElement) => {
      const li = $(liElement);
      const linkInside = li.find("a").first();

      if (linkInside.attr("href")) {
        website = normalizeWebsite(linkInside.attr("href"));
      } else {
        const text = cleanText(li.text());
        if (text) {
          const parts = text.split(",");
          country = cleanText(parts[parts.length - 1]);
        }
      }
    });

    companies.push({
      name,
      profile_url: absoluteUrl,
      website,
      email: "",
      phone: "",
      country,
      category,
    });
  });

  return companies;
}

// ============================================================
// EXTRACT COMPANY INFORMATION FROM PROFILE
// ============================================================

// Only saves ONE debug snapshot for a failed profile scrape (not one per
// company) — enough to diagnose the issue without flooding the output
// folder if every profile page is failing the same way.
let debugProfileSnapshotSaved = false;

// IMPORTANT: earlier versions tried loading profile pages via a direct
// frame.goto(profileUrl) — first on the listing frame, then on a second
// dedicated frame — and BOTH returned the same bare outer shell every
// time (no real content). Pagination had the exact same symptom until
// we switched from navigating to the "next" URL to actually CLICKING
// the real arrow — the site's client-side router apparently only
// responds to genuine clicks, not direct frame navigation. The same
// turned out to be true here: profiles are opened by clicking the
// company's own link (header h2 a) within the LISTING frame itself,
// then returned from via the browser's own back-navigation — mirroring
// exactly how a real user would browse from the list to a detail page
// and back, rather than treating pages as independently loadable URLs.
async function scrapeCompanyProfileByClick(page, company) {
  if (!company.profile_url) {
    return company;
  }

  console.log(
    `   Profile: ${company.name}`
  );

  // Open the profile URL directly in a separate, plain new tab — instead
  // of clicking within the listing frame (which kept landing on blank
  // pages/detached frames no matter how it was attempted). This exact
  // direct-navigation approach was tried once before and returned the
  // bare outer shell every time — but that was with a fresh automation
  // profile; if CHROME_USER_DATA_DIR is set to a real Chrome profile,
  // this may behave differently now.
  const browser = page.browser();
  const profilePage = await browser.newPage();
  let html = null;

  try {
    await profilePage.setViewport({ width: 1366, height: 900 });
    console.log(`  🆕 Opening in a new tab: ${company.profile_url}`);
    try {
      await profilePage.goto(company.profile_url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    } catch (e) {
      console.log(`  ⚠ Navigation failed: ${e.message}`);
    }

    let usedIframe = false;
    let profileFrame = null;
    try {
      // Wait specifically for the "CONTACT INFO" section to contain a
      // table — a plain CSS wait for any mailto:/table on the page (the
      // old PROFILE_WAIT_SELECTOR) could resolve early on something else
      // entirely elsewhere on the page before the real contact box loads.
      await profilePage.waitForFunction(
        () => {
          const headers = Array.from(document.querySelectorAll("section header"));
          const contactHeader = headers.find((h) => /contact info/i.test(h.textContent || ""));
          if (!contactHeader) return false;
          const section = contactHeader.closest("section");
          return Boolean(section && section.querySelector("table"));
        },
        { timeout: 15000 }
      );
    } catch (e) {
      // Same class of bug we found on listing pages: this profile's
      // real content may be rendering inside the #forwardContainer
      // iframe rather than directly on the top-level page (apparently
      // inconsistent — some companies' profile pages do this, some
      // don't). Try that before giving up.
      console.log('  ⚠ "CONTACT INFO" not found directly on the page — checking for a forwardContainer iframe...');
      profileFrame = await resolveForwardFrame(profilePage);
      if (profileFrame) {
        try {
          await profileFrame.waitForFunction(
            () => {
              const headers = Array.from(document.querySelectorAll("section header"));
              const contactHeader = headers.find((h) => /contact info/i.test(h.textContent || ""));
              if (!contactHeader) return false;
              const section = contactHeader.closest("section");
              return Boolean(section && section.querySelector("table"));
            },
            { timeout: 20000 }
          );
          usedIframe = true;
        } catch (e2) {
          console.log(`  ⚠ "CONTACT INFO" section never appeared in the iframe either (current url: ${profilePage.url()}).`);
        }
      }
    }
    await sleep(PAGE_SETTLE_MS);
    html = usedIframe && profileFrame ? await profileFrame.content() : await profilePage.content();

    // Capture a debug snapshot if it looks empty of contact info —
    // otherwise we'd lose the chance to see what actually happened
    // there (e.g. a bot-check that never resolved).
    const looksEmpty = !html || (!html.includes("mailto:") && !/phone/i.test(html));
    if (looksEmpty && !debugProfileSnapshotSaved) {
      debugProfileSnapshotSaved = true;
      console.log("  🩺 New tab looks empty of contact info — saving a debug snapshot of it (won't repeat for later companies).");
      await saveDebugSnapshot(profilePage, null, "profile-new-tab-empty");
    }
  } finally {
    console.log(`  🔎 Tab final URL before closing: ${profilePage.url()}`);
    await profilePage.close().catch(() => {});
  }
  // The listing page/frame was never touched by any of this — no need
  // to go back to anything, just continue to the next company.

  if (!html) {
    return company;
  }

  const $ = cheerio.load(html);

  const bodyText = cleanText(
    $("body").text()
  );

  /*
   * CONFIRMED (twice now, with your exact selectors) from live markup:
   * website and country already came from the directory listing card.
   * The "CONTACT INFO" panel has two tables side by side — phone/fax/
   * email/website in one, company name/address in the other — each row
   * shaped like: <tr><td><strong>Phone:</strong></td><td>VALUE</td></tr>
   *
   * Searching the WHOLE page for any table/mailto link (as an earlier
   * version did) risked matching something else on the page first —
   * scoping strictly to the section whose header says "CONTACT INFO"
   * avoids that, while still not depending on the exact div-nesting
   * depth staying fixed (only that the header text does).
   */

  function findContactSection() {
    let target = null;
    $("section").each((i, el) => {
      if (target) return;
      const headerText = cleanText($(el).find("header").first().text());
      if (/contact info/i.test(headerText)) {
        target = $(el);
      }
    });
    return target;
  }

  const contactSection = findContactSection();
  const $scope = contactSection && contactSection.length ? contactSection : $("body");
  if (!contactSection || !contactSection.length) {
    console.log('  ⚠ No section with a "CONTACT INFO" header found on this page — searching the whole page as a fallback.');
  }

  function extractByLabel(labelPattern) {
    let result = "";
    $scope.find("table tr").each((i, tr) => {
      if (result) return;
      const cells = $(tr).find("td");
      const labelText = cleanText(cells.eq(0).text()).replace(/:$/, "");
      if (labelPattern.test(labelText)) {
        result = cleanText(cells.eq(1).text());
      }
    });
    return result;
  }

  // The site protects the email behind an inline <script> that decodes a
  // substitution cipher and overwrites a <span>'s innerHTML with the real
  // address (var a = shuffled alphabet, var c = ciphertext, decode by
  // mapping each cipher char's position in `a` to the same position in
  // `a`'s sorted form). That only runs on a normal full page load — when
  // profile content gets swapped in via a client-side route change
  // (which clicking through the site does), injected <script> tags don't
  // auto-execute, so the raw undecoded cipher is what ends up in the DOM.
  // Decoding it ourselves from the script's source text sidesteps that
  // entirely — it's deterministic and doesn't depend on any JS running.
  function decodeObfuscatedEmail() {
    let decoded = "";
    $scope.find("script").each((i, el) => {
      if (decoded) return;
      const scriptText = $(el).html() || "";
      if (!scriptText.includes("var a=") || !scriptText.includes("var c=")) return;
      const aMatch = scriptText.match(/var a=\\"([^\\]*)\\"/);
      const cMatch = scriptText.match(/var c=\\"([^\\]*)\\"/);
      if (!aMatch || !cMatch) return;
      const a = aMatch[1];
      const c = cMatch[1];
      const b = a.split("").sort().join("");
      let d = "";
      for (const ch of c) {
        const idx = a.indexOf(ch);
        if (idx === -1) {
          d = "";
          break;
        }
        d += b.charAt(idx);
      }
      if (d && extractEmail(d)) {
        decoded = normalizeEmail(d);
      }
    });
    return decoded;
  }

  // ----------------------------------------------------------
  // EMAIL
  // ----------------------------------------------------------

  if (!company.email) {
    company.email = decodeObfuscatedEmail();
  }

  if (!company.email) {
    const mailtoLink = $("table a[href^='mailto:']").first();
    const href = mailtoLink.attr("href") || "";
    const email = normalizeEmail(href);
    if (email) {
      company.email = email;
    }
  }

  if (!company.email) {
    const emailLabelText = extractByLabel(/^email$/i);
    company.email = extractEmail(emailLabelText) || normalizeEmail(emailLabelText);
  }

  if (!company.email) {
    company.email = extractEmail(bodyText);
  }

  // ----------------------------------------------------------
  // PHONE
  // ----------------------------------------------------------

  if (!company.phone) {
    company.phone = extractByLabel(/^phone$/i);
  }

  if (!company.phone) {
    const phoneMatch = bodyText.match(
      /(?:\+?\d[\d\s().-]{7,}\d)/
    );

    if (phoneMatch) {
      company.phone = cleanText(
        phoneMatch[0]
      );
    }
  }

  return company;
}

// ============================================================
// DEDUPLICATION
// ============================================================

function deduplicateByEmail(data) {
  const emailMap = new Map();

  const noEmail = [];

  for (const company of data) {
    const email = normalizeEmail(
      company.email
    );

    company.email = email;

    if (!email) {
      noEmail.push(company);
      continue;
    }

    if (!emailMap.has(email)) {
      emailMap.set(email, company);
    } else {
      const existing = emailMap.get(email);

      /*
       * Keep the most complete record.
       */

      emailMap.set(email, {
        ...existing,

        website:
          existing.website ||
          company.website,

        phone:
          existing.phone ||
          company.phone,

        country:
          existing.country ||
          company.country,

        category:
          existing.category ||
          company.category,

        profile_url:
          existing.profile_url ||
          company.profile_url,
      });
    }
  }

  return [
    ...emailMap.values(),
    ...noEmail,
  ];
}

// ============================================================
// MAIN SCRAPER
// ============================================================

// ============================================================
// SEND RESULTS TO GOOGLE SHEETS WEBHOOK
// ============================================================

// POSTs scraped row(s) to the webhook. Called with a single-item array
// right after each company is scraped, so the Sheet fills in live as the
// run progresses rather than waiting until the end. Apps Script /exec URLs respond with a redirect to actually
// deliver their output — a POST that auto-follows a 301/302 gets
// silently converted to a bodyless GET per the fetch spec, so this
// follows that redirect manually instead (the script's own logic has
// already run by the time that redirect comes back).
async function sendResultsToWebhook(rows) {
  if (!rows || rows.length === 0) {
    console.log("\nNo rows to send to the webhook (empty result set).");
    return;
  }

  const payload = JSON.stringify({
    secret: WEBHOOK_SECRET,
    rows: rows.map((c) => ({
      name: c.name || "",
      website: c.website || "",
      email: c.email || "",
      phone: c.phone || "",
      country: c.country || "",
      category: c.category || "",
    })),
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`\nSending ${rows.length} rows to the Google Sheets webhook (attempt ${attempt}/2)...`);
    try {
      let response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        redirect: "manual",
      });

      const location = response.headers.get("location");
      if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
        if (!location) {
          throw new Error(`Got a redirect (status ${response.status}) but no Location header to follow`);
        }
        response = await fetch(location, { method: "GET" });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error(`Response wasn't valid JSON: ${text.slice(0, 200)}`);
      }

      if (json.status === "ok") {
        console.log(`✅ Webhook accepted the data. Rows appended: ${json.rowsAppended}`);
        return;
      }

      throw new Error(`Webhook returned an error status: ${JSON.stringify(json).slice(0, 300)}`);
    } catch (err) {
      console.error(`❌ Webhook send failed (attempt ${attempt}/2): ${err.message}`);
      if (attempt < 2) {
        console.log("   Retrying in 5 seconds...");
        await sleep(5000);
      } else {
        console.error(
          "❌ Giving up after 2 attempts. The scraped data is still safely saved locally " +
            `(${JSON_FILE} / ${CSV_FILE}), so nothing is lost — just not in the Sheet yet.`
        );
      }
    }
  }
}

// Scrapes ONE category's full directory (with its own internal
// pagination loop) — this is exactly the original single-category logic,
// just extracted so main() can call it once per category. Returns the
// updated `companies` array (dedupe/reassignment happens inside, same as
// before — just needs to be returned since reassigning a local `let`
// doesn't propagate back to the caller on its own).
async function scrapeCategory(browser, page, categoryUrl, companies, existingProfiles, existingEmails, isFirstEverPage) {
  console.log(`\n=================================`);
  console.log(`CATEGORY: ${categoryUrl}`);
  console.log(`=================================`);

  let currentHtml;

  if (isFirstEverPage) {
    // Only the VERY FIRST listing page load of the whole run needs the
    // embedded-frame bootstrap (+ manual pause) — that's what gets past
    // the initial bot-check and establishes valid session cookies.
    console.log(`\nOpening ${categoryUrl} ...`);
    await fetchPage(page, categoryUrl, "#forwardContainer");
    if (!HEADLESS) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await rl.question(
        "\n👉 Check the browser window — if you see a bot-check / \"verify you're human\" challenge, " +
          "solve it now. If the real company directory is already visible (no challenge shown), that's " +
          "fine too — just press Enter here to start scraping..."
      );
      rl.close();
    }

    const frame = await resolveForwardFrame(page);
    if (!frame) {
      console.error(
        "\n❌ Couldn't find/attach to the directory iframe for the very first page. Saving a debug snapshot and stopping."
      );
      await saveDebugSnapshot(page, null, "no-frame-found");
      return companies;
    }
    try {
      await frame.waitForSelector(CARD_SELECTOR, { timeout: 20000 });
    } catch (e) {
      console.log(`  ⚠ "${CARD_SELECTOR}" never appeared inside the listing iframe within 20s — continuing anyway.`);
    }
    await sleep(PAGE_SETTLE_MS);
    currentHtml = await frame.content();
  } else {
    // Every other listing page — CONFIRMED (from profile pages working
    // this way already) that plain direct navigation in a separate tab
    // works fine once the initial session/cookies exist.
    currentHtml = await fetchListingDirect(browser, categoryUrl);
  }

  let pageNum = 1;

  while (true) {
    if (
      MAX_PAGES !== null &&
      pageNum > MAX_PAGES
    ) {
      console.log(
        "\nMaximum page limit reached."
      );

      break;
    }

    if (!currentHtml) {
      console.log(
        `Stopping because page ${pageNum} could not be retrieved.`
      );

      break;
    }

    const pageCompanies =
      parseDirectoryPage(currentHtml);

    console.log(
      `Found ${pageCompanies.length} possible companies on page ${pageNum}.`
    );

    if (pageCompanies.length === 0) {
      console.log(
        "No companies found on this page."
      );
      await saveDebugSnapshot(page, null, `page-${pageNum}-zero-results`);
      console.log(
        "Assuming this category's directory has ended. If this is page 1 and you " +
          "expected results, check the debug HTML/screenshot just saved " +
          "in the output folder — the results list may not have finished " +
          "loading, or the page structure may have changed."
      );

      break;
    }

    let newCompanies = 0;

    for (const company of pageCompanies) {
      /*
       * Skip profile URLs already processed.
       */

      if (
        company.profile_url &&
        existingProfiles.has(company.profile_url)
      ) {
        console.log(
          `Skipping existing: ${company.name}`
        );

        continue;
      }

      /*
       * Add profile URL immediately so duplicates on later
       * pages aren't processed.
       */

      if (company.profile_url) {
        existingProfiles.add(
          company.profile_url
        );
      }

      /*
       * Scrape profile information — opens the profile URL directly in
       * a separate new tab (see scrapeCompanyProfileByClick).
       */

      const fullCompany =
        await scrapeCompanyProfileByClick(page, company);

      /*
       * Email-based deduplication.
       */

      if (
        fullCompany.email &&
        existingEmails.has(
          fullCompany.email
        )
      ) {
        console.log(
          `Duplicate email — skipping: ${fullCompany.email}`
        );

        continue;
      }

      if (fullCompany.email) {
        existingEmails.add(
          fullCompany.email
        );
      }

      companies.push(fullCompany);

      newCompanies++;

      /*
       * SAVE IMMEDIATELY
       */

      companies = deduplicateByEmail(
        companies
      );

      saveJson(companies);
      await saveCsv(companies);

      console.log(
        `Saved: ${fullCompany.name}`
      );

      console.log(
        `Total records: ${companies.length}`
      );

      // Send this ONE new record to the webhook right away, rather than
      // waiting for the whole run to finish.
      await sendResultsToWebhook([fullCompany]);

      await sleep(randomDelay());
    }

    console.log(
      `Page ${pageNum} complete. Added ${newCompanies} new companies.`
    );

    /*
     * Save again after every page.
     */

    companies = deduplicateByEmail(
      companies
    );

    saveJson(companies);
    await saveCsv(companies);

    pageNum++;

    await sleep(randomDelay());

    // Direct URL pagination — CONFIRMED (you checked manually) that the
    // URL really does change to .../page:2, .../page:3, etc. This
    // replaces the old click-based approach entirely: fetch that URL
    // directly in a plain new tab, same as every other listing page now.
    // If it comes back with zero companies, the loop's own check at the
    // top handles stopping — no separate "does next exist" check needed.
    const nextPageUrl = `${categoryUrl}/page:${pageNum}`;
    currentHtml = await fetchListingDirect(browser, nextPageUrl);
  }

  return companies;
}

async function main() {
  ensureOutputDirectory();

  let companies = loadExistingData();

  console.log(
    `Loaded ${companies.length} existing records.`
  );

  /*
   * Build lookup sets so we don't scrape the same company again.
   */

  const existingProfiles = new Set(
    companies
      .map((company) => company.profile_url)
      .filter(Boolean)
  );

  const existingEmails = new Set(
    companies
      .map((company) =>
        normalizeEmail(company.email)
      )
      .filter(Boolean)
  );

  console.log(`\nLaunching browser (headless: ${HEADLESS})...`);
  const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"];
  const launchOptions = {
    headless: HEADLESS,
    args: launchArgs,
    protocolTimeout: 120000, // default (30s) was too short and crashed the whole run mid-scrape
  };
  if (CHROME_USER_DATA_DIR) {
    console.log(`  Using Chrome profile: ${CHROME_USER_DATA_DIR} (${CHROME_PROFILE_DIRECTORY})`);
    launchOptions.userDataDir = CHROME_USER_DATA_DIR;
    launchArgs.push(`--profile-directory=${CHROME_PROFILE_DIRECTORY}`);
  }
  if (CHROME_EXECUTABLE_PATH) {
    console.log(`  Using real Chrome executable: ${CHROME_EXECUTABLE_PATH}`);
    launchOptions.executablePath = CHROME_EXECUTABLE_PATH;
  }
  const browser = await puppeteer.launch(launchOptions);
  browserRef = browser; // so the SIGINT handler can close it too

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });

  console.log(`\nWill scrape ${CATEGORY_URLS.length} categories in sequence.`);

  for (let i = 0; i < CATEGORY_URLS.length; i++) {
    const categoryUrl = CATEGORY_URLS[i];
    // Only the very first page of the whole run needs the embedded-frame
    // bootstrap (+ manual pause) — everything after that, including
    // every other category's own page 1, uses plain direct navigation.
    const isFirstEverPage = i === 0;
    companies = await scrapeCategory(browser, page, categoryUrl, companies, existingProfiles, existingEmails, isFirstEverPage);
  }

  /*
   * Final cleanup
   */

  companies = deduplicateByEmail(
    companies
  );

  saveJson(companies);
  await saveCsv(companies);

  await browser.close();
  browserRef = null;

  console.log("\n=================================");
  console.log("SCRAPE COMPLETE");
  console.log("=================================");
  console.log(
    `Total companies: ${companies.length}`
  );
  console.log(
    `JSON: ${JSON_FILE}`
  );
  console.log(
    `CSV:  ${CSV_FILE}`
  );
}

// ============================================================
// ERROR HANDLING
// ============================================================

// Tracked so SIGINT can close the browser cleanly instead of leaving an
// orphaned Chrome process running.
let browserRef = null;

process.on(
  "SIGINT",
  async () => {
    console.log(
      "\n\nScraper interrupted."
    );

    console.log(
      "Existing progress has already been saved."
    );

    if (browserRef) {
      try {
        await browserRef.close();
      } catch (e) {
        // ignore — browser may already be closed/closing
      }
    }

    process.exit(0);
  }
);

main().catch((error) => {
  console.error(
    "\nFatal error:",
    error
  );

  process.exit(1);
});
