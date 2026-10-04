#!/usr/bin/env node
// Dalal Street Pulse: refresh live prices -> data.json
// Node 20+, no npm dependencies. Data: Yahoo Finance spark + chart endpoints.
// Usage: node scripts/update-prices.mjs        (writes ../data.json only if prices changed)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data.json');
const NEWS = join(ROOT, 'news.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

async function getJson(path, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = HOSTS[i % HOSTS.length] + path;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

// ---------- symbol universe ----------
const INDICES = [
  ['^NSEI', 'NIFTY 50'], ['^BSESN', 'SENSEX'], ['^NSEBANK', 'NIFTY BANK'], ['NIFTY_FIN_SERVICE.NS', 'NIFTY FIN SERVICES'],
  ['NIFTY_MIDCAP_100.NS', 'NIFTY MIDCAP 100'], ['^CNXSC', 'NIFTY SMALLCAP 100'], ['^NSMIDCP', 'NIFTY NEXT 50'],
  ['^CNXIT', 'NIFTY IT'], ['^INDIAVIX', 'INDIA VIX'],
];
const SECTORS = [
  ['^CNXIT', 'IT'], ['^CNXAUTO', 'AUTO'], ['^CNXFMCG', 'FMCG'], ['^CNXMEDIA', 'MEDIA'], ['^CNXMETAL', 'METAL'],
  ['^CNXPHARMA', 'PHARMA'], ['^CNXPSUBANK', 'PSU BANK'], ['NIFTY_PVT_BANK.NS', 'PRIVATE BANK'], ['^CNXREALTY', 'REALTY'],
  ['NIFTY_OIL_AND_GAS.NS', 'OIL & GAS'], ['NIFTY_CONSR_DURBL.NS', 'CONSUMER DURABLES'], ['NIFTY_HEALTHCARE.NS', 'HEALTHCARE'],
  ['NIFTY_CHEMICALS.NS', 'CHEMICALS'], ['NIFTY_CEMENT.NS', 'CEMENT'],
];
const GLOBAL = [
  ['^DJI', 'Dow Jones', 'US'], ['^GSPC', 'S&P 500', 'US'], ['^IXIC', 'Nasdaq', 'US'], ['^FTSE', 'FTSE 100', 'UK'], ['^GDAXI', 'DAX', 'Germany'],
  ['^N225', 'Nikkei 225', 'Japan'], ['^HSI', 'Hang Seng', 'Hong Kong'], ['000001.SS', 'Shanghai', 'China'], ['^KS11', 'KOSPI', 'Korea'],
];
const ASSETS = [
  ['GC=F', 'Gold', '$/oz'], ['SI=F', 'Silver', '$/oz'], ['BZ=F', 'Brent', '$/bbl'], ['CL=F', 'Crude (WTI)', '$/bbl'],
  ['INR=X', 'USD/INR', '₹ per $'], ['BTC-USD', 'Bitcoin', '$'],
];
// Nifty 100 + liquid F&O names. Unknown symbols are skipped automatically.
const STOCKS = `RELIANCE HDFCBANK ICICIBANK INFY TCS BHARTIARTL ITC LT SBIN KOTAKBANK AXISBANK HINDUNILVR BAJFINANCE M&M MARUTI
SUNPHARMA HCLTECH NTPC TATAMOTORS TMPV TITAN ULTRACEMCO POWERGRID ONGC ASIANPAINT TATASTEEL ADANIENT ADANIPORTS BAJAJFINSV
COALINDIA WIPRO JSWSTEEL NESTLEIND BAJAJ-AUTO GRASIM HINDALCO TECHM SBILIFE HDFCLIFE EICHERMOT CIPLA DRREDDY TRENT BEL
SHRIRAMFIN APOLLOHOSP TATACONSUM HEROMOTOCO INDUSINDBK JIOFIN ETERNAL MAXHEALTH INDIGO
ADANIGREEN ADANIPOWER AMBUJACEM BAJAJHLDNG BANKBARODA BOSCHLTD BRITANNIA CANBK CHOLAFIN COLPAL DABUR DIVISLAB DLF DMART
GAIL GODREJCP HAL HAVELLS HINDZINC ICICIGI ICICIPRULI IOC IRFC JINDALSTEL LICI LODHA NAUKRI PIDILITIND PFC PNB RECLTD
SHREECEM SIEMENS ENRIN TATAPOWER TORNTPHARM TVSMOTOR UNITDSPR VBL VEDL ZYDUSLIFE CGPOWER SOLARINDS MAZDOCK HYUNDAI SWIGGY
MPHASIS COFORGE PERSISTENT LTIM OFSS KPITTECH POLICYBZR PAYTM NYKAA UNOMINDA KALYANKJIL UPL LICHSGFIN BLUESTARCO SAIL
POWERINDIA CUMMINSIND BSE MCX ANGELONE CDSL IDEA YESBANK IDFCFIRSTB FEDERALBNK AUBANK BANDHANBNK MUTHOOTFIN MANAPPURAM
ASHOKLEY BHARATFORG MOTHERSON EXIDEIND TATACOMM TATAELXSI LUPIN AUROPHARMA BIOCON ALKEM GLENMARK MANKIND
NMDC NATIONALUM BPCL HINDPETRO PETRONET OIL IGL ADANIENSOL JSWENERGY NHPC SJVN SUZLON IREDA BHEL ABB POLYCAB DIXON
VOLTAS CROMPTON PAGEIND MARICO GODREJPROP OBEROIRLTY PRESTIGE PHOENIXLTD INDHOTEL IRCTC CONCOR ASTRAL SUPREMEIND
TARIL MONEYVIEW`.split(/\s+/).filter(Boolean);

// ---------- helpers ----------
const IST_OFF = 5.5 * 3600e3;
const istParts = (ms) => { const d = new Date(ms + IST_OFF); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), date: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16) }; };

