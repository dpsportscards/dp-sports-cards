// DP Sports Cards — Whatnot Show Scraper
// Body text parsing (proven to work) + title-based URL matching (no more index offsets).

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

// Parse body text into shows (titles, dates, times).
// Confirmed format from live Whatnot page:
//   polakoff
//   Mon, Jun 15, 5:00 PM
//   21
//   Show Title Here!
//   Singles, Raw Cards, Vintage   ← tag line (ignored)
//   polakoff ...
function parseBodyText(bodyText) {
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

  const startIdx = lines.findIndex(l => /Upcoming Shows/i.test(l));
  if (startIdx === -1) { console.log('⚠ "Upcoming Shows" not found in body text'); return []; }

  const endIdx = lines.findIndex((l, i) => i > startIdx && /^(Whatnot|© \d{4})/i.test(l));
  const relevant = lines.slice(startIdx + 1, endIdx === -1 ? undefined : endIdx);
  console.log(`Parsing ${relevant.length} lines in shows section`);

  const shows = [];
  let i = 0;

  while (i < relevant.length) {
    if (relevant[i] !== 'polakoff') { i++; continue; }
    i++;

    // Date/time line — handles day abbreviations AND "Today"/"Tomorrow"
    const dtLine = relevant[i] || '';
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Today|Tomorrow)/i.test(dtLine)) { i++; continue; }
    i++;

    // Skip counter number (30, 21, 19…)
    if (/^\d+$/.test(relevant[i] || '')) i++;

    // Title
    const title = (relevant[i] || '').trim();
    if (!title) { i++; continue; }
    i++;

    // Skip tag lines (comma-separated strings)
    while (i < relevant.length && relevant[i] !== 'polakoff' && relevant[i].includes(',')) i++;

    // Parse date and time — handles all Whatnot formats:
    // "Mon, Jun 15, 5:00 PM"  "Mon 5:00 PM"  "Today 3:45 PM"  "Tomorrow 5:00 PM"
    let date = '', time = '';
    const full     = dtLine.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]+\s+\d+),?\s+(\d+:\d+\s*[AP]M)/i);
    const short    = dtLine.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d+:\d+\s*[AP]M)/i);
    const todayFmt = dtLine.match(/^Today\s+(\d+:\d+\s*[AP]M)/i);
    const tmrwFmt  = dtLine.match(/^Tomorrow\s+(\d+:\d+\s*[AP]M)/i);

    if (full) {
      date = `${DAY_MAP[full[1].toLowerCase()]}, ${full[2]}`;
      time = `${full[3]} ET`;
    } else if (short) {
      date = DAY_MAP[short[1].toLowerCase()] || short[1];
      time = `${short[2]} ET`;
    } else if (todayFmt) {
      // Resolve "Today" to the actual calendar date in Eastern time
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      date = `${DAYS[et.getDay()]}, ${MONTHS[et.getMonth()]} ${et.getDate()}`;
      time = `${todayFmt[1]} ET`;
    } else if (tmrwFmt) {
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      et.setDate(et.getDate() + 1);
      const DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      date = `${DAYS[et.getDay()]}, ${MONTHS[et.getMonth()]} ${et.getDate()}`;
      time = `${tmrwFmt[1]} ET`;
    } else {
      date = dtLine;
    }

    shows.push({ title, date, time, type: classifyType(title, date), url: WHATNOT_URL });
  }

  return shows;
}

// Find the best matching URL for a show title from the page's link map.
// Matches by checking if the link's text content contains the show title.
// This avoids positional index errors entirely.
function findUrlForTitle(title, linkMap) {
  if (!title) return WHATNOT_URL;
  const t = title.toLowerCase();

  // Exact title match first
  let match = linkMap.find(l =>
    l.text.toLowerCase().includes(t) &&
    l.href !== WHATNOT_URL &&
    !l.href.match(/\/user\/[^/]+\/?$/)   // not just a profile page
  );

  // Fuzzy: first 25 characters of title (handles truncation)
  if (!match && title.length > 15) {
    const slug = t.slice(0, 25);
    match = linkMap.find(l =>
      l.text.toLowerCase().includes(slug) &&
      l.href !== WHATNOT_URL &&
      !l.href.match(/\/user\/[^/]+\/?$/)
    );
  }

  return match ? match.href : WHATNOT_URL;
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

    console.log('Page title:', await page.title());

    // Step 1: Parse body text for show titles / dates / times
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    shows = parseBodyText(bodyText);
    console.log(`Body text parsed: ${shows.length} shows found`);

    // Step 2: Build a map of every link on the page with its visible text
    const linkMap = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map(a => ({
        href: a.href,
        text: (a.innerText || a.textContent || '').trim()
      })).filter(l => l.href.includes('whatnot.com') && l.text.length > 0)
    );

    console.log(`\nAll Whatnot links found on page (${linkMap.length}):`);
    linkMap.forEach(l => console.log(`  [${l.href.replace('https://www.whatnot.com','')}]  "${l.text.slice(0,60).replace(/\n/g,' ')}"`));

    // Step 3: For each show, find its URL by matching the title against link text
    shows = shows.map(show => {
      const url = findUrlForTitle(show.title, linkMap);
      console.log(`  "${show.title}" → ${url === WHATNOT_URL ? '(fallback)' : url.replace('https://www.whatnot.com','')}`);
      return { ...show, url };
    });

  } finally {
    await browser.close();
  }

  // Deduplicate by title + date
  const seen = new Set();
  shows = shows.filter(s => {
    const k = `${s.title}|${s.date}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 20);

  const outPath = path.join(__dirname, '..', 'shows.json');
  const output = { lastUpdated: new Date().toISOString(), shows };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n=== SAVED ${shows.length} shows ===`);
  shows.forEach(s => console.log(`  [${s.type}] "${s.title}" | ${s.date} | ${s.time} | ${s.url.replace('https://www.whatnot.com','')}`));
}

scrape().catch(err => {
  console.error('Fatal:', err.message);
  const p = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
  process.exit(1);
});
