// DP Sports Cards — Whatnot Show Scraper
// Uses the Chrome browser installed by GitHub Actions (reliable, no download issues).

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const WHATNOT_URL = 'https://www.whatnot.com/user/polakoff/shows';

// Chrome path is passed in from the workflow as an environment variable
const CHROME_PATH = process.env.CHROME_PATH;
if (!CHROME_PATH) {
  console.error('ERROR: CHROME_PATH environment variable not set.');
  process.exit(1);
}

function classifyType(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('monday') || t.includes('big show') || t.includes('flagship') || t.includes('weekly')) return 'big';
  if (t.includes('modern') || t.includes('value') || t.includes('new release') || t.includes('chrome') || t.includes('prizm')) return 'modern';
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
  } catch {
    return { date: raw, time: '' };
  }
}

async function scrape() {
  console.log('Starting Whatnot scraper...');
  console.log('Using Chrome at:', CHROME_PATH);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  let shows = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Strategy 1: intercept the JSON the Whatnot app fetches internally
    const apiResponses = [];
    page.on('response', async response => {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      if (url.includes('show') || url.includes('stream') || url.includes('schedule') ||
          url.includes('upcoming') || url.includes('event') || url.includes('graphql')) {
        try { apiResponses.push({ url, json: await response.json() }); } catch {}
      }
    });

    console.log('Loading Whatnot page...');
    await page.goto(WHATNOT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));

    // Try API responses first (most reliable)
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
        console.log(`Found ${candidates.length} shows via API: ${url}`);
        shows = candidates.map(s => {
          const startTime = s.startTime || s.scheduledAt || s.startsAt || s.start_time || '';
          const { date, time } = formatDateTime(startTime);
          const title   = s.title || s.name || 'Upcoming Show';
          const showUrl = s.url || s.shareUrl || (s.id ? `https://www.whatnot.com/show/${s.id}` : WHATNOT_URL);
          return { title, date, time, type: classifyType(title), url: showUrl };
        }).filter(s => s.title);
        break;
      }
    }

    // Strategy 2: __NEXT_DATA__ blob
    if (shows.length === 0) {
      console.log('Trying __NEXT_DATA__...');
      const nextData = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        try { return JSON.parse(el.textContent); } catch { return null; }
      });
      if (nextData) {
        function findShowArray(obj) {
          if (Array.isArray(obj) && obj.length > 0 && (obj[0].startTime || obj[0].scheduledAt || obj[0].startsAt)) return obj;
          if (Array.isArray(obj)) { for (const i of obj) { const r = findShowArray(i); if (r) return r; } }
          if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) { const r = findShowArray(v); if (r) return r; } }
          return null;
        }
        const found = findShowArray(nextData);
        if (found) {
          shows = found.map(s => {
            const startTime = s.startTime || s.scheduledAt || s.startsAt || '';
            const { date, time } = formatDateTime(startTime);
            const title   = s.title || s.name || 'Upcoming Show';
            const showUrl = s.url || s.shareUrl || (s.id ? `https://www.whatnot.com/show/${s.id}` : WHATNOT_URL);
            return { title, date, time, type: classifyType(title), url: showUrl };
          }).filter(s => s.title);
        }
      }
    }

    // Strategy 3: DOM scraping
    if (shows.length === 0) {
      console.log('Trying DOM scraping...');
      const domShows = await page.evaluate((fallback) => {
        const results = [];
        const showLinks = [...document.querySelectorAll('a[href*="/show/"], a[href*="/stream/"], a[href*="/live/"]')];
        showLinks.forEach(link => {
          if (results.some(r => r.url === link.href)) return;
          const card    = link.closest('article, li, [class*="Card"], [class*="card"], [class*="Show"], [class*="show"]') || link.parentElement;
          const titleEl = card?.querySelector('h1,h2,h3,h4,[class*="title"],[class*="Title"]');
          const timeEl  = card?.querySelector('time,[class*="time"],[class*="date"],[class*="Date"]');
          const title   = (titleEl?.textContent || link.textContent || '').trim();
          if (!title || title.length < 3) return;
          results.push({ title, dateRaw: timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '', url: link.href || fallback });
        });
        return results;
      }, WHATNOT_URL);

      shows = domShows.map(s => {
        const { date, time } = formatDateTime(s.dateRaw);
        return { title: s.title, date, time, type: classifyType(s.title), url: s.url };
      });
    }

  } finally {
    await browser.close();
  }

  // Deduplicate and clean up
  const seen = new Set();
  shows = shows
    .filter(s => s.title && s.title.length > 2)
    .filter(s => { const k = s.url || s.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 20);

  const outPath = path.join(__dirname, '..', 'shows.json');
  fs.writeFileSync(outPath, JSON.stringify(shows, null, 2));

  if (shows.length > 0) {
    console.log(`Saved ${shows.length} upcoming shows:`);
    shows.forEach(s => console.log(`  • ${s.date} — ${s.title}`));
  } else {
    console.log('No upcoming shows found (normal if none are currently scheduled on Whatnot).');
  }
}

scrape().catch(err => {
  console.error('Scraper error:', err.message);
  const outPath = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, '[]');
  process.exit(1);
});
