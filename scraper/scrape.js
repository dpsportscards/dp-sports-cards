// DP Sports Cards — Whatnot Show Scraper
// This version logs detailed debug info to help identify the correct title field.

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const WHATNOT_URL = 'https://www.whatnot.com/user/polakoff/shows';
const CHROME_PATH = process.env.CHROME_PATH;
if (!CHROME_PATH) { console.error('ERROR: CHROME_PATH not set.'); process.exit(1); }

function classifyType(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('monday') || t.includes('big show')) return 'big';
  if (t.includes('modern') || t.includes('value') || t.includes('prizm') || t.includes('chrome')) return 'modern';
  return 'popup';
}

function formatDateTime(raw) {
  if (!raw) return { date: '', time: '' };
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return { date: raw, time: '' };
    const date = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' });
    return { date, time };
  } catch { return { date: String(raw), time: '' }; }
}

// Tries every plausible title field name on a show object
function extractTitle(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const TITLE_KEYS = [
    'title','name','streamTitle','showTitle','displayTitle','headline',
    'broadcastTitle','eventTitle','showName','listingTitle','label',
    'subject','caption','header','productTitle','description'
  ];
  for (const k of TITLE_KEYS) {
    const v = obj[k];
    if (v && typeof v === 'string' && v.trim().length > 2 && v.trim().length < 200) {
      return v.trim();
    }
  }
  // Check one level of nesting (stream, show, event, details sub-objects)
  for (const sub of ['stream','show','event','details','listing','product']) {
    if (obj[sub] && typeof obj[sub] === 'object') {
      const nested = extractTitle(obj[sub]);
      if (nested) return nested;
    }
  }
  return '';
}

