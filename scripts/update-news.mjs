// India Stock Market Report: refresh news + commentary -> news.json
// Runs in GitHub Actions right after update-prices.mjs. No AI, no paid services:
// headlines come from public RSS feeds; summary, mood, levels and risks are computed from data.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data.json');
const NEWS = join(ROOT, 'news.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nf = (x, d = 2) => x == null ? '–' : Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const sg = (x, d = 2) => (x > 0 ? '+' : x < 0 ? '−' : '') + nf(Math.abs(x), d);
const pc = (x) => sg(x) + '%';
const errors = [];

async function get(url, opts = {}, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return r;
      if (r.status < 500 && r.status !== 429) return null;
    } catch {}
    await sleep(800 * (i + 1));
  }
  return null;
}

// ---------- RSS ----------
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ''; };

async function rss(url, src) {
  const r = await get(url);
  if (!r) { errors.push('feed ' + src); return []; }
  const xml = await r.text();
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([b]) => {
    let title = tag(b, 'title'), source = src;
    const gsrc = tag(b, 'source');
    if (gsrc) { source = gsrc; title = title.replace(new RegExp('\\s+-\\s+' + gsrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), ''); }
    const ts = Date.parse(tag(b, 'pubDate')) || 0;
    return { title, url: tag(b, 'link'), src: source, ts };
  }).filter((x) => x.title && x.title.length > 15);
}
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
const FEEDS = {
  stocks: [['https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms', 'ET Markets'], ['https://www.livemint.com/rss/markets', 'Mint']],
  markets: [['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'ET Markets'], ['https://www.business-standard.com/rss/markets-106.rss', 'Business Standard']],
  econ: [['https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms', 'ET Economy']],
  mf: [['https://economictimes.indiatimes.com/mf/rssfeeds/359241701.cms', 'ET Mutual Funds']],
  ipo: [['https://economictimes.indiatimes.com/markets/ipos/fpos/rssfeeds/14655708.cms', 'ET IPO']],
  fin: [[gnews('(RBI OR SEBI OR FPI OR FII OR "bond yield" OR rupee) India when:2d'), 'Google News']],
  results: [[gnews('(Q1 OR Q2 OR Q3 OR Q4) results net profit India stock when:3d'), 'Google News']],
};

const MAX_AGE = 3 * 864e5;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, 8).join(' ');
function pick(items, n, seen, filter = () => true) {
  const out = [];
  for (const it of [...items].sort((a, b) => b.ts - a.ts)) {
    if (out.length >= n) break;
    if (it.ts && Date.now() - it.ts > MAX_AGE) continue;
    const k = norm(it.title);
    if (seen.has(k) || !filter(it)) continue;
    seen.add(k); out.push(it);
  }
  return out;
}
const slim = (it) => ({ title: it.title, url: it.url, src: it.src, ts: it.ts || null });

// ---------- NSE (FII/DII, IPOs, corporate actions, holidays) ----------
let nseCookie = '';
async function nse(path) {
  try {
    if (!nseCookie) {
      const r = await get('https://www.nseindia.com/', { headers: { Accept: 'text/html' } }, 1);
      nseCookie = (r?.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') || 'none';
    }
    const r = await get('https://www.nseindia.com/api/' + path, { headers: { Accept: 'application/json', Referer: 'https://www.nseindia.com/', Cookie: nseCookie } }, 2);
    return r ? await r.json() : null;
  } catch { return null; }
}

// ---------- main ----------
const D = readJson(DATA);
const prev = readJson(NEWS) ?? {};
if (!D?.indices?.length) { console.error('data.json missing; news.json left unchanged.'); process.exit(0); }

const feeds = {};
for (const [k, list] of Object.entries(FEEDS)) {
  feeds[k] = (await Promise.all(list.map(([u, s]) => rss(u, s)))).flat();
}
const all = Object.values(feeds).flat();
const seen = new Set();
const ANALYST = /\b(target price|target of|price target|buy rating|sell rating|upgrade|downgrade|overweight|underweight|initiates coverage|brokerage|stocks to buy|top picks?)\b/i;
const analyst = pick([...feeds.stocks, ...feeds.markets], 6, seen, (it) => ANALYST.test(it.title));
const stockNews = pick([...feeds.stocks, ...feeds.markets], 8, seen);
const econNews = pick(feeds.econ, 6, seen);
const mfNews = pick(feeds.mf, 6, seen);
const finNews = pick(feeds.fin, 6, seen);
const ipoNews = pick(feeds.ipo, 3, seen);
const earnings = pick(feeds.results, 5, seen);

// FII/DII from Moneycontrol (NSE does not answer cloud servers); NSE stays for holidays
const MC = 'https://www.moneycontrol.com/markets/fii-dii-data/', TL = 'https://trendlyne.com/macro-data/fii-dii/latest/cash-pastmonth/';
async function mcFii() {
  try {
    const r = await get(MC, { headers: { Accept: 'text/html' } }, 2); if (!r) return null;
    const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const a = m && JSON.parse(m[1])?.props?.pageProps?.FiiDiiData?.fiiDiiData;
    if (!Array.isArray(a) || !a.length) return null;
    const num = (x) => +String(x).replace(/,/g, ''), d = a[0];
    const [y, mo, da] = String(d.date).split('-');
    const date = `${da}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1]}-${y}`;
    return [{ cat: 'FII/FPI', date, buy: null, sell: null, net: num(d.fiiCM) }, { cat: 'DII', date, buy: null, sell: null, net: num(d.diiCM) }].filter((x) => isFinite(x.net));
  } catch { return null; }
}
// Backup for FII/DII: Trendlyne's summary lines ("FII were net sellers of ₹-9484.22 Cr in the cash segment on 01 Oct 2026")
async function tlFii() {
  try {
    const r = await get(TL, { headers: { Accept: 'text/html' } }, 2); if (!r) return null;
    const html = (await r.text()).replace(/\s+/g, ' ');
    const one = (who, cat) => {
      const m = html.match(new RegExp(who + ' were net (buyers|sellers) of ₹ ?(-?[\\d.,]+) Cr in the cash segment on (\\d{1,2}) (\\w{3}) (\\d{4})'));
      if (!m) return null;
      const v = Math.abs(+m[2].replace(/,/g, ''));
      return { cat, date: `${m[3].padStart(2, '0')}-${m[4]}-${m[5]}`, buy: null, sell: null, net: m[1] === 'sellers' ? -v : v };
    };
    const out = [one('FII', 'FII/FPI'), one('DII', 'DII')].filter((x) => x && isFinite(x.net));
    return out.length ? out : null;
  } catch { return null; }
}
const [fiiRaw, holRaw] = [(await mcFii()) ?? (await tlFii()), await nse('holiday-master?type=trading')];
const fiidii = fiiRaw?.length ? fiiRaw : (errors.push('fii/dii'), prev.fiidii ?? []);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const istNow = new Date(Date.now() + 5.5 * 3600e3);
const dayStart = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const parseNse = (s) => Date.parse(String(s).replace(/-/g, ' ') + ' UTC');
const today0 = dayStart(istNow);
const holidays = new Set((holRaw?.CM ?? []).map((h) => h.tradingDate));

// ---------- IPOs from Groww: open now, upcoming, allotment/listing soon, recently listed ----------
const GIPO = 'https://groww.in/v1/api/primaries/v1/ipo/', GROWW = GIPO + 'open';
const MO3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (ms) => { if (!ms && ms !== 0) return ''; const d = new Date(ms + 5.5 * 3600e3); return `${String(d.getUTCDate()).padStart(2, '0')}-${MO3[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
const isoDmy = (s) => { const t = s ? Date.parse(String(s).slice(0, 10) + 'T00:00:00+05:30') : NaN; return isFinite(t) ? dmy(t) : ''; };
const isoMs = (s) => { const t = s ? Date.parse(String(s).slice(0, 10) + 'T00:00:00+05:30') : NaN; return isFinite(t) ? t : null; };
async function gList(kind) {
  try { const r = await get(GIPO + kind, { headers: { Accept: 'application/json' } }, 2); const l = r ? (await r.json())?.ipoList : null; return Array.isArray(l) ? l : null; } catch { return null; }
}
// Full issue details from the IPO's own Groww page
async function gPage(id) {
  try {
    const r = await get('https://groww.in/ipo/' + id, { headers: { Accept: 'text/html' } }, 1); if (!r) return null;
    const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    return m ? JSON.parse(m[1])?.props?.pageProps?.ipoData ?? null : null;
  } catch { return null; }
}
const rnd = (x, d = 2) => x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
function ipoRow(i, d) {
  d = d ?? {};
  const cats = d.categories ?? i.categories ?? [];
  const c = cats.find((x) => /^IND/.test(x.category)) ?? cats[0] ?? {};
  const lo = d.minPrice ?? c.minPrice ?? null, hi = d.maxPrice ?? c.maxPrice ?? i.issuePrice ?? null;
  const qty = d.minBidQty ?? c.minBidQuantity ?? d.lotSize ?? c.lotSize ?? null;
  const subs = {}; for (const s of d.subscriptionRates ?? []) subs[String(s.category).toLowerCase()] = rnd(s.subscriptionRate);
  const fin = {}; for (const f of d.financials ?? []) { const y = Object.keys(f.yearly ?? {}).sort(); if (y.length) fin[f.title] = { year: 'FY' + y.at(-1).slice(2), v: f.yearly[y.at(-1)], prev: y.length > 1 ? f.yearly[y.at(-2)] : null }; }
  const rev = fin.Revenue, pat = fin.Profit;
  return {
    name: (d.companyShortName ?? i.companyName ?? '').trim() + ((d.isSme ?? i.isSme) ? ' (SME)' : ''),
    sme: !!(d.isSme ?? i.isSme), sector: d.sector ?? '',
    price: hi ? (lo && lo !== hi ? `₹${lo}–${hi}` : `₹${hi}`) : '',
    lot: d.lotSize ?? c.lotSize ?? null, minInv: qty && hi ? Math.round(qty * hi) : null,
    sizeCr: d.issueSize ? rnd(d.issueSize / 1e7, 1) : null,
    open: d.startDate ? isoDmy(d.startDate) : i.bidStartTimestamp ? dmy(i.bidStartTimestamp) : isoDmy(i.openingDate),
    close: d.endDate ? isoDmy(d.endDate) : i.bidEndTimestamp ? dmy(i.bidEndTimestamp) : isoDmy(i.closingDate),
    allot: isoDmy(d.allotmentDate ?? i.allotmentDate), listDate: d.listingDate ? isoDmy(d.listingDate) : i.listingTimestamp ? dmy(i.listingTimestamp) : '',
    subs: i.overallSubscription != null ? rnd(+i.overallSubscription) : subs.total ?? null,
    subsQib: subs.qib ?? null, subsNii: subs.nii ?? null, subsRetail: subs.retail ?? subs.ind ?? null,
    revCr: rev ? rnd(rev.v, 1) : null, revGrowth: rev && rev.prev ? rnd((rev.v / rev.prev - 1) * 100, 1) : null,
    patCr: pat ? rnd(pat.v, 1) : null, finYear: rev ? rev.year : pat ? pat.year : '',
    url: (d.symbol || i.searchId) ? 'https://groww.in/ipo/' + (i.searchId ?? '') : '',
  };
}
typeof prefetch === 'function' && prefetch(['open', 'upcoming', 'closed'].map((k) => [GIPO + k, { headers: { 'User-Agent': UA, Accept: 'application/json' } }]));
const [gOpen, gUp, gClosed] = [await gList('open'), await gList('upcoming'), await gList('closed')];
const now0 = Date.now();
const upDated = (gUp ?? []).filter((i) => i.bidStartTimestamp).sort((a, b) => a.bidStartTimestamp - b.bidStartTimestamp);
const detailIds = [...(gOpen ?? []), ...upDated].map((i) => i.searchId).filter(Boolean).slice(0, 10);
typeof prefetch === 'function' && prefetch(detailIds.map((id) => ['https://groww.in/ipo/' + id, { headers: { 'User-Agent': UA, Accept: 'text/html' } }]));
const pages = {}; for (const id of detailIds) pages[id] = await gPage(id);
const ipos = Array.isArray(gOpen) ? gOpen.map((i) => ipoRow(i, pages[i.searchId])) : (errors.push('ipo'), prev.ipos ?? []);
const ipoUpcoming = gUp ? upDated.map((i) => ipoRow(i, pages[i.searchId])) : (prev.ipoUpcoming ?? []);
const ipoPipeline = gUp ? gUp.filter((i) => !i.bidStartTimestamp).map((i) => i.companyName.trim()).slice(0, 12) : (prev.ipoPipeline ?? []);
const closed = gClosed ?? [];
const ipoAllot = gClosed ? closed.filter((i) => !i.isListed && (i.listingTimestamp ?? 0) >= now0 - 864e5).sort((a, b) => (a.listingTimestamp ?? 0) - (b.listingTimestamp ?? 0)).slice(0, 10)
  .map((i) => ({ name: i.companyName.trim() + (i.isSme ? ' (SME)' : ''), sme: !!i.isSme, issuePrice: i.issuePrice ?? null, subs: i.overallSubscription != null ? rnd(+i.overallSubscription) : null, close: isoDmy(i.closingDate), allot: isoDmy(i.allotmentDate), listDate: i.listingTimestamp ? dmy(i.listingTimestamp) : '', url: 'https://groww.in/ipo/' + i.searchId }))
  : (prev.ipoAllot ?? []);
const ipoListed = gClosed ? closed.filter((i) => i.isListed && i.listingPrice != null && (i.listingTimestamp ?? 0) >= now0 - 15 * 864e5).sort((a, b) => (b.listingTimestamp ?? 0) - (a.listingTimestamp ?? 0)).slice(0, 12)
  .map((i) => ({ name: i.companyName.trim() + (i.isSme ? ' (SME)' : ''), sme: !!i.isSme, issuePrice: i.issuePrice ?? null, listPrice: i.listingPrice, gain: i.listingReturn != null ? rnd(+i.listingReturn) : (i.issuePrice ? rnd((i.listingPrice / i.issuePrice - 1) * 100) : null), subs: i.overallSubscription != null ? rnd(+i.overallSubscription) : null, listDate: i.listingTimestamp ? dmy(i.listingTimestamp) : '', url: 'https://groww.in/ipo/' + i.searchId }))
  : (prev.ipoListed ?? []);
if (!gUp || !gClosed) errors.push('ipo lists');

// ---------- Dividends, bonus, splits, rights and dividend board meetings: Moneycontrol ----------
const MCCA = 'https://www.moneycontrol.com/markets/corporate-action/';
const CA_PAGES = { div: 'dividends_declared/', bonus: 'bonus/', split: 'splits/', rights: 'rights/', meet: 'board-meetings/' };
async function mcList(path) {
  try {
    const r = await get(MCCA + path, { headers: { Accept: 'text/html' } }, 2); if (!r) return null;
    const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const l = m ? JSON.parse(m[1])?.props?.pageProps?.data?.filteredList : null;
    return Array.isArray(l) ? l : null;
  } catch { return null; }
}
const mcHist = (scId) => `https://api.moneycontrol.com/mcapi/v1/stock/corporate-action?deviceType=W&scId=${encodeURIComponent(scId)}&section=d&page=1&appVersion=161`;
async function mcDivHist(scId) {
  try { const r = await get(mcHist(scId), { headers: { Accept: 'application/json' } }, 1); const l = r ? (await r.json())?.data?.dividends : null; return Array.isArray(l) ? l : null; } catch { return null; }
}
const dmyMs = (s) => { const m = String(s ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null; };
const dmyTxt = (t) => t == null ? '' : `${String(new Date(t).getUTCDate()).padStart(2, '0')}-${MO3[new Date(t).getUTCMonth()]}-${new Date(t).getUTCFullYear()}`;
const numv = (x) => { const v = parseFloat(String(x ?? '').replace(/,/g, '')); return isFinite(v) ? v : null; };
typeof prefetch === 'function' && prefetch(Object.values(CA_PAGES).map((p) => [MCCA + p, { headers: { 'User-Agent': UA, Accept: 'text/html' } }]));
const ca = {}; for (const [k, p] of Object.entries(CA_PAGES)) ca[k] = await mcList(p);
const istDay0 = Date.UTC(new Date(now0 + 5.5 * 3600e3).getUTCFullYear(), new Date(now0 + 5.5 * 3600e3).getUTCMonth(), new Date(now0 + 5.5 * 3600e3).getUTCDate());
const soon = (t) => t != null && t >= istDay0 && t <= istDay0 + 30 * 864e5;
let dividends = prev.dividends ?? [];
if (ca.div) {
  const rows = ca.div.map((x) => ({ x, t: dmyMs(x.exDate) })).filter((r) => soon(r.t)).sort((a, b) => a.t - b.t || (b.x.marketCap ?? 0) - (a.x.marketCap ?? 0)).slice(0, 15);
  const ids = rows.map((r) => r.x.scId).filter(Boolean).slice(0, 12);
  typeof prefetch === 'function' && prefetch(ids.map((id) => [mcHist(id), { headers: { 'User-Agent': UA, Accept: 'application/json' } }]));
  const hist = {}; for (const id of ids) hist[id] = await mcDivHist(id);
  dividends = rows.map(({ x, t }) => {
    const h = hist[x.scId] ?? [], price = numv(x.lastValue);
    const hd = (e) => Date.parse(e.announce_date + 'T00:00:00Z');
    let amt = numv(x.dividend);
    const cur = h.find((e) => String(e.effective_date ?? '').replace(/,/g, '') && Date.parse(String(e.effective_date).replace(',', '') + ' UTC') === t);
    if (!amt && cur && +cur.dividend_amount > 0) amt = +cur.dividend_amount;
    const yr = h.filter((e) => +e.dividend_amount > 0 && hd(e) > now0 - 365 * 864e5);
    const ttm = yr.length ? rnd(yr.reduce((s, e) => s + +e.dividend_amount, 0)) : null;
    const last = h.find((e) => +e.dividend_amount > 0);
    return {
      name: String(x.stockName).trim(), type: String(x.eventType ?? '').replace(/^Dividend\s*-\s*/, '') || 'Dividend',
      exDate: dmyTxt(t), annDate: dmyTxt(dmyMs(x.announcementDate)), amount: amt || null, price,
      pctChg: numv(x.perChange), yieldPct: amt && price ? rnd(amt / price * 100) : null,
      ttm, ttmYield: ttm && price ? rnd(ttm / price * 100) : null, count12m: yr.length || null,
      lastAmt: last ? +last.dividend_amount : null, lastDate: last ? String(last.effective_date ?? '') : '',
      mcapCr: x.marketCap ? Math.round(x.marketCap / 1e7) : null, url: x.url ?? '',
    };
  });
} else { errors.push('dividends'); dividends = dividends.filter((d) => (Date.parse(d.exDate.replace(/-/g, ' ') + ' UTC') || 0) >= istDay0); }
const actions = [];
for (const [k, label] of [['bonus', 'Bonus'], ['split', 'Split'], ['rights', 'Rights']]) {
  if (!ca[k]) { errors.push(k); continue; }
  for (const x of ca[k]) {
    const t = dmyMs(x.exDate); if (!soon(t)) continue;
    actions.push({ name: String(x.stockName).trim(), action: label, ratio: x.ratio && x.ratio !== '-' ? x.ratio : '', premium: x.premium ?? null, exDate: dmyTxt(t), t, price: numv(x.lastValue), pctChg: numv(x.perChange), mcapCr: x.marketCap ? Math.round(x.marketCap / 1e7) : null, url: x.url ?? '' });
  }
}
const corpOther = (ca.bonus || ca.split || ca.rights) ? actions.sort((a, b) => a.t - b.t).slice(0, 15).map(({ t, ...r }) => r) : (prev.corpOther ?? []);
const divMeetings = ca.meet ? ca.meet.filter((x) => /dividend/i.test(x.remark ?? '')).map((x) => ({ x, t: Date.parse(String(x.date).replace(',', '') + ' UTC') }))
  .filter((r) => isFinite(r.t) && r.t >= istDay0 && r.t <= istDay0 + 14 * 864e5).sort((a, b) => a.t - b.t || (b.x.marketCap ?? 0) - (a.x.marketCap ?? 0)).slice(0, 12)
  .map(({ x, t }) => ({ name: String(x.stockName).trim(), date: dmyTxt(t), purpose: x.remark, price: numv(x.lastValue), mcapCr: x.marketCap ? Math.round(x.marketCap / 1e7) : null, url: x.url ?? '' })) : (prev.divMeetings ?? []);
// Older pages read corpActions
const corpActions = [...dividends.map((d) => ({ symbol: d.name, subject: `${d.type} dividend${d.amount ? ' ₹' + d.amount + '/share' : ''}`, exDate: d.exDate })),
  ...corpOther.map((c) => ({ symbol: c.name, subject: `${c.action}${c.ratio ? ' ' + c.ratio : ''}`, exDate: c.exDate }))]
  .sort((a, b) => Date.parse(a.exDate.replace(/-/g, ' ') + ' UTC') - Date.parse(b.exDate.replace(/-/g, ' ') + ' UTC')).slice(0, 12);

// Next session (skips weekends + NSE holidays when known)
function nextSession() {
  const open = D.market?.status === 'open';
  const afterClose = (istNow.getUTCHours() * 60 + istNow.getUTCMinutes()) >= 555;
  let t = today0 + ((open || afterClose) ? 864e5 : 0);
  for (let i = 0; i < 10; i++, t += 864e5) {
    const d = new Date(t), dow = d.getUTCDay();
    const key = `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
    if (dow > 0 && dow < 6 && !holidays.has(key)) return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  return null;
}

// ---------- computed commentary ----------
const idx = (n) => D.indices.find((i) => i.name === n);
const asset = (n) => (D.assets ?? []).find((a) => a.name === n);
const n50 = idx('NIFTY 50'), sx = idx('SENSEX'), bn = idx('NIFTY BANK'), vix = idx('INDIA VIX');
const secs = [...(D.sectors ?? [])].sort((a, b) => b.pct - a.pct);
const open = D.market?.status === 'open';
const sd = D.market?.sessionDate ? new Date(D.market.sessionDate + 'T00:00:00Z') : istNow;
const sdLabel = `${sd.getUTCDate()} ${MON[sd.getUTCMonth()]} ${sd.getUTCFullYear()}`;
const hhmm = `${String(istNow.getUTCHours()).padStart(2, '0')}:${String(istNow.getUTCMinutes()).padStart(2, '0')}`;
const tracked = D.stocks ?? [];
const adv = tracked.filter((s) => s.pct > 0).length, dec = tracked.filter((s) => s.pct < 0).length;

const p = n50.pct;
const mood = p >= 0.75 ? 'Bullish' : p >= 0.2 ? 'Mildly bullish' : p <= -0.75 ? 'Bearish' : p <= -0.2 ? 'Mildly bearish' : 'Neutral';
const verb = open ? (p >= 0 ? 'is up' : 'is down') : (p >= 0 ? 'closed up' : 'closed down');
const top = secs[0], bot = secs[secs.length - 1];
const g1 = D.gainers?.[0], l1 = D.losers?.[0];
const fii = fiidii.find((f) => /FII|FPI/i.test(f.cat)), dii = fiidii.find((f) => /DII/i.test(f.cat));
const cr = (x) => 'Rs ' + nf(Math.abs(x), 0) + ' Cr';

const parts = [
  `Nifty ${verb} ${nf(Math.abs(p))}% at ${nf(n50.last)} (range ${nf(n50.low)}–${nf(n50.high)})`,
  sx && `Sensex ${sg(sx.chg)} pts at ${nf(sx.last)}`,
  top && bot && `${title(top.name)} leads (${pc(top.pct)}), ${title(bot.name)} lags (${pc(bot.pct)})`,
  g1 && l1 && `Top gainer ${g1.symbol} (${pc(g1.pct)}), top loser ${l1.symbol} (${pc(l1.pct)})`,
  fii && `FPIs net ${fii.net < 0 ? 'sold' : 'bought'} ${cr(fii.net)} (${fii.date})`,
].filter(Boolean);
const summary = parts.join('. ') + '.';
function title(s) { return s.split(' ').map((w) => w.length <= 3 && w === w.toUpperCase() ? w : w[0] + w.slice(1).toLowerCase()).join(' '); }

// Classic floor pivots from the session's high / low / last
const P = (n50.high + n50.low + n50.last) / 3;
const R1 = 2 * P - n50.low, S1 = 2 * P - n50.high, R2 = P + (n50.high - n50.low), S2 = P - (n50.high - n50.low);
const r0 = (x) => Math.round(x / 5) * 5;
const bull = { level: `Above ${nf(r0(R1), 0)}`, text: `A sustained move above the pivot resistance ${nf(r0(R1), 0)} would put buyers in control; next resistance ${nf(r0(R2), 0)}. Today's high: ${nf(n50.high)}.` };
const bear = { level: `Below ${nf(r0(S1), 0)}`, text: `Slipping under the pivot support ${nf(r0(S1), 0)} would favour sellers; next support ${nf(r0(S2), 0)}. Today's low: ${nf(n50.low)}.` };

const risks = [];
if (vix) risks.push(vix.pct > 3 ? `India VIX up ${nf(vix.pct)}% to ${nf(vix.last)}: expect bigger swings` : vix.last > 18 ? `India VIX elevated at ${nf(vix.last)}` : `India VIX at ${nf(vix.last)} (${pc(vix.pct)})`);
if (fii && fii.net < 0) risks.push(`FPIs net sold ${cr(fii.net)} on ${fii.date}${dii && dii.net > 0 ? `; DIIs bought ${cr(dii.net)}` : ''}`);
const brent = asset('Brent'); if (brent && (brent.last > 85 || Math.abs(brent.pct) > 2)) risks.push(`Brent crude at $${nf(brent.last)} (${pc(brent.pct)}) weighs on inflation and OMCs`);
const inr = asset('USD/INR'); if (inr && inr.pct > 0.1) risks.push(`Rupee weaker at ${nf(inr.last)} per dollar (${pc(inr.pct)})`);
const us = (D.global ?? []).find((g) => g.name === 'S&P 500'); if (us && us.pct < -0.5) risks.push(`Weak US cue: S&P 500 ${pc(us.pct)}`);
if (dec > adv * 1.5) risks.push(`Weak breadth: ${dec} of ${tracked.length} tracked stocks are down`);
if (n50.hi52 && n50.last < n50.hi52 * 0.9) risks.push(`Nifty ${nf((1 - n50.last / n50.hi52) * 100, 1)}% below its 52-week high of ${nf(n50.hi52)}`);

const conclusion = `Nifty ${verb} ${nf(Math.abs(p))}% at ${nf(n50.last)}${bn ? `, Bank Nifty ${pc(bn.pct)}` : ''}. ` +
  `Breadth: ${adv} up, ${dec} down among ${tracked.length} tracked stocks. ` +
  `Watch ${nf(r0(S1), 0)} support and ${nf(r0(R1), 0)} resistance${open ? '' : ' next session'}.`;

// Reasons: only real headlines that mention the company; otherwise just the move (never invented)
const STOP = new Set(['POWER', 'ENERGY', 'STEEL', 'MOTORS', 'CAPITAL', 'HOUSING', 'GLOBAL', 'INFRA', 'TATA', 'BAJAJ', 'ADANI', 'HINDUSTAN', 'BHARAT', 'NATIONAL', 'GENERAL', 'UNITED', 'LIMITED', 'LTD', 'LTD.', 'INDIA', 'INDIAN', 'THE', 'AND', '&', 'CORPORATION', 'CORP', 'COMPANY', 'INDUSTRIES', 'BANK', 'OF', 'FINANCE', 'SERVICES', 'ENTERPRISES']);
function headlineFor(s) {
  const keys = STOP.has(s.symbol) ? [] : [s.symbol];
  // company name: first word, or first two when the first is short ("CG POWER", "PB FINTECH")
  const w = (s.name ?? '').toUpperCase().replace(/[^A-Z0-9& ]/g, ' ').split(/\s+/).filter(Boolean);
  if (w[0] && !STOP.has(w[0])) keys.push(w[0].length < 5 && w[1] && !STOP.has(w[1]) ? w[0] + ' ' + w[1] : w[0]);
  const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[ -]');
  const res = keys.filter((k) => k.length >= 3).map((k) => new RegExp('\\b' + esc(k) + '\\b', 'i'));
  const hit = [...all].sort((a, b) => b.ts - a.ts).find((it) => (!it.ts || Date.now() - it.ts < 2 * 864e5) && res.some((r) => r.test(it.title)));
  return hit ? hit.title : null;
}
const short = (s, n = 90) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
const reasons = (list) => Object.fromEntries((list ?? []).slice(0, 10).map((s) => { const h = headlineFor(s); return [s.symbol, h ? 'In news: ' + short(h) : '']; }).filter(([, v]) => v));
const gainerReasons = reasons(D.gainers), loserReasons = reasons(D.losers);

const trending = [];
const addT = (s, why) => { if (s && !trending.some((t) => t.symbol === s.symbol)) { const h = headlineFor(s); trending.push({ symbol: s.symbol, reason: why + (h ? '. In news: ' + short(h, 70) : '') }); } };
(D.gainers ?? []).slice(0, 3).forEach((s, i) => addT(s, `Up ${nf(s.pct)}%${i === 0 ? ', top gainer' : ''}`));
(D.losers ?? []).slice(0, 3).forEach((s, i) => addT(s, `Down ${nf(Math.abs(s.pct))}%${i === 0 ? ', top loser' : ''}`));
(D.mostActive ?? []).slice(0, 4).forEach((s) => addT(s, `Most traded: Rs ${nf(s.valueCr, 0)} Cr (${pc(s.pct)})`));

const SECTOR_KEYS = { IT: /\b(IT stocks|IT shares|tech stocks|Infosys|TCS|Wipro|HCL ?Tech)\b/i, AUTO: /\b(auto|car|two-wheeler|Maruti|Tata Motors|M&M)\b/i, FMCG: /\b(FMCG|consumer staples|HUL|Nestle|Dabur|Britannia)\b/i,
  MEDIA: /\b(media|Zee|Sun TV|PVR)\b/i, METAL: /\b(metal|steel|aluminium|copper|Tata Steel|Hindalco|JSW)\b/i, PHARMA: /\b(pharma|drug ?maker|USFDA|Sun Pharma|Cipla)\b/i,
  'PSU BANK': /\b(PSU bank|SBI|public sector bank)\b/i, 'PRIVATE BANK': /\b(private bank|HDFC Bank|ICICI Bank|Kotak|Axis Bank)\b/i, REALTY: /\b(realty|real estate|DLF|Godrej Properties|Lodha)\b/i,
  'OIL & GAS': /\b(oil|crude|OMC|gas|Reliance|ONGC)\b/i, 'CONSUMER DURABLES': /\b(consumer durables|Titan|Havells|Voltas)\b/i, HEALTHCARE: /\b(hospital|healthcare|Apollo)\b/i,
  CHEMICALS: /\b(chemical|agrochemical|fertili[sz]er)\b/i, CEMENT: /\b(cement|UltraTech|Ambuja|ACC)\b/i };
const sectorReasons = Object.fromEntries(secs.map((s) => {
  const re = SECTOR_KEYS[s.name]; const h = re && [...all].sort((a, b) => b.ts - a.ts).find((it) => (!it.ts || Date.now() - it.ts < 864e5) && re.test(it.title));
  return [s.name, h ? 'In news: ' + short(h.title, 80) : ''];
}).filter(([, v]) => v));

const ipoNote = ipoNews.length ? ipoNews.map((x) => x.title).slice(0, 2).join('. ') : (prev.ipoNote ?? '');

const out = {
  asOf: D.market?.sessionDate ?? null,
  asOfLabel: open ? `${sdLabel}, ${hhmm} IST` : `${sdLabel}, 3:30 PM IST`,
  session: open ? `Live · ${hhmm} IST` : (D.market?.sessionDate === istNow.toISOString().slice(0, 10) ? 'Closing Report · 3:30 PM' : "Last session report"),
  mood, summary, conclusion, bull, bear, risks: risks.slice(0, 5),
  trending, gainerReasons, loserReasons, sectorReasons, assetReasons: {},
  stockNews: stockNews.map(slim), econNews: econNews.map(slim), mfNews: mfNews.map(slim), finNews: finNews.map(slim),
  earnings: earnings.map(slim), analyst: analyst.map(slim), ipoNote, ipos, ipoUpcoming, ipoAllot, ipoListed, ipoPipeline, dividends, divMeetings, corpOther, corpActions, fiidii,
  nextSession: nextSession(),
  generated: 'Automatic: headlines from ET, Mint, Business Standard and Google News RSS; summary, mood and levels computed from prices.',
};
// Keep the previous headlines for any feed that failed this run
for (const k of ['stockNews', 'econNews', 'mfNews', 'finNews', 'earnings']) if (!out[k].length && prev[k]?.length) out[k] = prev[k];

const strip = (o) => { const { asOfLabel, session, updated, errors: _e, ...rest } = o ?? {}; return JSON.stringify(rest); };
if (strip(out) === strip(prev) && out.session === prev.session) { console.log('No news changes; news.json unchanged.'); process.exit(0); }
out.updated = new Date().toISOString();
out.errors = errors;
writeFileSync(NEWS, JSON.stringify(out, null, 1) + '\n');
console.log(`Wrote news.json: ${stockNews.length} stock, ${econNews.length} econ, ${mfNews.length} MF, ${finNews.length} fin, ${analyst.length} analyst, ` +
  `${earnings.length} results headlines; mood=${mood}${errors.length ? '; errors: ' + errors.join(', ') : ''}`);
