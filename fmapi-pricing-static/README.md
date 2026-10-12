# FMAPI pricing calculator — static site

The same calculator as the Databricks App, running entirely in the browser. No server,
no account, no data leaves the page. The pricing engine (`engine.js`) is a line-for-line
port of `pricing/engine.py` and is verified to produce identical results.

Files: `index.html`, `styles.css`, `rates.js` (rate card), `engine.js` (cost model),
`export.js` (Excel via SheetJS, PDF via jsPDF — loaded from cdnjs), `app.js` (UI).

## Publish

**GitHub Pages**
1. Create a repository and push this folder's contents to its root (or a `docs/` folder).
2. Settings → Pages → Source: *Deploy from a branch* → pick the branch and `/ (root)` or `/docs`.
3. The site is live at `https://<user>.github.io/<repo>/` in about a minute.

**Azure Static Web Apps** (if you'd rather stay on Azure)
1. Portal → Create → Static Web App → connect the GitHub repo, build preset *Custom*,
   app location `/`, output location `/` (no build step).
2. It deploys on every push and gives you a `*.azurestaticapps.net` URL; add a custom domain if wanted.

**Anything else** — Netlify/Vercel drag-and-drop, Cloudflare Pages, an S3/Blob static website,
or even emailing the folder: double-clicking `index.html` works offline.

## Updating the rate card

`rates.js` is generated from `pricing/rates.py` in the Databricks App project. Update the
Python file, regenerate, and republish so both deployments stay in sync.

## Notes

- Downloads need `cdnjs.cloudflare.com` reachable from the visitor's browser. If it's blocked,
  the page still calculates; only the download buttons show an error.
- The signed-in user chip from the Databricks App version is removed here (there is no sign-in).
