// DP Sports Cards — Whatnot Show Scraper

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const WHATNOT_URL = 'https://www.whatnot.com/user/polakoff/shows';
const CHROME_PATH = process.env.CHROME_PATH;
if (!CHROME_PATH) { console.error('ERROR: CHROME_PATH not set.'); process.exit(1); }

// ── Title generation ──────────────────────────────────────
// Whatnot often doesn't store custom titles for recurring shows.
// We generate a meaningful title from the day of week instead.
function titleFromDay(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return 'Vintage Baseball Cards — Live Show';
  const day = dateObj.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  if (day === 'Monday')   return 'Monday Vintage Baseball Show';
  if (day === 'Tuesday')  return 'Tuesday Vintage Show';
  if (day === 'Wednesday') return 'Vintage Baseball Cards — Live Show';
  if (day === 'Thursday') return 'Vintage Baseball Cards — Live Show';
  if (day === 'Friday')   return 'Friday Vintage Show';
  return 'Weekend Vintage Show';
}

// Returns true if a string looks like a time/date rather than a real show title
function looksLikeDateString(str) {
  if (!str) return true;
  return /\d:\d\d\s*(AM|PM)/i.test(str) ||
         /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(str) ||
         /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(str);
}

function classifyType(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('monday') || t.includes('big show') || t.includes('flagship')) return 'big';
  if (t.includes('modern') || t.includes('value') || t.includes('prizm') || t.includes('chrome')) return 'modern';
  return 'popup';
}

function formatDateTime(raw) {
  if (!raw) return { date: '', time: '', dateObj: null };
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return { date: '', time: '', dateObj: null };
    const date = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York'
    });
    const time = d.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York'
    });
    return { date, time, dateObj: d };
  } catch {
    return { date: '', time: '', dateObj: null };
  }
}

async function scrape() {
  console.log('Starting Whatnot scraper (TZ:', process.env.TZ || 'not set', ')');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let shows = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36');

    // Intercept API responses to get raw timestamps and any available title data
    const apiResponses = [];
    page.on('response', async response => {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      if (url.includes('show') || url.includes('stream') || url.includes('schedule') ||
          url.includes('upcoming') || url.includes('event') || url.includes('graphql')) {
        try {
          const json = await response.json();
          apiResponses.push({ url, json });
        } catch {}
      }
    });

    console.log('Loading Whatnot page...');
    await page.goto(WHATNOT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));

    // ── Strategy 1: API interception ────────────────────────
    for (const { url, json } of apiResponses) {
      const candidates = [
        json?.data?.shows, json?.shows,
        json?.data?.streams, json?.streams,
        json?.data?.scheduledShows, json?.scheduledShows,
        json?.data?.upcomingShows, json?.upcomingShows,
        json?.data?.seller?.shows, json?.data?.user?.shows,
        json?.data?.seller?.upcomingShows, json?.data?.user?.upcomingShows,
      ].find(v => Array.isArray(v) && v.length > 0);

      if (candidates) {
        console.log(`API hit: ${candidates.length} shows from ${url}`);
        // Log the first item so we can see the data shape
        console.log('Sample show data:', JSON.stringify(candidates[0], null, 2).slice(0, 500));

        shows = candidates.map(s => {
          const startTime = s.startTime || s.scheduledAt || s.startsAt || s.start_time || s.scheduledStartTime || '';
          const { date, time, dateObj } = formatDateTime(startTime);

          // Try every possible title field name
          let title = s.title || s.name || s.streamTitle || s.showTitle ||
                      s.description || s.eventTitle || s.displayTitle || '';

          // If title looks like a date/time string or is empty, generate from day
          if (!title || looksLikeDateString(title)) {
            title = titleFromDay(dateObj);
          }

          const showUrl = s.url || s.shareUrl || s.link ||
                         (s.id ? `https://www.whatnot.com/show/${s.id}` : WHATNOT_URL);

          return { title, date, time, type: classifyType(title), url: showUrl };
        }).filter(s => s.date || s.time); // keep if we have at least a time
        break;
      }
    }

    // ── Strategy 2: __NEXT_DATA__ ───────────────────────────
    if (shows.length === 0) {
      console.log('Trying __NEXT_DATA__...');
      const nextData = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        try { return JSON.parse(el.textContent); } catch { return null; }
      });
      if (nextData) {
        function findShowArray(obj) {
          if (Array.isArray(obj) && obj.length > 0 &&
              (obj[0].startTime || obj[0].scheduledAt || obj[0].startsAt)) return obj;
          if (Array.isArray(obj)) { for (const i of obj) { const r = findShowArray(i); if (r) return r; } }
          if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) { const r = findShowArray(v); if (r) return r; } }
          return null;
        }
        const found = findShowArray(nextData);
        if (found) {
          shows = found.map(s => {
            const startTime = s.startTime || s.scheduledAt || s.startsAt || '';
            const { date, time, dateObj } = formatDateTime(startTime);
            let title = s.title || s.name || s.streamTitle || s.showTitle || '';
            if (!title || looksLikeDateString(title)) title = titleFromDay(dateObj);
            const showUrl = s.url || s.shareUrl || (s.id ? `https://www.whatnot.com/show/${s.id}` : WHATNOT_URL);
            return { title, date, time, type: classifyType(title), url: showUrl };
          });
        }
      }
    }

    // ── Strategy 3: DOM scraping ────────────────────────────
    if (shows.length === 0) {
      console.log('Trying DOM scraping...');
      const domShows = await page.evaluate((fallback) => {
        const results = [];
        // Look for show links
        const showLinks = [...document.querySelectorAll('a[href*="/show/"], a[href*="/stream/"]')];
        showLinks.forEach(link => {
          if (results.some(r => r.url === link.href)) return;
          const card = link.closest('article, li, [class*="Card"], [class*="card"]') || link.parentElement;
          // Get all text nodes - look for title vs. date
          const allText = card?.querySelectorAll('h1,h2,h3,h4,p,span,[class*="title"],[class*="Title"],[class*="name"]');
          const timeEl  = card?.querySelector('time,[class*="time"],[class*="Time"],[class*="date"],[class*="Date"]');
          let titleText = '';
          allText?.forEach(el => {
            const t = el.textContent.trim();
            if (t.length > 3 && t.length < 100 && !/\d:\d\d/.test(t) && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(t)) {
              if (!titleText) titleText = t;
            }
          });
          const timeStr = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';
          results.push({
            rawTitle: titleText,
            dateRaw: timeStr,
            url: link.href || fallback
          });
        });
        return results;
      }, WHATNOT_URL);

      shows = domShows.map(s => {
        const { date, time, dateObj } = formatDateTime(s.dateRaw);
        let title = s.rawTitle || '';
        if (!title || looksLikeDateString(title)) title = titleFromDay(dateObj);
        return { title, date, time, type: classifyType(title), url: s.url };
      });
    }

  } finally {
    await browser.close();
  }

  // Clean up
  const seen = new Set();
  shows = shows
    .filter(s => s.date || s.time)
    .filter(s => { const k = s.url || s.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 20);

  const outPath = path.join(__dirname, '..', 'shows.json');
  fs.writeFileSync(outPath, JSON.stringify(shows, null, 2));

  if (shows.length > 0) {
    console.log(`\nSaved ${shows.length} shows:`);
    shows.forEach(s => console.log(`  [${s.type}] ${s.date} ${s.time} — ${s.title}`));
  } else {
    console.log('No upcoming shows found.');
  }
}

scrape().catch(err => {
  console.error('Scraper error:', err.message);
  const outPath = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, '[]');
  process.exit(1);
});
