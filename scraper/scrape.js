// DP Sports Cards — Whatnot Show Scraper
// Pure HTTP — no browser, no Chrome, nothing to be blocked.
// Fetches the page HTML directly and extracts show data from the
// server-rendered __NEXT_DATA__ blob that Whatnot embeds for SEO.

const https = require('https');
const fs   = require('fs');
const path = require('path');

const WHATNOT_URL = 'https://www.whatnot.com/user/polakoff/shows';

// ── HTTP helper ────────────────────────────────────────────
function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
      }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return get(next, depth + 1).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Helpers ────────────────────────────────────────────────
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

const TIME_KEYS  = ['startTime','scheduledAt','startsAt','start_time','scheduledStartTime',
                    'liveAt','goLiveAt','scheduledStart','begins','beginsAt','eventDate','streamDate'];
const TITLE_KEYS = ['title','name','streamTitle','showTitle','displayTitle','headline',
                    'broadcastTitle','eventTitle','showName','label','subject','caption'];

function extractTime(obj) {
  for (const k of TIME_KEYS)  { if (obj[k] != null) return obj[k]; }
  for (const sub of ['stream','show','event','details']) {
    if (obj[sub] && typeof obj[sub] === 'object') {
      for (const k of TIME_KEYS) { if (obj[sub][k] != null) return obj[sub][k]; }
    }
  }
  return null;
}

function extractTitle(obj) {
  for (const k of TITLE_KEYS) { if (obj[k] && typeof obj[k] === 'string' && obj[k].trim().length > 2) return obj[k].trim(); }
  for (const sub of ['stream','show','event','details','listing']) {
    if (obj[sub] && typeof obj[sub] === 'object') {
      for (const k of TITLE_KEYS) { if (obj[sub][k] && typeof obj[sub][k] === 'string') return obj[sub][k].trim(); }
    }
  }
  return '';
}

// Walk any JS/JSON structure looking for arrays of show-like objects
function findShowArrays(obj, depth = 0) {
  if (depth > 8 || obj == null) return [];
  const results = [];
  if (Array.isArray(obj)) {
    if (obj.length >= 1 && typeof obj[0] === 'object' && obj[0] !== null && extractTime(obj[0])) {
      results.push(obj);
    }
    for (const item of obj) results.push(...findShowArrays(item, depth + 1));
  } else if (typeof obj === 'object') {
    for (const v of Object.values(obj)) results.push(...findShowArrays(v, depth + 1));
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────
async function scrape() {
  console.log('=== DP Sports Cards Scraper (pure HTTP) ===');
  console.log('Fetching', WHATNOT_URL);

  const { status, body } = await get(WHATNOT_URL);
  console.log('HTTP status:', status, '| HTML bytes:', body.length);

  if (status !== 200) throw new Error(`Unexpected HTTP status: ${status}`);

  // ── Attempt 1: __NEXT_DATA__ ──────────────────────────────
  const nextMatch = body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    console.log('\n✓ Found __NEXT_DATA__ (' + nextMatch[1].length + ' chars)');
    const nextData = JSON.parse(nextMatch[1]);

    const arrays = findShowArrays(nextData);
    console.log('Show-like arrays found:', arrays.length);

    if (arrays.length > 0) {
      const best = arrays.sort((a,b) => b.length - a.length)[0];
      console.log('Best array has', best.length, 'items');
      console.log('First item keys:', Object.keys(best[0]).join(', '));
      console.log('First item (sample):', JSON.stringify(best[0]).slice(0, 800));

      const shows = best.map(s => {
        const { date, time } = formatDateTime(extractTime(s));
        const title = extractTitle(s);
        const id = s.id || s.showId || s.streamId || '';
        const url = s.url || s.shareUrl || (id ? `https://www.whatnot.com/show/${id}` : WHATNOT_URL);
        return { title, date, time, type: classifyType(title), url };
      }).filter(s => s.date || s.url !== WHATNOT_URL);

      return shows;
    }

    // Log the full structure so we can debug
    console.log('\n__NEXT_DATA__ top-level keys:', Object.keys(nextData).join(', '));
    if (nextData.props) console.log('props keys:', Object.keys(nextData.props).join(', '));
    if (nextData.props?.pageProps) console.log('pageProps keys:', Object.keys(nextData.props.pageProps).join(', '));
    console.log('\nFull __NEXT_DATA__ (first 4000 chars):');
    console.log(JSON.stringify(nextData, null, 2).slice(0, 4000));
  } else {
    console.log('\n✗ No __NEXT_DATA__ found');
  }

  // ── Attempt 2: JSON-LD structured data ───────────────────
  const ldBlocks = [...body.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  console.log('\nJSON-LD blocks found:', ldBlocks.length);
  for (const [, raw] of ldBlocks) {
    try {
      const ld = JSON.parse(raw);
      console.log('LD type:', ld['@type'], '| keys:', Object.keys(ld).join(', '));
      const arrays = findShowArrays(ld);
      if (arrays.length > 0) {
        console.log('Found show data in JSON-LD!');
        const best = arrays[0];
        return best.map(s => {
          const { date, time } = formatDateTime(extractTime(s));
          return { title: extractTitle(s), date, time, type: classifyType(extractTitle(s)), url: s.url || WHATNOT_URL };
        });
      }
    } catch {}
  }

  // ── Attempt 3: grep the raw HTML for show-like JSON ──────
  console.log('\nSearching raw HTML for show data...');
  // Look for any JSON arrays in script tags that contain time-field patterns
  const timePattern = /"(?:startTime|scheduledAt|startsAt|liveAt)":\s*"[^"]+"/;
  const scriptBlocks = [...body.matchAll(/<script[^>]*>([\s\S]{50,}?)<\/script>/g)];
  for (const [, scriptContent] of scriptBlocks) {
    if (timePattern.test(scriptContent)) {
      console.log('Found time-field pattern in script tag!');
      // Try to extract all JSON objects from this script
      const jsonArrayMatch = scriptContent.match(/\[(\s*\{[\s\S]+?\}[\s,]*)+\]/g);
      if (jsonArrayMatch) {
        for (const raw of jsonArrayMatch) {
          try {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length > 0 && extractTime(arr[0])) {
              console.log('Extracted show array from script tag, length:', arr.length);
              return arr.map(s => {
                const { date, time } = formatDateTime(extractTime(s));
                return { title: extractTitle(s), date, time, type: classifyType(extractTitle(s)), url: s.url || WHATNOT_URL };
              });
            }
          } catch {}
        }
      }
    }
  }

  // ── Fallback: log enough HTML to diagnose ─────────────────
  console.log('\n=== DIAGNOSTIC HTML DUMP (first 6000 chars) ===');
  console.log(body.slice(0, 6000));

  return [];
}

// ── Run ────────────────────────────────────────────────────
scrape().then(shows => {
  const seen = new Set();
  const unique = shows.filter(s => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 20);

  const outPath = path.join(__dirname, '..', 'shows.json');
  fs.writeFileSync(outPath, JSON.stringify(unique, null, 2));

  console.log(`\n=== SAVED ${unique.length} shows ===`);
  unique.forEach(s => console.log(`  "${s.title}" | ${s.date} | ${s.time} | ${s.url}`));

  if (unique.length === 0) {
    console.log('No shows found — please share this log for diagnosis.');
  }
}).catch(err => {
  console.error('Fatal error:', err.message);
  const outPath = path.join(__dirname, '..', 'shows.json');
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, '[]');
  process.exit(1);
});
