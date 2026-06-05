// DP Sports Cards — Whatnot Show Scraper

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
    const d = new Date(typeof raw === 'number' ? raw : raw);
    if (isNaN(d.getTime())) return { date: String(raw), time: '' };
    const date = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' });
    return { date, time };
  } catch { return { date: String(raw), time: '' }; }
}

// Recursively find any array of 2+ objects that share common keys
// (much broader than before — catches any show-like data regardless of field names)
function findAnyArrays(obj, depth = 0, path = '') {
  if (depth > 8 || !obj) return [];
  const found = [];
  if (Array.isArray(obj) && obj.length >= 2 && typeof obj[0] === 'object' && obj[0] !== null) {
    found.push({ path, arr: obj });
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      found.push(...findAnyArrays(v, depth + 1, path ? `${path}.${k}` : k));
    }
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => found.push(...findAnyArrays(item, depth + 1, `${path}[${i}]`)));
  }
  return found;
}

// Try every possible field name that might hold a timestamp or title
const TIME_KEYS = ['startTime','scheduledAt','startsAt','start_time','scheduledStartTime',
  'startedAt','liveAt','goLiveAt','scheduledStart','begins','beginsAt','date',
  'eventDate','streamDate','showDate','airedAt','plannedAt','launchAt','endsAt',
  'endTime','createdAt','updatedAt','publishedAt'];

const TITLE_KEYS = ['title','name','streamTitle','showTitle','displayTitle','headline',
  'broadcastTitle','eventTitle','showName','listingTitle','label','subject',
  'caption','header','productTitle','description','about','summary'];

function hasTimeField(obj) {
  return TIME_KEYS.some(k => obj[k] !== undefined && obj[k] !== null);
}

function extractTitle(obj) {
  for (const k of TITLE_KEYS) {
    const v = obj[k];
    if (v && typeof v === 'string' && v.trim().length > 2) return v.trim();
  }
  // Check one level of nesting
  for (const sub of ['stream','show','event','details','listing','product','seller','data']) {
    if (obj[sub] && typeof obj[sub] === 'object') {
      for (const k of TITLE_KEYS) {
        const v = obj[sub][k];
        if (v && typeof v === 'string' && v.trim().length > 2) return v.trim();
      }
    }
  }
  return '';
}

function extractTime(obj) {
  for (const k of TIME_KEYS) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  for (const sub of ['stream','show','event','details','listing']) {
    if (obj[sub] && typeof obj[sub] === 'object') {
      for (const k of TIME_KEYS) {
        if (obj[sub][k] !== undefined) return obj[sub][k];
      }
    }
  }
  return null;
}