async function scrape() {
  console.log('=== DP Sports Cards Scraper ===');
  console.log('TZ:', process.env.TZ || 'not set');
  console.log('URL:', WHATNOT_URL);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let shows = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36');

    // Capture ALL JSON responses for analysis
    const apiResponses = [];
    page.on('response', async response => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      try {
        const json = await response.json();
        apiResponses.push({ url, json });
      } catch {}
    });

    console.log('\nLoading page...');
    await page.goto(WHATNOT_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Scroll down to trigger any lazy-loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 3000));

    // ── Strategy 1: Find show arrays in API responses ──────────────
    console.log(`\nAPI responses captured: ${apiResponses.length}`);

    for (const { url, json } of apiResponses) {
      // Recursively search the JSON for an array that looks like shows
      function findShowArrays(obj, depth = 0) {
        if (depth > 6 || !obj) return [];
        const found = [];
        if (Array.isArray(obj)) {
          // Does this array contain show-like objects?
          const hasTimeField = obj.length > 0 && obj[0] && (
            obj[0].startTime || obj[0].scheduledAt || obj[0].startsAt ||
            obj[0].start_time || obj[0].scheduledStartTime || obj[0].startedAt
          );
          if (hasTimeField) found.push(obj);
          for (const item of obj) found.push(...findShowArrays(item, depth + 1));
        } else if (typeof obj === 'object') {
          for (const val of Object.values(obj)) {
            found.push(...findShowArrays(val, depth + 1));
          }
        }
        return found;
      }

      const showArrays = findShowArrays(json);
      if (showArrays.length === 0) continue;

      // Pick the largest array that looks like shows
      const best = showArrays.sort((a, b) => b.length - a.length)[0];
      console.log(`\nFound ${best.length} shows via API: ${url.slice(0, 80)}`);

      // *** DIAGNOSTIC: log the complete first show object ***
      console.log('\n=== FIRST SHOW OBJECT (all fields) ===');
      console.log(JSON.stringify(best[0], null, 2).slice(0, 4000));
      console.log('=== TOP-LEVEL KEYS:', Object.keys(best[0]).join(', '));

      shows = best.map(s => {
        const startTime = s.startTime || s.scheduledAt || s.startsAt ||
                          s.start_time || s.scheduledStartTime || s.startedAt || '';
        const { date, time } = formatDateTime(startTime);
        const title = extractTitle(s);
        if (title) console.log('  Title found:', title);
        const showUrl = s.url || s.shareUrl || s.link ||
                        (s.id ? `https://www.whatnot.com/show/${s.id}` : WHATNOT_URL);
        return { title, date, time, type: classifyType(title), url: showUrl, _raw_start: startTime };
      });
      break; // Use first/best match
    }

    // ── Strategy 2: DOM scraping ──────────────────────────────────
    if (shows.length === 0) {
      console.log('\nNo API data found — trying DOM scraping...');

      // Log page title and first 2000 chars of body text for diagnostics
      const pageTitle = await page.title();
      console.log('Page title:', pageTitle);

      const domData = await page.evaluate(() => {
        // Log the first show card's complete HTML
        const card = document.querySelector('[class*="show" i][class*="card" i], [class*="ShowCard"], article, [data-testid*="show"]');
        if (card) console.log('First card HTML sample:', card.innerHTML.slice(0, 1000));

        const results = [];
        const links = [...document.querySelectorAll('a[href*="/show/"], a[href*="/stream/"]')];
        console.log('Show links found:', links.length);

        links.forEach(link => {
          const card = link.closest('[class]') || link.parentElement;
          // Get ALL text from the card
          const fullText = card?.innerText || link.innerText || '';
          // Get any aria-label or title attribute
          const ariaLabel = link.getAttribute('aria-label') || '';
          const titleAttr  = link.getAttribute('title') || '';
          // Try heading elements specifically
          const headingEl  = card?.querySelector('h1,h2,h3,h4,h5');
          const headingText = headingEl?.innerText?.trim() || '';
          // Time element
          const timeEl     = card?.querySelector('time');
          const timeStr    = timeEl?.getAttribute('datetime') || timeEl?.innerText?.trim() || '';

          results.push({
            url: link.href,
            fullText: fullText.slice(0, 300),
            ariaLabel, titleAttr, headingText, timeStr
          });
        });
        return results;
      });

      console.log(`DOM: found ${domData.length} show links`);
      domData.forEach((s, i) => {
        console.log(`\nShow ${i+1}:`);
        console.log('  URL:', s.url);
        console.log('  Full text:', s.fullText.replace(/\n/g, ' | '));
        console.log('  Aria-label:', s.ariaLabel);
        console.log('  Title attr:', s.titleAttr);
        console.log('  Heading:', s.headingText);
        console.log('  Time:', s.timeStr);
      });

      // Build shows from DOM data
      shows = domData.map(s => {
        const { date, time } = formatDateTime(s.timeStr);
        // Try to extract a real title (prefer headings, then aria-label, then first line of full text)
        let title = s.headingText || s.ariaLabel || s.titleAttr || '';
        // If no clean title, use first line of full text that isn't just a date/number
        if (!title) {
          const lines = s.fullText.split(/\n|\|/).map(l => l.trim()).filter(l =>
            l.length > 4 && !/^\d/.test(l) && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(l)
          );
          title = lines[0] || '';
        }
        return { title, date, time, type: classifyType(title), url: s.url };
      });
    }

    // ── Cleanup ───────────────────────────────────────────────────
    const seen = new Set();
    shows = shows
      .filter(s => s.url) // keep anything with a URL
      .filter(s => { if (seen.has(s.url)) return false; seen.add(s.url); return true; })
      .slice(0, 20);

  } finally {
    await browser.close();
  }

  const outPath = path.join(__dirname, '..', 'shows.json');
  fs.writeFileSync(outPath, JSON.stringify(shows, null, 2));

  console.log(`\n=== RESULT: saved ${shows.length} shows ===`);
  shows.forEach(s => console.log(`  [${s.type}] "${s.title}" | ${s.date} ${s.time} | ${s.url}`));

  if (shows.length === 0) {
    console.log('\nNO SHOWS FOUND. Please share this full log so the selectors can be fixed.');
  }
}

scrape().catch(err => {
  console.error('Scraper error:', err.message);
  console.error(err.stack);
  const outPath = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, '[]');
  process.exit(1);
});