async function spark(symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 20) {
    const chunk = symbols.slice(i, i + 20);
    try {
      const j = await getJson('/v7/finance/spark?range=1d&interval=5m&symbols=' + encodeURIComponent(chunk.join(',')));
      for (const r of j?.spark?.result ?? []) {
        const m = r.response?.[0]?.meta; if (!m || m.regularMarketPrice == null) continue;
        const prev = m.chartPreviousClose ?? m.previousClose, last = m.regularMarketPrice;
        out[r.symbol] = {
          last, prev, chg: prev ? last - prev : null, pct: prev ? (last - prev) / prev * 100 : null,
          high: m.regularMarketDayHigh ?? null, low: m.regularMarketDayLow ?? null,
          hi52: m.fiftyTwoWeekHigh ?? null, lo52: m.fiftyTwoWeekLow ?? null,
          vol: m.regularMarketVolume ?? null, time: m.regularMarketTime ?? null, name: m.shortName ?? m.longName ?? null,
        };
      }
    } catch (e) { errors.push('spark ' + chunk[0] + '..: ' + e.message); }
    await sleep(350);
  }
  return out;
}

// Intraday series for the most recent session (works on holidays/weekends too)
async function intraday(sym) {
  const j = await getJson(`/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=5m`);
  const r = j?.chart?.result?.[0]; if (!r?.timestamp) return null;
  const c = r.indicators?.quote?.[0]?.close ?? [];
  const pts = r.timestamp.map((t, i) => [t, c[i]]).filter(([, v]) => v != null);
  if (!pts.length) return null;
  const lastDate = istParts(pts.at(-1)[0] * 1000).date;
  const day = pts.filter(([t]) => istParts(t * 1000).date === lastDate);
  // previous close = last point of the prior session if available, else meta
  const before = pts.filter(([t]) => istParts(t * 1000).date < lastDate);
  const prev = before.length ? before.at(-1)[1] : r.meta?.previousClose ?? null;
  return { date: lastDate, prev: r2(prev), points: day.map(([t, v]) => [t, r2(v)]) };
}

async function ibja() {
  try {
    const res = await fetch('https://ibjarates.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    const hid = (id) => { const m = html.match(new RegExp('id="' + id + '" value="([^"]*)"')); try { return m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : null; } catch { return null; } };
    const row = (h, key) => { const v = h?.[key]; if (!v?.length) return null; const last = +v.at(-1), prev = +v.at(-2);
      return { last, pct: prev ? r2((last - prev) / prev * 100, 3) : null, date: h.labels?.at(-1) ?? null }; };
    const gold = row(hid('HdnGold'), 'purity999'), silver = row(hid('HdnSilver'), 'silverRate');
    return gold || silver ? { gold, silver, source: 'IBJA 999 purity, excl. GST' } : null;
  } catch { return null; }
}

// ---------- main ----------
const errors = [];
const prevData = readJson(DATA) ?? {};
const news = readJson(NEWS) ?? {};
const newsSyms = [...new Set([
  ...(news.trending ?? []).map((t) => t.symbol), ...Object.keys(news.gainerReasons ?? {}), ...Object.keys(news.loserReasons ?? {}),
])];
const stockList = [...new Set([...STOCKS, ...newsSyms])];
const ySyms = [...new Set([...INDICES, ...SECTORS, ...GLOBAL, ...ASSETS].map((x) => x[0]))];

