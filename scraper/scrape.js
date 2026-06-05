// DP Sports Cards — Whatnot Show Scraper
// Uses the browser-based approach that previously found 5 shows successfully.
// Key fix: extended candidates list to handle GraphQL edges/node pattern,
// which is likely where show titles are stored.

const puppeteer = require('puppeteer-core');
const fs   = require('fs');
const path = require('path');

const WHATNOT_URL  = 'https://www.whatnot.com/user/polakoff/shows';
const CHROME_PATH  = process.env.CHROME_PATH;
if (!CHROME_PATH) { console.error('CHROME_PATH not set'); process.exit(1); }

function formatDateTime(raw) {
  if (!raw) return { date: '', time: '' };
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return { date: String(raw), time: '' };
    return {
      date: d.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', timeZone:'America/New_York' }),
      time: d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZoneName:'short', timeZone:'America/New_York' }),
    };
  } catch { return { date: String(raw), time: '' }; }
}

function classifyType(title) {
  const t = (title||'').toLowerCase();
  if (t.includes('monday') || t.includes('big show')) return 'big';
  if (t.includes('modern') || t.includes('value') || t.includes('prizm') || t.includes('chrome')) return 'modern';
  return 'popup';
}

// Pull a title from a show object — tries every known field name
function getTitle(s) {
  const fields = ['title','name','streamTitle','showTitle','displayTitle',
                  'headline','broadcastTitle','eventTitle','showName','label','subject'];
  for (const f of fields) {
    if (s[f] && typeof s[f] === 'string' && s[f].trim().length > 2) return s[f].trim();
  }
  return '';
}

// Pull a start time from a show object
function getStartTime(s) {
  const fields = ['startTime','scheduledAt','startsAt','start_time',
                  'scheduledStartTime','liveAt','goLiveAt','scheduledStart'];
  for (const f of fields) { if (s[f] != null) return s[f]; }
  return '';
}

// Helper: unwrap GraphQL edges → nodes
function edges(obj) {
  return Array.isArray(obj?.edges)
    ? obj.edges.map(e => e?.node).filter(Boolean)
    : null;
}

// Given a parsed JSON API response, return the best array of show objects found
function findShows(json) {
  const d = json?.data;
  const candidates = [
    // — direct arrays (non-GraphQL) ——————————————————
    d?.shows,
    d?.streams,
    d?.scheduledShows,
    d?.upcomingShows,
    d?.listings,
    d?.seller?.shows,
    d?.seller?.scheduledShows,
    d?.seller?.upcomingShows,
    d?.user?.shows,
    d?.user?.scheduledShows,
    d?.user?.upcomingShows,
    json?.shows,
    json?.streams,
    json?.scheduledShows,
    json?.upcomingShows,
    // — GraphQL edges/node pattern ————————————————————
    edges(d?.shows),
    edges(d?.streams),
    edges(d?.scheduledShows),
    edges(d?.upcomingShows),
    edges(d?.listings),
    edges(d?.seller?.shows),
    edges(d?.seller?.scheduledShows),
    edges(d?.seller?.upcomingShows),
    edges(d?.user?.shows),
    edges(d?.user?.scheduledShows),
    edges(d?.user?.upcomingShows),
  ];
  return candidates.find(v => Array.isArray(v) && v.length > 0) || null;
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

    // Capture every JSON API response Whatnot's React app makes
    const apiResponses = [];
    page.on('response', async response => {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      try { apiResponses.push({ url: response.url(), json: await response.json() }); } catch {}
    });

    console.log('Loading page…');
    await page.goto(WHATNOT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));  // let JS settle

    const pageTitle = await page.title();
    console.log('Page title:', pageTitle);
    console.log('API responses captured:', apiResponses.length);

    // ── Try every captured API response ──────────────────────────
    for (const { url, json } of apiResponses) {
      const found = findShows(json);
      if (!found) continue;

      console.log(`\n✓ Found ${found.length} shows in: ${url.slice(0,100)}`);

      // Log the complete first show so we can see ALL field names & values
      console.log('\n=== FIRST SHOW OBJECT ===');
      console.log(JSON.stringify(found[0], null, 2).slice(0, 3000));
      console.log('Keys:', Object.keys(found[0]).join(', '));

      shows = found.map(s => {
        const startTime = getStartTime(s);
        const { date, time } = formatDateTime(startTime);
        const title = getTitle(s);
        const id = s.id || s.showId || s.streamId || '';
        const showUrl = s.url || s.shareUrl || s.link ||
                        (id ? `https://www.whatnot.com/show/${id}` : WHATNOT_URL);
        console.log(`  → "${title || '(no title)'}" | ${date} ${time}`);
        return { title, date, time, type: classifyType(title), url: showUrl };
      }).filter(s => s.date || s.time || s.url !== WHATNOT_URL);

      if (shows.length > 0) break;
    }

    // ── If API came up empty, log all response URLs for diagnosis ─
    if (shows.length === 0) {
      console.log('\nNo shows found in API responses. All captured URLs:');
      apiResponses.forEach(({ url }) => console.log(' ', url.slice(0, 120)));

      // Also dump the page body text to see what rendered
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
      console.log('\nPage body text:\n', bodyText);
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
  shows.forEach(s => console.log(`  [${s.type}] "${s.title}" | ${s.date} | ${s.time}`));
}

scrape().catch(err => {
  console.error('Fatal:', err.message);
  const p = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
  process.exit(1);
});
