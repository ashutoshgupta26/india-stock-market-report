# India Stock Market Report

Live Indian Market Report: a static, single-page site (no build step, no external scripts).

- `index.html` - the page (tabs: Overview, Stocks, Sectors, News, Outlook). Reads `data.json` and `news.json`, re-fetches every 60 s while the market is open.
- `data.json` - prices, written by `scripts/update-prices.mjs` (Node 20, no dependencies; Yahoo Finance chart/spark endpoints, IBJA bullion rates).
- `news.json` - commentary, news, reasons, FII/DII, IPOs and outlook. Edit by hand or from your report pipeline; set `asOf` to the session date it describes (reasons for movers and sectors are only shown when `asOf` matches the price session).
- `.github/workflows/update.yml` - runs the scripts every 5 minutes during NSE hours (Mon-Fri), hourly otherwise, and publishes the page with fresh `data.json` and `news.json` straight to GitHub Pages. The data files are not committed, so the repo does not grow. Pages source must be set to "GitHub Actions".

## Run locally

```sh
node scripts/update-prices.mjs
python3 -m http.server 8080   # then open http://localhost:8080
```

## Deploy

Push to a GitHub repository, enable Pages (deploy from branch, root), and allow Actions to write (Settings > Actions > Workflow permissions > Read and write).

Prices may be delayed. Not investment advice.