const q = await spark([...ySyms, ...stockList.map((s) => s + '.NS')]);
const fmt = (s, name, extra = {}) => { const x = q[s]; return x && { name, symbol: s, last: r2(x.last), chg: r2(x.chg), pct: r2(x.pct), high: r2(x.high), low: r2(x.low), prev: r2(x.prev), ...extra }; };

const nifty = q['^NSEI'];
if (!nifty) errors.push('nifty quote missing');

const indices = INDICES.map(([s, n]) => fmt(s, n, { hi52: r2(q[s]?.hi52), lo52: r2(q[s]?.lo52) })).filter(Boolean);
const sectors = SECTORS.map(([s, n]) => fmt(s, n)).filter(Boolean).sort((a, b) => b.pct - a.pct);
const global = GLOBAL.map(([s, n, region]) => fmt(s, n, { region })).filter(Boolean);
const assets = ASSETS.map(([s, n, unit]) => fmt(s, n, { unit })).filter(Boolean);

// Session date: the IST date of Nifty's last trade
const now = Date.now();
const nowIst = istParts(now);
const sessionDate = nifty?.time ? istParts(nifty.time * 1000).date : null;

const stocks = stockList.map((s) => {
  const x = q[s + '.NS']; if (!x || x.pct == null) return null;
  // ignore stale quotes from a different session (suspended / illiquid names)
  if (sessionDate && x.time && istParts(x.time * 1000).date !== sessionDate) return null;
  return { symbol: s, name: x.name, ltp: r2(x.last), chg: r2(x.chg), pct: r2(x.pct), high: r2(x.high), low: r2(x.low), prev: r2(x.prev),
    hi52: r2(x.hi52), lo52: r2(x.lo52), vol: x.vol, valueCr: x.vol ? r2(x.vol * x.last / 1e7, 0) : null };
}).filter(Boolean);
// Fresh listings: Yahoo's "previous close" can be the issue price; drop absurd moves (>20% band) from the movers lists
const movable = stocks.filter((s) => Math.abs(s.pct) <= 20);
const gainers = [...movable].filter((s) => s.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 10);
const losers = [...movable].filter((s) => s.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 10);
const mostActive = [...stocks].filter((s) => s.valueCr).sort((a, b) => b.valueCr - a.valueCr).slice(0, 10);

// Intraday charts
const intra = {};
for (const [s, key] of [['^NSEI', 'nifty'], ['^BSESN', 'sensex'], ['^NSEBANK', 'banknifty']]) {
  try { intra[key] = await intraday(s); } catch (e) { errors.push('chart ' + s + ': ' + e.message); intra[key] = prevData.intraday?.[key] ?? null; }
  await sleep(300);
}

// Market status: Mon-Fri 09:15-15:30 IST, and Nifty must be trading today (catches exchange holidays)
const inHours = nowIst.dow >= 1 && nowIst.dow <= 5 && nowIst.min >= 555 && nowIst.min < 930;
const tradedToday = sessionDate === nowIst.date;
const status = inHours && (tradedToday || !nifty) ? 'open' : 'closed';
let statusNote = 'Market closed';
if (status === 'open') statusNote = 'Market open';
else if (nowIst.dow === 0 || nowIst.dow === 6) statusNote = 'Weekend: market closed';
else if (inHours && !tradedToday) statusNote = 'Market holiday or not yet trading';
else if (nowIst.min < 555) statusNote = 'Pre-open: market opens 9:15 AM IST';
else statusNote = 'Market closed for the day';

const bullion = (await ibja()) ?? prevData.bullion ?? null;

const payload = {
  market: { status, note: statusNote, sessionDate, hours: '09:15-15:30 IST, Mon-Fri' },
  indices, sectors, gainers, losers, mostActive, stocks, global, assets, bullion, intraday: intra,
  source: 'Yahoo Finance (prices, may be delayed); IBJA (bullion)',
};

// Only write when prices/status actually changed (keeps git history quiet)
const strip = (o) => { const { updated, updatedIst, errors: _e, ...rest } = o ?? {}; return JSON.stringify(rest); };
const usable = indices.length > 0 && stocks.length > 0;
if (!usable) {
  console.error('No usable data fetched; data.json left unchanged.', errors.join(' | '));
  process.exit(1);
}
if (strip(payload) === strip(prevData)) {
  console.log('No price changes; data.json unchanged.');
} else {
  const out = { updated: new Date(now).toISOString(), updatedIst: `${nowIst.date} ${nowIst.hhmm}`, ...payload, errors };
  writeFileSync(DATA, JSON.stringify(out) + '\n');
  console.log(`Wrote data.json: ${indices.length} indices, ${sectors.length} sectors, ${stocks.length} stocks, ` +
    `nifty ${intra.nifty?.points?.length ?? 0} pts, status=${status}${errors.length ? ', errors: ' + errors.join(' | ') : ''}`);
}