async function scrape() {
  console.log('=== DP Sports Cards Scraper ===');
  console.log('TZ:', process.env.TZ, '| Chrome:', CHROME_PATH.slice(-30));

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled'  // ← prevents bot detection
    ]
  });

  let shows = [];

  try {
    const page = await browser.newPage();

    // Spoof a real browser — prevents Whatnot from serving a stripped page
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    });

    // Capture all JSON API responses
    const apiResponses = [];
    page.on('response', async response => {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      try {
        const json = await response.json();
        apiResponses.push({ url: response.url(), json });
      } catch {}
    });

    console.log('\nLoading page...');
    await page.goto(WHATNOT_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait extra time and scroll to trigger any lazy loading
    await new Promise(r => setTimeout(r, 5000));
    await page.evaluate(() => {
      window.scrollTo(0, 600);
      window.scrollTo(0, 1200);
      window.scrollTo(0, 1800);
    });
    await new Promise(r => setTimeout(r, 3000));

    const pageTitle = await page.title();
    console.log('Page title:', pageTitle);
    console.log('API responses captured:', apiResponses.length);

    // ── Log all API responses to find show data ──────────────────
    console.log('\n=== ALL API RESPONSES ===');
    for (const { url, json } of apiResponses) {
      const arrays = findAnyArrays(json);
      const shortUrl = url.replace('https://www.whatnot.com', '').slice(0, 80);
      if (arrays.length === 0) {
        console.log(`\n[NO ARRAYS] ${shortUrl}`);
        continue;
      }
      console.log(`\n[${arrays.length} arrays] ${shortUrl}`);
      for (const { path: p, arr } of arrays.slice(0, 5)) {
        const sample = arr[0];
        const keys = Object.keys(sample).slice(0, 15).join(', ');
        const hasTime = hasTimeField(sample);
        const hasTitle = TITLE_KEYS.some(k => sample[k]);
        console.log(`  .${p} → ${arr.length} items | keys: ${keys}`);
        console.log(`    hasTimeField: ${hasTime} | hasTitleField: ${hasTitle}`);
        if (hasTime || hasTitle) {
          console.log('  *** POSSIBLE SHOW DATA — full first item:');
          console.log(JSON.stringify(sample, null, 2).slice(0, 2000));
        }
      }
    }

    // ── Try to extract shows from API data ──────────────────────
    console.log('\n=== LOOKING FOR SHOWS IN API DATA ===');
    for (const { url, json } of apiResponses) {
      const arrays = findAnyArrays(json);
      for (const { path: p, arr } of arrays) {
        // Must have at least some items with time fields
        const showLike = arr.filter(item => item && typeof item === 'object' && hasTimeField(item));
        if (showLike.length >= 1) {
          console.log(`Found ${showLike.length} show-like items at .${p} in ${url.slice(-60)}`);
          shows = showLike.map(s => {
            const rawTime = extractTime(s);
            const { date, time } = formatDateTime(rawTime);
            const title = extractTitle(s);
            const id = s.id || s.showId || s.streamId || s.eventId || '';
            const showUrl = s.url || s.shareUrl || s.link ||
                            (id ? `https://www.whatnot.com/show/${id}` : WHATNOT_URL);
            console.log(`  → "${title || '(no title)'}" | ${date} ${time}`);
            return { title, date, time, type: classifyType(title), url: showUrl };
          });
          if (shows.length > 0) break;
        }
      }
      if (shows.length > 0) break;
    }

    // ── DOM fallback: log ALL page links ─────────────────────────
    console.log('\n=== DOM LINKS ON PAGE ===');
    const allLinks = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map(a => a.href)
        .filter((h, i, a) => a.indexOf(h) === i && h.startsWith('http'))
    );
    console.log(`Total links: ${allLinks.length}`);
    // Print all unique whatnot.com links
    allLinks.filter(l => l.includes('whatnot.com')).forEach(l => console.log(' ', l));

    // ── DOM fallback: grab any show links ────────────────────────
    if (shows.length === 0) {
      console.log('\n=== TRYING DOM EXTRACTION ===');
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
      console.log('Page body text:\n', bodyText);

      const domShows = await page.evaluate(() => {
        // Try broad link patterns
        const patterns = ['a[href*="/show"]','a[href*="/stream"]','a[href*="/live"]',
                          'a[href*="/auction"]','a[href*="/event"]','a[href*="/listing"]'];
        const links = [];
        for (const pat of patterns) {
          document.querySelectorAll(pat).forEach(a => {
            if (!links.some(l => l.url === a.href)) {
              const card = a.closest('[class]') || a.parentElement;
              links.push({
                url: a.href,
                text: (card?.innerText || a.innerText || '').slice(0, 300),
                ariaLabel: a.getAttribute('aria-label') || ''
              });
            }
          });
        }
        return links;
      });

      console.log(`DOM show links found: ${domShows.length}`);
      domShows.forEach(s => {
        console.log('  URL:', s.url);
        console.log('  Text:', s.text.replace(/\n/g, ' | ').slice(0, 150));
        console.log('  Aria:', s.ariaLabel);
      });

      shows = domShows.map(s => ({
        title: s.ariaLabel || s.text.split('\n')[0] || '',
        date: '', time: '',
        type: 'popup',
        url: s.url
      })).filter(s => s.url);
    }

  } finally {
    await browser.close();
  }

  // Deduplicate
  const seen = new Set();
  shows = shows.filter(s => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 20);

  const outPath = path.join(__dirname, '..', 'shows.json');
  fs.writeFileSync(outPath, JSON.stringify(shows, null, 2));

  console.log(`\n=== SAVED ${shows.length} shows ===`);
  shows.forEach(s => console.log(`  "${s.title}" | ${s.date} ${s.time} | ${s.url}`));
}

scrape().catch(err => {
  console.error('Fatal error:', err.message);
  const outPath = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, '[]');
  process.exit(1);
});
