// DP Sports Cards — Whatnot Show Scraper
// Parses the rendered page body text, which contains all show data.
// The 19 API calls are analytics/tracking only — show data is in the DOM text.

const puppeteer = require('puppeteer-core');
const fs   = require('fs');
const path = require('path');

const WHATNOT_URL = 'https://www.whatnot.com/user/polakoff/shows';
const CHROME_PATH = process.env.CHROME_PATH;
if (!CHROME_PATH) { console.error('CHROME_PATH not set'); process.exit(1); }

const DAY_MAP = { mon:'Monday', tue:'Tuesday', wed:'Wednesday', thu:'Thursday', fri:'Friday', sat:'Saturday', sun:'Sunday' };

function classifyType(title, date) {
  const t = (title||'').toLowerCase();
  const d = (date||'').toLowerCase();
  if (d.includes('monday') || t.includes('big show')) return 'big';
  if (t.includes('modern') || t.includes('value') || t.includes('prizm') || t.includes('chrome')) return 'modern';
  return 'popup';
}

// Parse the body text. Confirmed format from live log:
//   polakoff
//   Mon, Jun 15, 5:00 PM   ← or just "Mon 5:00 PM" for nearest show
//   21                     ← some counter (ignore)
//   Vintage baseball beater beauties! ...  ← TITLE
//   Singles, $1 Starts, Vintage            ← tags (ignore)
//   polakoff
//   ...
function parseShows(bodyText, showLinks) {
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

  const startIdx = lines.findIndex(l => /Upcoming Shows/i.test(l));
  if (startIdx === -1) { console.log('Could not find "Upcoming Shows" in body text'); return []; }

  const endIdx = lines.findIndex((l, i) => i > startIdx && /^(Whatnot|© \d{4})/i.test(l));
  const relevant = lines.slice(startIdx + 1, endIdx === -1 ? undefined : endIdx);
  console.log(`Parsing ${relevant.length} lines between "Upcoming Shows" and page footer`);

  const shows = [];
  let i = 0;
  let showIndex = 0;

  while (i < relevant.length) {
    // Each show block starts with the seller handle
    if (relevant[i] !== 'polakoff') { i++; continue; }
    i++;

    // Date/time line: "Mon 5:00 PM" or "Mon, Jun 15, 5:00 PM"
    const dtLine = relevant[i] || '';
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(dtLine)) { i++; continue; }
    i++;

    // Skip the counter number (30, 21, 19, 11, 7…)
    if (/^\d+$/.test(relevant[i] || '')) i++;

    // Title is the next non-empty line
    const title = relevant[i] || '';
    if (!title) { i++; continue; }
    i++;

    // Skip tag lines (comma-separated category strings)
    while (i < relevant.length && relevant[i] !== 'polakoff' && relevant[i].includes(',')) i++;

    // ── Parse date & time ──────────────────────────────────────
    let date = '', time = '';

    // Full: "Mon, Jun 15, 5:00 PM"
    const full = dtLine.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]+\s+\d+),?\s+(\d+:\d+\s*[AP]M)/i);
    // Short: "Mon 5:00 PM"
    const short = dtLine.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d+:\d+\s*[AP]M)/i);

    if (full) {
      date = `${DAY_MAP[full[1].toLowerCase()]}, ${full[2]}`;
      time = `${full[3]} ET`;
    } else if (short) {
      date = DAY_MAP[short[1].toLowerCase()] || short[1];
      time = `${short[2]} ET`;
    } else {
      date = dtLine;
    }

    // URL: use matched show link if available, otherwise shows page
    const url = showLinks[showIndex] || WHATNOT_URL;
    showIndex++;

    shows.push({ title, date, time, type: classifyType(title, date), url });
    console.log(`  [${shows.length}] "${title}" | ${date} | ${time} | ${url}`);
  }

  return shows;
}

async function scrape() {
  console.log('=== DP Sports Cards — Show Scraper ===');
  console.log('TZ:', process.env.TZ);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1280,800']
  });

  let shows = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    console.log('Loading page…');
    await page.goto(WHATNOT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));

    const pageTitle = await page.title();
    console.log('Page title:', pageTitle);

    // Get all unique Whatnot links — look for show-specific URLs
    const showLinks = await page.evaluate((baseUrl) => {
      const allLinks = [...document.querySelectorAll('a[href]')]
        .map(a => a.href)
        .filter((h, i, arr) => arr.indexOf(h) === i); // unique

      console.log('All links:', allLinks.join('\n')); // for debugging

      // Filter to links that look like individual show pages (not nav/profile links)
      const navPaths = ['/user/', '/browse', '/login', '/signup', '/blog', '/careers',
                        '/about', '/faq', '/help', '/terms', '/privacy', '/affiliates',
                        '/order', '/shipping', '/returns', '/payment', '/contact'];
      return allLinks.filter(h => {
        if (!h.includes('whatnot.com')) return false;
        if (h === baseUrl) return false;
        try {
          const p = new URL(h).pathname;
          return !navPaths.some(n => p.startsWith(n));
        } catch { return false; }
      });
    }, WHATNOT_URL);

    console.log(`Show-like links found: ${showLinks.length}`);
    showLinks.forEach(l => console.log(' ', l));

    // Get the full rendered body text (this is where the show data lives)
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    console.log(`\nBody text length: ${bodyText.length}`);

    shows = parseShows(bodyText, showLinks);

  } finally {
    await browser.close();
  }

  // Deduplicate by title+date
  const seen = new Set();
  shows = shows.filter(s => {
    const key = `${s.title}|${s.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);

  const outPath = path.join(__dirname, '..', 'shows.json');
  fs.writeFileSync(outPath, JSON.stringify(shows, null, 2));

  console.log(`\n=== SAVED ${shows.length} shows ===`);
  if (shows.length === 0) console.log('WARNING: No shows saved. Share this log for diagnosis.');
}

scrape().catch(err => {
  console.error('Fatal:', err.message);
  const p = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
  process.exit(1);
});
