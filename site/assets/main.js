/*
 * Page behaviour: charts, scroll reveals, copy buttons, theme and language.
 *
 * The two charts are drawn in SVG at the container's real size rather than
 * scaled through a viewBox — a scaled axis label becomes an unreadable one on
 * a narrow screen. They redraw on resize and on a language change.
 */
;(() => {
  const NS = 'http://www.w3.org/2000/svg'
  const t = (k) => window.AWAH_I18N.t(k)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function el(name, attrs, text) {
    const n = document.createElementNS(NS, name)
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k])
    if (text != null) n.textContent = text
    return n
  }
  function fmt(n, digits) {
    return n.toLocaleString(window.AWAH_I18N.lang() === 'en' ? 'en-US' : 'pt-BR', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0,
    })
  }

  /*
   * The theme lives in custom properties, but a mark's colour is written as a
   * presentation attribute — and `fill="var(--x)"` is not resolved the same way
   * everywhere. So the value is read from the computed style and written as a
   * literal. The tokens stay the single source of truth: the charts redraw when
   * the theme changes, and pick the new value up then.
   */
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }

  /* ── Warm-up ──────────────────────────────────────────────────────────
   * The engine's interpolated ramp: 5% on day 0, 100% on day 30. The marked
   * points are the ones the documentation names; the rest is the interpolation.
   */
  const ANCHORS = [
    [0, 5],
    [3, 20],
    [7, 40],
    [14, 70],
    [30, 100],
  ]
  const CAP_PER_MIN = 12

  function warmupAt(day) {
    for (let i = 0; i < ANCHORS.length - 1; i++) {
      const a = ANCHORS[i],
        b = ANCHORS[i + 1]
      if (day >= a[0] && day <= b[0]) {
        return a[1] + (b[1] - a[1]) * ((day - a[0]) / (b[0] - a[0]))
      }
    }
    return 100
  }

  const WARMUP = (() => {
    const out = []
    for (let d = 0; d <= 30; d++) out.push({ day: d, pct: warmupAt(d) })
    return out
  })()

  function drawWarmup(host, tip) {
    const C = {
      series1: token('--series-1'),
      surface: token('--surface'),
      ink: token('--ink'),
      lineStrong: token('--line-strong'),
    }
    host.innerHTML = ''
    const W = Math.max(280, host.clientWidth)
    const H = W < 420 ? 230 : 268
    const m = { t: 18, r: 16, b: 44, l: 40 }
    const iw = W - m.l - m.r,
      ih = H - m.t - m.b
    const x = (d) => m.l + (d / 30) * iw
    const y = (p) => m.t + ih - (p / 100) * ih

    const svg = el('svg', {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': `${t('c.warmup.series')} — ${t('c.warmup.x')}`,
    })

    /* horizontal grid, recessive */
    const g = el('g', { class: 'grid' })
    ;[0, 25, 50, 75, 100].forEach((p) => {
      g.appendChild(el('line', { x1: m.l, x2: m.l + iw, y1: y(p), y2: y(p) }))
      svg.appendChild(
        el('text', { class: 'tick', x: m.l - 8, y: y(p) + 4, 'text-anchor': 'end' }, `${p}%`),
      )
    })
    svg.appendChild(g)

    /*
     * The configured cap is an annotation, not a series — and it needs no line
     * of its own: the 100% gridline is already exactly there. Only the label,
     * kept to the left so it does not sit on top of the day-30 value.
     */
    svg.appendChild(
      el('text', { class: 'ref-label', x: m.l + 4, y: y(100) - 8 }, t('c.warmup.ref')),
    )

    /* x axis */
    svg.appendChild(
      el('line', {
        class: 'axis-base',
        x1: m.l,
        x2: m.l + iw,
        y1: y(0),
        y2: y(0),
        stroke: C.lineStrong,
      }),
    )
    const xt = W < 420 ? [0, 7, 14, 30] : [0, 3, 7, 14, 21, 30]
    xt.forEach((d) => {
      svg.appendChild(
        el(
          'text',
          {
            class: 'tick',
            x: x(d),
            y: y(0) + 18,
            'text-anchor': d === 0 ? 'start' : d === 30 ? 'end' : 'middle',
          },
          d,
        ),
      )
    })
    svg.appendChild(
      el(
        'text',
        { class: 'axis-title', x: m.l + iw / 2, y: H - 8, 'text-anchor': 'middle' },
        t('c.warmup.x'),
      ),
    )

    /* area + line */
    const line = WARMUP.map((p, i) => `${(i ? 'L' : 'M') + x(p.day)} ${y(p.pct)}`).join(' ')
    const gid = 'wu-fill'
    const defs = el('defs')
    const lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 })
    lg.appendChild(el('stop', { offset: '0%', 'stop-color': C.series1, 'stop-opacity': '0.22' }))
    lg.appendChild(el('stop', { offset: '100%', 'stop-color': C.series1, 'stop-opacity': '0' }))
    defs.appendChild(lg)
    svg.appendChild(defs)
    svg.appendChild(
      el('path', {
        d: `${line} L${x(30)} ${y(0)} L${x(0)} ${y(0)} Z`,
        fill: `url(#${gid})`,
      }),
    )
    const path = el('path', {
      d: line,
      fill: 'none',
      stroke: C.series1,
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })
    svg.appendChild(path)

    /* markers only on the days the documentation names, each directly labelled */
    const labelled = W < 420 ? [0, 30] : [0, 3, 7, 14, 30]
    ANCHORS.forEach((a) => {
      const cx = x(a[0]),
        cy = y(a[1])
      svg.appendChild(
        el('circle', {
          cx: cx,
          cy: cy,
          r: 5,
          fill: C.series1,
          stroke: C.surface,
          'stroke-width': 2,
        }),
      )
      if (labelled.indexOf(a[0]) === -1) return
      svg.appendChild(
        el(
          'text',
          {
            class: 'series-label',
            x: a[0] === 30 ? cx - 6 : cx + 9,
            y: cy - 9,
            'text-anchor': a[0] === 30 ? 'end' : 'start',
            fill: C.ink,
          },
          `${a[1]}%`,
        ),
      )
    })

    /* hover layer: vertical crosshair + tooltip */
    const cross = el('line', {
      x1: 0,
      x2: 0,
      y1: m.t,
      y2: y(0),
      stroke: C.lineStrong,
      'stroke-width': 1,
      opacity: 0,
    })
    const focus = el('circle', {
      r: 5.5,
      fill: C.series1,
      stroke: C.surface,
      'stroke-width': 2,
      opacity: 0,
    })
    svg.appendChild(cross)
    svg.appendChild(focus)

    const hit = el('rect', {
      x: m.l,
      y: m.t,
      width: iw,
      height: ih,
      fill: 'transparent',
      style: 'cursor:crosshair',
    })
    svg.appendChild(hit)

    function move(ev) {
      const box = svg.getBoundingClientRect()
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - box.left
      const day = Math.round(Math.min(30, Math.max(0, ((px - m.l) / iw) * 30)))
      const p = WARMUP[day]
      cross.setAttribute('x1', x(day))
      cross.setAttribute('x2', x(day))
      cross.setAttribute('opacity', 1)
      focus.setAttribute('cx', x(day))
      focus.setAttribute('cy', y(p.pct))
      focus.setAttribute('opacity', 1)
      tip.innerHTML =
        '<span class="tip__h">' +
        t('c.warmup.day') +
        ' ' +
        day +
        '</span>' +
        '<span class="tip__row"><i class="tip__sw" style="background:var(--series-1)"></i>' +
        t('c.warmup.pct') +
        '<b class="tip__v">' +
        fmt(p.pct, 0) +
        '%</b></span>' +
        '<span class="tip__row"><i class="tip__sw" style="background:transparent"></i>' +
        t('c.warmup.rate') +
        '<b class="tip__v">' +
        fmt((p.pct / 100) * CAP_PER_MIN, 1) +
        '</b></span>'
      tip.classList.add('on')
      const tw = tip.offsetWidth
      tip.style.left = `${Math.min(host.clientWidth - tw, Math.max(0, x(day) - tw / 2))}px`
      tip.style.top = `${Math.max(0, y(p.pct) - tip.offsetHeight - 14)}px`
    }
    function leave() {
      cross.setAttribute('opacity', 0)
      focus.setAttribute('opacity', 0)
      tip.classList.remove('on')
    }
    hit.addEventListener('mousemove', move)
    hit.addEventListener('mouseleave', leave)
    hit.addEventListener('touchstart', move, { passive: true })
    hit.addEventListener('touchmove', move, { passive: true })
    hit.addEventListener('touchend', leave)

    host.appendChild(svg)

    if (!reduced) {
      const len = path.getTotalLength()
      path.style.strokeDasharray = len
      path.style.strokeDashoffset = len
      path.style.transition = 'stroke-dashoffset 1.4s cubic-bezier(.3,.7,.3,1)'
      requestAnimationFrame(() => {
        path.style.strokeDashoffset = 0
      })
    }
  }

  /* ── Score signals ───────────────────────────────────────────────── */
  const SIGNALS = [
    { key: 'c.sig.1', why: 'c.sig.1w', w: 35 },
    { key: 'c.sig.2', why: 'c.sig.2w', w: 25 },
    { key: 'c.sig.3', why: 'c.sig.3w', w: 25 },
    { key: 'c.sig.4', why: 'c.sig.4w', w: 15 },
  ]

  function drawSignals(host, tip) {
    const C = {
      series1: token('--series-1'),
      surface: token('--surface'),
      ink: token('--ink'),
      lineStrong: token('--line-strong'),
    }
    host.innerHTML = ''
    const W = Math.max(280, host.clientWidth)
    /*
     * Narrow: the name goes above its bar. A label column that keeps shrinking
     * ends up clipping "Conversa unilateral" from the left, and a truncated
     * signal name is worse than a taller row.
     */
    const stacked = W < 460
    const rowH = stacked ? 58 : 46
    const barH = 22
    const m = { t: stacked ? 20 : 6, r: 44, b: 30, l: stacked ? 0 : Math.min(170, W * 0.34) }
    const H = m.t + SIGNALS.length * rowH + m.b
    const iw = W - m.l - m.r
    const x = (v) => (v / 40) * iw

    const svg = el('svg', {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': t('c.sig.x'),
    })

    SIGNALS.forEach((s, i) => {
      const cy = m.t + i * rowH + rowH / 2
      const w = Math.max(4, x(s.w))

      svg.appendChild(
        el(
          'text',
          {
            class: 'tick',
            x: stacked ? 0 : m.l - 12,
            y: stacked ? cy - barH / 2 - 8 : cy + 4,
            'text-anchor': stacked ? 'start' : 'end',
            fill: C.ink,
            style: 'font-family:var(--sans);font-size:13px',
          },
          t(s.key),
        ),
      )

      /* rounded end only where the data stops; the base stays anchored */
      const r = 4
      const d =
        'M' +
        m.l +
        ' ' +
        (cy - barH / 2) +
        ' H' +
        (m.l + w - r) +
        ' a' +
        r +
        ' ' +
        r +
        ' 0 0 1 ' +
        r +
        ' ' +
        r +
        ' V' +
        (cy + barH / 2 - r) +
        ' a' +
        r +
        ' ' +
        r +
        ' 0 0 1 ' +
        -r +
        ' ' +
        r +
        ' H' +
        m.l +
        ' Z'
      const bar = el('path', { d: d, fill: C.series1 })
      bar.style.opacity = '0.92'
      svg.appendChild(bar)

      svg.appendChild(
        el(
          'text',
          {
            class: 'tick',
            x: m.l + w + 9,
            y: cy + 4,
            fill: C.ink,
            style: 'font-family:var(--mono);font-size:12.5px',
          },
          s.w,
        ),
      )

      const hit = el('rect', {
        x: 0,
        y: cy - rowH / 2,
        width: W,
        height: rowH,
        fill: 'transparent',
      })
      hit.addEventListener('mouseenter', () => {
        bar.style.opacity = '1'
        tip.innerHTML =
          '<span class="tip__h">' +
          t(s.key) +
          '</span>' +
          '<span class="tip__row"><i class="tip__sw" style="background:var(--series-1)"></i>' +
          t('c.sig.weight') +
          '<b class="tip__v">' +
          s.w +
          '</b></span>' +
          '<span class="tip__row" style="max-width:24ch;white-space:normal;color:var(--muted)">' +
          t(s.why) +
          '</span>'
        tip.classList.add('on')
        const tw = tip.offsetWidth
        tip.style.left = `${Math.min(host.clientWidth - tw, m.l + w / 2 - tw / 2)}px`
        tip.style.top = `${Math.max(0, cy - tip.offsetHeight - 12)}px`
      })
      hit.addEventListener('mouseleave', () => {
        bar.style.opacity = '0.92'
        tip.classList.remove('on')
      })
      svg.appendChild(hit)

      if (!reduced) {
        bar.style.transformOrigin = `${m.l}px ${cy}px`
        bar.style.transform = 'scaleX(0)'
        bar.style.transition = `transform .8s cubic-bezier(.3,.7,.3,1) ${i * 0.08}s, opacity .15s`
        requestAnimationFrame(() => {
          bar.style.transform = 'none'
        })
      }
    })

    svg.appendChild(el('text', { class: 'axis-title', x: m.l, y: H - 10 }, t('c.sig.x')))
    host.appendChild(svg)
  }

  /* ── Equivalent tables ────────────────────────────────────────────── */
  function fillTables() {
    const wb = document.getElementById('warmup-tbody')
    if (wb) {
      wb.innerHTML = ''
      ;[0, 3, 7, 14, 21, 30].forEach((d) => {
        const pct = warmupAt(d)
        const tr = document.createElement('tr')
        tr.innerHTML =
          '<th scope="row">' +
          d +
          '</th><td>' +
          fmt(pct, 0) +
          '%</td><td>' +
          fmt((pct / 100) * CAP_PER_MIN, 1) +
          '</td>'
        wb.appendChild(tr)
      })
    }
    const sb = document.getElementById('signals-tbody')
    if (sb) {
      sb.innerHTML = ''
      SIGNALS.forEach((s) => {
        const tr = document.createElement('tr')
        tr.innerHTML = `<th scope="row">${t(s.key)}</th><td>${s.w}</td><td>${t(s.why)}</td>`
        sb.appendChild(tr)
      })
    }
  }

  /* ── Chart mounting ───────────────────────────────────────────────── */
  const charts = []
  function mount(id, draw) {
    const host = document.getElementById(id)
    if (!host) return
    const tip = document.createElement('div')
    tip.className = 'tip'
    tip.setAttribute('role', 'status')
    host.appendChild(tip)
    const entry = { host: host, tip: tip, draw: draw, drawn: false }
    charts.push(entry)
    return entry
  }

  function renderChart(entry) {
    const tip = entry.tip
    entry.draw(entry.host, tip)
    entry.host.appendChild(tip)
    entry.drawn = true
  }

  /* ── Scroll reveal ────────────────────────────────────────────────── */
  function reveals() {
    const items = document.querySelectorAll('.reveal')
    if (!('IntersectionObserver' in window) || reduced) {
      items.forEach((n) => {
        n.classList.add('in')
      })
      charts.forEach(renderChart)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return
          e.target.classList.add('in')
          io.unobserve(e.target)
          charts.forEach((c) => {
            if (!c.drawn && (e.target === c.host || e.target.contains(c.host))) renderChart(c)
          })
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    items.forEach((n) => {
      io.observe(n)
    })
  }

  /* ── Copy ─────────────────────────────────────────────────────────── */
  function copiers() {
    document.querySelectorAll('.copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const text = btn.getAttribute('data-copy')
        const done = () => {
          const label = btn.querySelector('.copy__label')
          const prev = label.textContent
          label.textContent = t('c.copy.done')
          btn.classList.add('done')
          setTimeout(() => {
            label.textContent = prev
            btn.classList.remove('done')
          }, 1600)
        }
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(done, () => {})
        } else {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          try {
            document.execCommand('copy')
            done()
          } catch (_e) {}
          document.body.removeChild(ta)
        }
      })
    })
  }

  /* ── Theme ────────────────────────────────────────────────────────── */
  function theming() {
    const btn = document.getElementById('theme-toggle')
    if (!btn) return
    btn.addEventListener('click', () => {
      const root = document.documentElement
      const explicit = root.getAttribute('data-theme')
      const systemLight = window.matchMedia('(prefers-color-scheme: light)').matches
      const isLight = explicit ? explicit === 'light' : systemLight
      const next = isLight ? 'dark' : 'light'
      root.setAttribute('data-theme', next)
      try {
        localStorage.setItem('awah-theme', next)
      } catch (_e) {}
      charts.forEach((c) => {
        if (c.drawn) renderChart(c)
      })
    })
  }

  /* ── Language ─────────────────────────────────────────────────────── */
  function languages() {
    document.querySelectorAll('[data-lang-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.AWAH_I18N.apply(btn.getAttribute('data-lang-set'))
      })
    })
    document.addEventListener('awah:lang', () => {
      fillTables()
      charts.forEach((c) => {
        if (c.drawn) renderChart(c)
      })
    })
  }

  /* ── Star count ───────────────────────────────────────────────────── */
  function stars() {
    const out = document.getElementById('star-count')
    if (!out) return
    const show = (n) => {
      out.textContent = n >= 1000 ? `${(n / 1000).toFixed(1).replace('.0', '')}k` : String(n)
      out.hidden = false
    }
    let cache
    try {
      cache = JSON.parse(localStorage.getItem('awah-stars') || 'null')
    } catch (_e) {}
    if (cache && Date.now() - cache.at < 216e5) {
      show(cache.n)
      return
    }
    fetch('https://api.github.com/repos/leoberchielli/awah')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (typeof d.stargazers_count !== 'number') return
        show(d.stargazers_count)
        try {
          localStorage.setItem(
            'awah-stars',
            JSON.stringify({ n: d.stargazers_count, at: Date.now() }),
          )
        } catch (_e) {}
      })
      .catch(() => {
        if (cache) show(cache.n)
      })
  }

  /* ── Sticky bar ───────────────────────────────────────────────────── */
  function stickyNav() {
    const nav = document.getElementById('nav')
    if (!nav) return
    const on = () => {
      nav.classList.toggle('stuck', window.scrollY > 8)
    }
    on()
    window.addEventListener('scroll', on, { passive: true })
  }

  /* ── Start ────────────────────────────────────────────────────────── */
  function init() {
    window.AWAH_I18N.apply(document.documentElement.getAttribute('data-lang') || 'pt')

    mount('chart-warmup', drawWarmup)
    mount('chart-signals', drawSignals)
    fillTables()
    reveals()
    copiers()
    theming()
    languages()
    stars()
    stickyNav()

    let timer
    window.addEventListener('resize', () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        charts.forEach((c) => {
          if (c.drawn) renderChart(c)
        })
      }, 180)
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
