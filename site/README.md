# site

The AWAH landing page, served at **awah.99ia.com.br**.

*[Português](README.pt-BR.md)*

Plain static: one `index.html`, one stylesheet, two script files and the media.
**No build, no dependency, no install step** — what is in this directory is
exactly what goes live. That is deliberate: a page that needs `npm install`
before it accepts a comma fix does not get the comma fix.

```
site/
  index.html          content in Portuguese — it is what the crawler reads
  assets/styles.css   theme tokens, components, responsive rules
  assets/i18n.js      the English dictionary, applied on top of the HTML
  assets/main.js      SVG charts, copy buttons, theme, scroll reveals
  assets/og.svg       source of the share image
  assets/og.png       what link unfurlers read (1200×630)
  assets/*-icon.png   favicons generated from the SVG (iOS ignores SVG)
  assets/*.gif        the same recordings as docs/img
  deploy/nginx.conf   the vhost on site01 — installed by hand, once
  robots.txt  sitemap.xml
```

`deploy/`, `og.html`, `make-og.mjs` and these READMEs are excluded from the
upload: the directory is published whole, and a server config with an internal
port on it has no business becoming a URL.

## Looking at it locally

```bash
python3 -m http.server 8000 --directory site
```

Then open `http://localhost:8000`. Opening `index.html` over `file://` works
too, except for the star count — the browser refuses the request on origin.

## Publishing

`.github/workflows/site.yml` publishes to **site01** on every push to `main`
that touches `site/` — the same VM and the same Cloudflare Access path the
other subdomains use. It rsyncs into `/home/deploy/awah-site/releases/<sha>`
and only then moves the `current` symlink, because copying over what is live
would serve the new HTML with the old CSS for a few seconds. The last five
releases stay on disk, which is what makes going back a one-line `ln -sfn`.

Three things exist outside the workflow, done once by hand, because a server
that reconfigures itself on every push is a server nobody reviews:

1. **The directory**: `mkdir -p /home/deploy/awah-site/releases` as `deploy`.
2. **The vhost**: `deploy/nginx.conf` — it listens on `127.0.0.1:8091` and
   carries the cache and security headers the page assumes.
3. **The tunnel**: an ingress entry pointing `awah.99ia.com.br` at
   `http://127.0.0.1:8091`, and `cloudflared tunnel route dns <tunnel>
   awah.99ia.com.br` to create the record.

TLS and HTTP/2 belong to Cloudflare; inside the VM it is plain HTTP on the
loopback.

The directory is a plain static site, so any other host serves it as it stands
— the headers in `deploy/nginx.conf` are the ones to reproduce elsewhere.

## Languages

The HTML is written in **Portuguese** — it is the domain's language, and it is
what reaches anyone without JavaScript and the search crawler. English lives in
`assets/i18n.js` and is applied on top; the original Portuguese is stored on
the first pass, so switching back is a restore, not a re-translation.

When you change the text of an element carrying `data-i18n`, change the
matching key in `i18n.js` too. The pair is checkable in one command:

```bash
node -e "const f=require('fs'),h=f.readFileSync('site/index.html','utf8'),j=f.readFileSync('site/assets/i18n.js','utf8');
const k=new Set([...h.matchAll(/data-i18n=\"([^\"]+)\"/g)].map(m=>m[1]));
[...h.matchAll(/data-i18n-attr=\"([^\"]+)\"/g)].forEach(m=>m[1].split(',').forEach(p=>k.add(p.split(':')[1].trim())));
const e=new Set([...j.matchAll(/^\s*'?([a-z0-9._]+)'?\s*:/gmi)].map(m=>m[1]));
const missing=[...k].filter(x=>!e.has(x)); console.log(missing.length?'missing: '+missing.join(', '):'ok: '+k.size+' keys')"
```

The starting language comes from `?lang=`, then from what was stored, then from
the browser — and the default is Portuguese.

## The chart colours

The two series tones (iris and cyan) were not picked by taste. Against this
page's actual surfaces they clear the lightness band, the chroma floor, the
colour-blindness separation (deutan and tritan ΔE) and the minimum contrast:

| | light | dark |
| --- | --- | --- |
| series 1 | `#4b4bc4` | `#7d7df0` |
| series 2 | `#0092a8` | `#22a6b8` |
| surface | `#ffffff` | `#131720` |

Green, amber and red mean connected, held and failed — as in the product's own
dashboard — and are never used for style. Changing any of these values means
validating the set again.

Both charts carry the equivalent table right below them, behind a `<details>`:
colour cannot be the only way to read the data.

## The share image

`assets/og.svg` is the source; `assets/og.png` is what Twitter, LinkedIn and
WhatsApp read. After editing the SVG:

```bash
node site/make-og.mjs      # needs sharp and the IBM Plex fonts installed
```

Without `sharp` at hand, `og.html` is the same image in HTML — open it in a
browser and capture the window at 1200×630. That same PNG works as the
repository's social preview on GitHub (Settings → General → Social preview).

## Notes

- There is **no `hreflang`** and no `?lang=en` in the sitemap. English is the
  same page swapped in the browser; announcing it as an alternate URL whose own
  canonical points back to `/` tells the crawler two contradictory things.
  English has its own URL in the repository README, which is where it belongs.
- The `Content-Security-Policy` allows `'unsafe-inline'` for script because of
  the block that applies theme and language **before the first paint** —
  without it the page flashes in the wrong theme. Swapping it for a hash is
  possible, and breaks on every edit to that block.
- The fonts come from Google Fonts. To serve them from the same origin,
  download both families, point a local `@font-face` at them and drop
  `fonts.googleapis.com` and `fonts.gstatic.com` from the CSP.
- The GIFs are copies of `docs/img/`. If those recordings are redone, copy them
  again — there is no symlink, on purpose: this directory has to stay
  publishable on its own.
