/**
 * Dashboard helpers for apps (Sites): number formats, KPI cards, bar, line and
 * scatter charts and a sortable table, with readable defaults. An app opts in
 * with
 *
 *   <script src="/__opengeni/charts.js"></script>
 *
 * which defines `window.og` (docs/site-runtime-api.md "Dashboards"). It draws
 * with the `og-*` classes and `--og-*` tokens of `/__opengeni/ui.css`, so the
 * two are used together. Plain browser JavaScript with no dependencies: in
 * Opengeni the tag is replaced by this script inline (like the stylesheet), and
 * a published Site's gateway and the local preview serve it at that path.
 */
export const SITE_CHARTS_SCRIPT_PATH = "/__opengeni/charts.js";

// Kept as plain ES2019 in one string: no build step, no template
// substitutions, safe to inline in a <script>.
export const SITE_CHARTS_JS = String.raw`(function () {
  "use strict";
  if (typeof window === "undefined" || window.og) return;
  var SVGNS = "http://www.w3.org/2000/svg";
  var nf = {};
  function NF(opts) {
    var k = JSON.stringify(opts);
    return nf[k] || (nf[k] = new Intl.NumberFormat(undefined, opts));
  }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  var DASH = "\u2014";

  // ---- formats ----------------------------------------------------------
  var fmt = {
    num: function (v, o) {
      if (!isNum(v)) return DASH;
      var d = o && o.digits != null ? o.digits : Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
      return NF({ maximumFractionDigits: d }).format(v);
    },
    int: function (v) { return isNum(v) ? NF({ maximumFractionDigits: 0 }).format(v) : DASH; },
    compact: function (v) {
      return isNum(v) ? NF({ notation: "compact", maximumFractionDigits: Math.abs(v) < 1000 ? 0 : 1 }).format(v) : DASH;
    },
    money: function (v, o) {
      if (!isNum(v)) return DASH;
      var c = (o && o.currency) || "USD";
      if ((o && o.compact) || Math.abs(v) >= 100000)
        return NF({ style: "currency", currency: c, notation: "compact", maximumFractionDigits: 1 }).format(v);
      var d = Math.abs(v) >= 100 ? 0 : 2;
      return NF({ style: "currency", currency: c, minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    },
    pct: function (v, o) {
      o = o || {};
      if (!isNum(v)) return DASH;
      // One decimal below 100%, so a column of percentages lines up.
      var d = o.digits != null ? o.digits : Math.abs(v) >= 100 ? 0 : 1;
      return NF({ maximumFractionDigits: d, minimumFractionDigits: d }).format(v) + "%";
    },
    ratio: function (v, o) { return isNum(v) ? fmt.pct(v * 100, o) : DASH; },
    ms: function (v) {
      if (!isNum(v)) return DASH;
      return Math.abs(v) >= 1000 ? fmt.num(v / 1000, { digits: v >= 10000 ? 0 : 1 }) + " s" : fmt.int(v) + " ms";
    },
    minutes: function (v) {
      if (!isNum(v)) return DASH;
      if (v < 1) return fmt.int(v * 60) + " s";
      if (v < 90) return fmt.num(v, { digits: v < 10 ? 1 : 0 }) + " min";
      return fmt.num(v / 60, { digits: 1 }) + " h";
    },
    date: function (v, o) {
      var d = toDate(v);
      if (!d) return v == null ? DASH : String(v);
      var opts = { day: "numeric", month: "short" };
      if (o && o.year) opts.year = "numeric";
      if (o && o.time) { opts.hour = "2-digit"; opts.minute = "2-digit"; }
      return new Intl.DateTimeFormat(undefined, opts).format(d);
    },
    // "Oct 2025"; o.short drops the year ("Nov") for ticks between year starts.
    month: function (v, o) {
      var d = toDate(v);
      if (!d) return String(v);
      return new Intl.DateTimeFormat(undefined, o && o.short ? { month: "short" } : { month: "short", year: "numeric" }).format(d);
    },
    time: function (v) {
      var d = toDate(v);
      return d ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(d) : String(v);
    },
    ago: function (v, now) {
      var d = toDate(v);
      if (!d) return DASH;
      var s = ((now ? toDate(now) : new Date()) - d) / 1000;
      var rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      var a = Math.abs(s), sign = s >= 0 ? -1 : 1;
      if (a < 60) return rtf.format(0, "second");
      if (a < 3600) return rtf.format(sign * Math.round(a / 60), "minute");
      if (a < 86400) return rtf.format(sign * Math.round(a / 3600), "hour");
      return rtf.format(sign * Math.round(a / 86400), "day");
    },
    // A change with its meaning: {text, tone: "good" | "bad" | "flat"}.
    // unit "%" (relative change, in percent), "pp" (percentage points) or a
    // format name / function for absolute changes. better: "higher" | "lower".
    delta: function (v, o) {
      o = o || {};
      if (!isNum(v)) return { text: DASH, tone: "flat" };
      var unit = o.unit == null ? "%" : o.unit;
      var mag = Math.abs(v);
      var body = unit === "%" ? fmt.pct(mag, { digits: o.digits != null ? o.digits : mag >= 10 ? 0 : 1 }) : unit === "pp" ? fmt.num(mag, { digits: o.digits != null ? o.digits : 1 }) + " pp" : format(unit)(mag);
      var flat = mag < (o.flat != null ? o.flat : 1e-9) || !/[1-9]/.test(body);
      var arrow = flat ? "" : v > 0 ? "\u25B2 " : "\u25BC ";
      var better = o.better || "higher";
      var tone = flat || better === "none" ? "flat" : (v > 0) === (better === "higher") ? "good" : "bad";
      return { text: arrow + (flat ? body.replace(/[0-9.,]+/, "0") : (v > 0 ? "+" : "\u2212") + body), tone: tone };
    },
  };
  function format(f) {
    if (typeof f === "function") return f;
    if (f && typeof f === "object") return function (v) { return fmt[f.type || "num"](v, f); };
    return fmt[f] || fmt.num;
  }
  function toDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === "string" && /^\d{4}-\d{2}/.test(v)) {
      // Date-only strings are local dates (new Date("2026-01-15") would be UTC).
      var d = new Date(/^\d{4}-\d{2}$/.test(v) ? v + "-01T00:00:00" : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00" : v);
      return isNaN(d) ? null : d;
    }
    return null;
  }

  // ---- small DOM helpers --------------------------------------------------
  function host(el) {
    var node = typeof el === "string" ? document.querySelector(el) : el;
    if (!node) throw new Error("og: element not found: " + el);
    return node;
  }
  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function s(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function get(row, key) { return typeof key === "function" ? key(row) : row == null ? undefined : row[key]; }
  function empty(node, o) {
    node.replaceChildren(h("div", "og-empty", (o && o.empty) || "No data yet"));
  }
  function color(i, muted) { return muted ? "var(--og-series-muted)" : "var(--og-series-" + ((i % 6) + 1) + ")"; }
  // Series list from options: [{key, label, color?}].
  function seriesOf(o) {
    var list = o.series || [{ key: o.value || o.y, label: o.valueLabel || o.yLabel || "" }];
    var quiet = 0;
    return list.map(function (x, i) {
      var it = typeof x === "string" ? { key: x, label: x } : x;
      var hl = o.highlight != null && (o.highlight === it.label || o.highlight === it.key);
      // Around a highlight the others are grey; every second one is a darker,
      // dashed grey so they stay apart.
      var muted = o.highlight != null && !hl, dash = muted && quiet++ % 2 === 1;
      var c = it.color || (muted ? (dash ? "var(--og-fg-subtle)" : color(i, true)) : color(hl ? 0 : i));
      return { key: it.key, label: it.label != null ? it.label : String(it.key), color: c, hl: hl, dash: dash };
    });
  }
  function legend(series) {
    var box = h("div", "og-legend");
    series.forEach(function (x) {
      var item = h("span", "og-legend-item");
      var sw = h("span", "og-swatch" + (x.dash ? " og-swatch-dash" : ""));
      sw.style[x.dash ? "borderColor" : "background"] = x.color;
      item.append(sw, document.createTextNode(x.label));
      if (x.hl) item.style.fontWeight = "600";
      box.appendChild(item);
    });
    return box;
  }
  var canvas;
  // Chart text is 0.75rem (ui.css), so it follows the reader's text size.
  function textWidth(t) {
    canvas = canvas || document.createElement("canvas");
    var c = canvas.getContext("2d");
    var px = 0.75 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    c.font = px + "px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
    return c.measureText(String(t)).width;
  }
  function niceStep(span, count) {
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = (count / span) * step;
    if (err <= 0.15) step *= 10; else if (err <= 0.35) step *= 5; else if (err <= 0.75) step *= 2;
    return step;
  }
  // Rounded domain and ticks covering [lo, hi], with a little room so no
  // mark sits on the frame.
  function nice(lo, hi, count, zero) {
    var room = (hi - lo) * 0.06;
    if (!(zero && lo >= 0)) lo -= room;
    hi += room;
    if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (lo === hi) { var pad = Math.abs(lo) * 0.1 || 1; lo -= pad; hi += pad; }
    var step = niceStep(hi - lo, count);
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    var ticks = [];
    for (var v = a; v <= b + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo: a, hi: b, ticks: ticks };
  }
  function tooltip(node) {
    var tip = node.querySelector(":scope > .og-tip");
    if (!tip) { tip = h("div", "og-tip"); tip.hidden = true; tip.setAttribute("aria-hidden", "true"); node.appendChild(tip); }
    return {
      show: function (lines, x, y) {
        tip.replaceChildren();
        lines.forEach(function (l, i) {
          var row = h("div", i === 0 ? "og-tip-title" : "og-tip-row");
          if (l.color) { var sw = h("span", "og-swatch"); sw.style.background = l.color; row.appendChild(sw); }
          row.appendChild(document.createTextNode(l.text));
          tip.appendChild(row);
        });
        tip.hidden = false;
        var w = tip.offsetWidth, W = node.clientWidth;
        tip.style.left = Math.max(0, Math.min(W - w, x + 12)) + "px";
        tip.style.top = Math.max(0, y - tip.offsetHeight - 8) + "px";
      },
      hide: function () { tip.hidden = true; },
    };
  }
  // Redraw on width changes.
  function responsive(node, draw) {
    node.classList.add("og-chart");
    var last = -1;
    var run = function () { var w = node.clientWidth; if (w && w !== last) { last = w; draw(w); } };
    if (window.ResizeObserver) new window.ResizeObserver(run).observe(node);
    else window.addEventListener("resize", run);
    run();
    if (last <= 0) requestAnimationFrame(run);
  }

  // ---- KPI cards ----------------------------------------------------------
  // items: [{label, value, format, delta, deltaUnit, better, deltaLabel, note}]
  function kpis(el, items) {
    var node = host(el);
    node.classList.add("og-kpis");
    node.replaceChildren();
    items.forEach(function (it) {
      var card = h("div", "og-kpi" + (it.highlight ? " og-kpi-highlight" : ""));
      card.appendChild(h("div", "og-kpi-label", it.label));
      var value = it.value == null ? DASH : typeof it.value === "string" ? it.value : format(it.format)(it.value);
      card.appendChild(h("div", "og-kpi-value", value));
      if (it.delta != null) {
        var d = typeof it.delta === "object" ? it.delta : fmt.delta(it.delta, { unit: it.deltaUnit, better: it.better, digits: it.deltaDigits });
        var line = h("div", "og-kpi-delta og-" + d.tone, d.text);
        if (it.deltaLabel) line.appendChild(h("span", "og-kpi-delta-label", " " + it.deltaLabel));
        card.appendChild(line);
      }
      if (it.note) card.appendChild(h("div", "og-kpi-note", it.note));
      node.appendChild(card);
    });
    return node;
  }

  // ---- horizontal bars (HTML, so labels never collide) ---------------------
  // {data, label, value | series, format, sort, highlight, ci:[lowKey, highKey], max, empty}
  function bars(el, o) {
    var node = host(el);
    var data = (o.data || []).slice();
    if (!data.length) return empty(node, o);
    var series = seriesOf(o);
    var f = format(o.format);
    if (o.sort !== false && series.length === 1) {
      var dir = o.sort === "asc" ? 1 : -1;
      data.sort(function (a, b) {
        var x = get(a, series[0].key), y = get(b, series[0].key);
        if (!isNum(x) || !isNum(y)) return isNum(x) ? -1 : isNum(y) ? 1 : 0;
        return dir * (x - y);
      });
    }
    var vals = [];
    data.forEach(function (r) {
      series.forEach(function (x) { var v = get(r, x.key); if (isNum(v)) vals.push(v); });
      if (o.ci) { var lo = get(r, o.ci[0]), hi = get(r, o.ci[1]); if (isNum(lo)) vals.push(lo); if (isNum(hi)) vals.push(hi); }
    });
    var min = Math.min(0, Math.min.apply(null, vals)), max = o.max != null ? o.max : Math.max(0, Math.max.apply(null, vals));
    var span = max - min || 1, zero = (0 - min) / span;
    node.classList.add("og-chart");
    var wrap = h("div", "og-bars" + (min < 0 ? " og-bars-neg" : "") + (series.length > 1 ? " og-bars-multi" : ""));
    wrap.setAttribute("role", "list");
    if (o.title) wrap.setAttribute("aria-label", o.title);
    data.forEach(function (r) {
      var name = String(get(r, o.label || "label"));
      var rowHl = o.highlight != null && (typeof o.highlight === "function" ? o.highlight(r) : o.highlight === name);
      var lab = h("div", "og-bars-label" + (rowHl ? " og-strong" : ""), name);
      lab.title = name;
      lab.setAttribute("aria-hidden", "true");
      var cell = h("div", "og-bars-cell");
      cell.setAttribute("role", "listitem");
      var aria = [name];
      series.forEach(function (x, i) {
        var v = get(r, x.key);
        var track = h("div", "og-bars-track");
        if (isNum(v)) {
          var a = Math.min(zero, (v - min) / span), b = Math.max(zero, (v - min) / span);
          var bar = h("div", "og-bars-bar");
          bar.style.left = a * 100 + "%";
          bar.style.width = (b - a) * 100 + "%";
          var muted = o.highlight != null && series.length === 1 && !rowHl;
          // With better: "higher" | "lower", a bar on the bad side of zero is red.
          var bad = o.better && (o.better === "higher" ? v < 0 : v > 0);
          bar.style.background = series.length === 1 ? (muted ? color(0, true) : bad && min < 0 ? "var(--og-danger)" : color(0)) : x.color;
          track.appendChild(bar);
          if (o.ci && series.length === 1) {
            var lo = get(r, o.ci[0]), hi = get(r, o.ci[1]);
            if (isNum(lo) && isNum(hi)) {
              var ci = h("div", "og-bars-ci");
              ci.style.left = ((lo - min) / span) * 100 + "%";
              ci.style.width = ((hi - lo) / span) * 100 + "%";
              ci.title = "95% interval " + f(lo) + " to " + f(hi);
              track.appendChild(ci);
            }
          }
          var val = h("span", "og-bars-value", f(v));
          if (v < 0) val.style.right = "calc(" + (1 - a) * 100 + "% + 6px)";
          else val.style.left = "calc(" + Math.max(b, o.ci ? (get(r, o.ci[1]) - min) / span || 0 : 0) * 100 + "% + 6px)";
          track.appendChild(val);
        } else {
          track.appendChild(h("span", "og-bars-value og-bars-missing", (o.missing || DASH)));
        }
        aria.push((x.label ? x.label + " " : "") + f(v));
        cell.appendChild(track);
      });
      cell.setAttribute("aria-label", aria.join(", "));
      wrap.append(lab, cell);
    });
    node.replaceChildren();
    if (series.length > 1) node.appendChild(legend(series));
    node.appendChild(wrap);
    return node;
  }

  // ---- shared axes for line and scatter -----------------------------------
  function frame(node, w, o, xs, ys) {
    var narrow = w < 480;
    var H = o.height || (narrow ? 220 : 260);
    var yt = nice(Math.min.apply(null, ys), Math.max.apply(null, ys), narrow ? 4 : 5, o.zero);
    var yf = tickFormat(o.yFormat || o.format, yt.ticks);
    var left = Math.ceil(Math.max.apply(null, yt.ticks.map(function (t) { return textWidth(yf(t)); }))) + 10;
    var pad = { l: Math.max(left, 28), r: 12, t: o.yLabel || o.better ? 26 : 8, b: o.xLabel ? 44 : 26 };
    var svg = s("svg", { width: w, height: H, viewBox: "0 0 " + w + " " + H, role: o.focusable ? "group" : "img" });
    if (o.title) s("title", {}, svg).textContent = o.title;
    var X = function (v) { return pad.l + ((v - xs.lo) / (xs.hi - xs.lo || 1)) * (w - pad.l - pad.r); };
    var Y = function (v) { return H - pad.b - ((v - yt.lo) / (yt.hi - yt.lo || 1)) * (H - pad.t - pad.b); };
    yt.ticks.forEach(function (t) {
      s("line", { x1: pad.l, x2: w - pad.r, y1: Y(t), y2: Y(t), class: "og-gridline" }, svg);
      var tx = s("text", { x: pad.l - 8, y: Y(t), "text-anchor": "end", "dominant-baseline": "middle" }, svg);
      tx.textContent = yf(t);
    });
    if (o.yLabel) {
      var yl = s("text", { x: 0, y: 12, class: "og-axis-title" }, svg);
      yl.textContent = o.yLabel;
    }
    // Which way is better, above the plot so it never covers a mark.
    if (o.better && (o.better.x || o.better.y)) {
      var arrow = { "higher,higher": "\u2197", "lower,higher": "\u2196", "higher,lower": "\u2198", "lower,lower": "\u2199" }[o.better.x + "," + o.better.y] ||
        (o.better.x === "lower" ? "\u2190" : o.better.x === "higher" ? "\u2192" : o.better.y === "lower" ? "\u2193" : "\u2191");
      var bt = s("text", { x: w - pad.r, y: 12, "text-anchor": "end", class: "og-better" }, svg);
      bt.textContent = arrow + " " + (o.better.text || "better");
    }
    if (o.xLabel) {
      var xl = s("text", { x: w - pad.r, y: H - 4, "text-anchor": "end", class: "og-axis-title" }, svg);
      xl.textContent = o.xLabel;
    }
    return { svg: svg, X: X, Y: Y, H: H, pad: pad, w: w, narrow: narrow };
  }
  // Ticks are round numbers: drop decimals they don't need ("40%", not "40.0%").
  function tickFormat(f, ticks) {
    var base = format(f);
    var name = typeof f === "string" ? f : f && typeof f === "object" ? f.type : null;
    if ((name === "pct" || name === "num") && ticks.every(function (t) { return Math.abs(t % 1) < 1e-9; }))
      return function (v) { return fmt[name](v, { digits: 0 }); };
    return base;
  }
  function xTicks(fr, ticks, label) {
    // Keep only ticks whose labels fit side by side. The first tick and
    // labels carrying a year ("Jan 2026") are placed first, so they survive.
    var cand = ticks.map(function (t, i) {
      var txt = label(t), tw = textWidth(txt), x = fr.X(t.v != null ? t.v : t);
      var anchor = "middle", start = x - tw / 2;
      if (start < fr.pad.l - 4) { anchor = "start"; start = x; }
      if (x + tw / 2 > fr.w) { anchor = "end"; start = x - tw; }
      return { txt: txt, x: x, anchor: anchor, a: start, b: start + tw, p: i === 0 || /\d{4}/.test(txt) ? 0 : 1, i: i };
    });
    var placed = [];
    cand.slice().sort(function (m, n) { return m.p - n.p || m.i - n.i; }).forEach(function (c) {
      if (placed.some(function (q) { return c.a < q.b + 8 && c.b > q.a - 8; })) return;
      placed.push(c);
      var el = s("text", { x: c.x, y: fr.H - fr.pad.b + 16, "text-anchor": c.anchor }, fr.svg);
      el.textContent = c.txt;
    });
  }

  // ---- line chart ----------------------------------------------------------
  // {data, x, y | series, format, xFormat, highlight, refs:[{value,label}], zero, area, height}
  function line(el, o) {
    var node = host(el);
    var data = (o.data || []).slice();
    if (!data.length) return empty(node, o);
    var series = seriesOf(o);
    // Plot in x order, whatever order the rows came in.
    if (data.every(function (r) { return isNum(get(r, o.x)); })) data.sort(function (a, b) { return get(a, o.x) - get(b, o.x); });
    else if (data.every(function (r) { return toDate(get(r, o.x)); })) data.sort(function (a, b) { return toDate(get(a, o.x)) - toDate(get(b, o.x)); });
    var xv = data.map(function (r) { return get(r, o.x); });
    var numericX = xv.every(isNum);
    var pos = function (i) { return numericX ? xv[i] : i; };
    var xfmt = o.xFormat ? format(o.xFormat) : numericX ? fmt.num : autoDate(xv);
    var yf = format(o.yFormat || o.format);
    var ys = [];
    data.forEach(function (r) { series.forEach(function (x) { var v = get(r, x.key); if (isNum(v)) ys.push(v); }); });
    var refs = (o.refs || []).filter(function (rf) { return isNum(rf.value); });
    refs.forEach(function (rf) { ys.push(rf.value); });
    if (!ys.length) return empty(node, o);
    var tip = null;
    var head = series.length > 1 ? legend(series) : null;
    var body = h("div");
    node.replaceChildren();
    if (head) node.appendChild(head);
    node.appendChild(body);
    body.style.position = "relative";
    tip = tooltip(body);
    responsive(body, function (w) {
      var xs = { lo: pos(0), hi: pos(data.length - 1) };
      var fr = frame(body, w, Object.assign({ zero: false }, o), xs, ys);
      var idx = data.map(function (_, i) { return { v: pos(i), i: i }; });
      xTicks(fr, idx, function (t) { return xfmt(xv[t.i]); });
      refs.forEach(function (rf) {
        s("line", { x1: fr.pad.l, x2: w - fr.pad.r, y1: fr.Y(rf.value), y2: fr.Y(rf.value), class: "og-ref" }, fr.svg);
        var t = s("text", { x: w - fr.pad.r, y: fr.Y(rf.value) - 4, "text-anchor": "end", class: "og-ref-label" }, fr.svg);
        t.textContent = rf.label || yf(rf.value);
      });
      var order = series.map(function (x, i) { return i; }).sort(function (a, b) { return series[a].hl - series[b].hl; });
      order.forEach(function (si) {
        var x = series[si], d = "", up = false, lone = [];
        data.forEach(function (r, i) {
          var v = get(r, x.key);
          if (!isNum(v)) { up = false; return; }
          // A point with no neighbour on either side gets a dot, or it would be invisible.
          var prev = i > 0 && isNum(get(data[i - 1], x.key)), next = i < data.length - 1 && isNum(get(data[i + 1], x.key));
          if (!prev && !next) lone.push([fr.X(pos(i)), fr.Y(v)]);
          d += (up ? "L" : "M") + fr.X(pos(i)).toFixed(1) + "," + fr.Y(v).toFixed(1);
          up = true;
        });
        if (o.area && series.length === 1) {
          var base = fr.Y(Math.max(0, Math.min.apply(null, ys)));
          s("path", { d: d + "L" + fr.X(pos(data.length - 1)) + "," + base + "L" + fr.X(pos(0)) + "," + base + "Z", class: "og-area", style: "fill:" + x.color }, fr.svg);
        }
        s("path", { d: d, class: "og-line" + (x.hl ? " og-line-hl" : "") + (x.dash ? " og-line-dash" : ""), style: "stroke:" + x.color }, fr.svg);
        lone.forEach(function (p) { s("circle", { cx: p[0], cy: p[1], r: 3.5, class: "og-dot", style: "fill:" + x.color }, fr.svg); });
      });
      var guide = s("line", { y1: fr.pad.t, y2: fr.H - fr.pad.b, class: "og-guide", visibility: "hidden" }, fr.svg);
      var hit = s("rect", { x: fr.pad.l, y: 0, width: Math.max(0, w - fr.pad.l - fr.pad.r), height: fr.H, fill: "transparent" }, fr.svg);
      var move = function (ev) {
        var r = fr.svg.getBoundingClientRect();
        var px = ev.clientX - r.left, best = 0, bd = Infinity;
        data.forEach(function (_, i) { var dd = Math.abs(fr.X(pos(i)) - px); if (dd < bd) { bd = dd; best = i; } });
        var gx = fr.X(pos(best));
        guide.setAttribute("x1", gx); guide.setAttribute("x2", gx); guide.setAttribute("visibility", "visible");
        tip.show([{ text: xfmt(xv[best]) }].concat(series.map(function (x) { return { color: x.color, text: (x.label ? x.label + ": " : "") + yf(get(data[best], x.key)) }; })), gx, ev.clientY - r.top);
      };
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerdown", move);
      hit.addEventListener("pointerleave", function () { guide.setAttribute("visibility", "hidden"); tip.hide(); });
      fr.svg.setAttribute("aria-label", o.title || series.map(function (x) { return x.label; }).join(", ") + " over " + xfmt(xv[0]) + " to " + xfmt(xv[xv.length - 1]));
      body.replaceChildren(fr.svg);
      tip = tooltip(body);
    });
    return node;
  }
  function autoDate(xv) {
    var ds = xv.map(toDate);
    if (!ds.every(Boolean)) return function (v) { return String(v); };
    var span = ds[ds.length - 1] - ds[0];
    if (xv.every(function (v) { return /^\d{4}-\d{2}$/.test(v); }))
      // Year on the first month and on January only.
      return function (v) { var d = toDate(v); return fmt.month(v, { short: !(v === xv[0] || (d && d.getMonth() === 0)) }); };
    if (span <= 2 * 86400000) return fmt.time;
    return function (v) { return fmt.date(v); };
  }

  // ---- scatter -------------------------------------------------------------
  // {data, x, y, label, group, xFormat, yFormat, xLabel, yLabel, better:{x,y}, highlight, ci:[lo,hi]}
  function scatter(el, o) {
    var node = host(el);
    var data = (o.data || []).filter(function (r) { return isNum(get(r, o.x)) && isNum(get(r, o.y)); });
    if (!data.length) return empty(node, o);
    var groups = [];
    data.forEach(function (r) { var g = o.group ? String(get(r, o.group)) : ""; if (groups.indexOf(g) < 0) groups.push(g); });
    // highlight names a group (mute the others) or one point (by label, or row => boolean).
    var hlGroup = o.highlight != null && typeof o.highlight !== "function" && groups.indexOf(String(o.highlight)) >= 0;
    var gs = seriesOf({ series: groups.map(function (g) { return { key: g, label: g }; }), highlight: hlGroup ? o.highlight : null });
    var gcol = {}; gs.forEach(function (g) { gcol[g.key] = g; });
    var xf = format(o.xFormat || "num"), yf = format(o.yFormat || o.format);
    var xsv = data.map(function (r) { return get(r, o.x); });
    var ysv = [];
    data.forEach(function (r) {
      ysv.push(get(r, o.y));
      if (o.ci) { var lo = get(r, o.ci[0]), hi = get(r, o.ci[1]); if (isNum(lo)) ysv.push(lo); if (isNum(hi)) ysv.push(hi); }
    });
    node.replaceChildren();
    if (o.group) node.appendChild(legend(gs));
    var body = h("div");
    body.style.position = "relative";
    node.appendChild(body);
    responsive(body, function (w) {
      var xt = nice(Math.min.apply(null, xsv), Math.max.apply(null, xsv), w < 480 ? 3 : 5, o.zeroX);
      var fr = frame(body, w, Object.assign({ focusable: true }, o), xt, ysv);
      xt.ticks.forEach(function (t) { s("line", { x1: fr.X(t), x2: fr.X(t), y1: fr.pad.t, y2: fr.H - fr.pad.b, class: "og-gridline og-grid-x" }, fr.svg); });
      xTicks(fr, xt.ticks, tickFormat(o.xFormat || "num", xt.ticks));
      var placed = [];
      var tip = null;
      var marks = data.map(function (r) {
        var g = gcol[o.group ? String(get(r, o.group)) : ""];
        var rowHl = o.highlight != null && (typeof o.highlight === "function" ? !!o.highlight(r) : hlGroup ? g.hl : String(o.highlight) === String(get(r, o.label)));
        var c = o.group ? g.color : o.highlight != null && !rowHl ? color(0, true) : color(0);
        return { r: r, x: fr.X(get(r, o.x)), y: fr.Y(get(r, o.y)), c: c, hl: rowHl };
      });
      marks.sort(function (a, b) { return a.hl - b.hl; });
      marks.forEach(function (m) {
        if (o.ci) {
          var lo = get(m.r, o.ci[0]), hi = get(m.r, o.ci[1]);
          if (isNum(lo) && isNum(hi)) s("line", { x1: m.x, x2: m.x, y1: fr.Y(lo), y2: fr.Y(hi), class: "og-whisker", style: "stroke:" + m.c }, fr.svg);
        }
        var dot = s("circle", { cx: m.x, cy: m.y, r: m.hl ? 6 : 5, class: "og-dot" + (m.hl ? " og-dot-hl" : ""), style: "fill:" + m.c, tabindex: "0" }, fr.svg);
        var name = o.label ? String(get(m.r, o.label)) : "";
        var lines = [{ text: name || (o.group ? String(get(m.r, o.group)) : "") }, { text: (o.xLabel || "x") + ": " + xf(get(m.r, o.x)) }, { text: (o.yLabel || "y") + ": " + yf(get(m.r, o.y)) }];
        dot.setAttribute("aria-label", lines.map(function (l) { return l.text; }).join(", "));
        var show = function () { tip.show(lines, m.x, m.y); };
        var hide = function () { tip.hide(); };
        dot.addEventListener("pointerenter", show);
        dot.addEventListener("focus", show);
        dot.addEventListener("pointerleave", hide);
        dot.addEventListener("blur", hide);
        placed.push({ x1: m.x - 6, x2: m.x + 6, y1: m.y - 6, y2: m.y + 6 });
      });
      // Direct labels where they fit; the rest stay in the tooltip.
      if (o.label && o.labels !== false) {
        marks.slice().sort(function (a, b) { return b.hl - a.hl; }).forEach(function (m) {
          var txt = String(get(m.r, o.label)), tw = textWidth(txt), th = 14;
          var spots = [[m.x + 11, m.y + 4, "start"], [m.x - 11, m.y + 4, "end"], [m.x, m.y - 11, "middle"], [m.x, m.y + 19, "middle"]];
          for (var i = 0; i < spots.length; i++) {
            var sx = spots[i][0], sy = spots[i][1], an = spots[i][2];
            var x1 = an === "start" ? sx : an === "end" ? sx - tw : sx - tw / 2;
            if (an === "middle") {
              // Slide a centred label inward rather than lose it at an edge.
              x1 = Math.max(fr.pad.l + 3, Math.min(w - fr.pad.r - tw - 3, x1));
              sx = x1 + tw / 2;
            }
            var box = { x1: x1 - 3, x2: x1 + tw + 3, y1: sy - th + 3, y2: sy + 3 };
            if (box.x1 < fr.pad.l || box.x2 > w - fr.pad.r || box.y1 < fr.pad.t || box.y2 > fr.H - fr.pad.b) continue;
            if (placed.some(function (p) { return box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1; })) continue;
            placed.push(box);
            var t = s("text", { x: sx, y: sy, "text-anchor": an, class: "og-point-label" + (m.hl ? " og-strong" : "") }, fr.svg);
            t.textContent = txt;
            break;
          }
        });
      }
      fr.svg.setAttribute("aria-label", o.title || (o.yLabel || "y") + " against " + (o.xLabel || "x") + ", " + data.length + " points");
      body.replaceChildren(fr.svg);
      tip = tooltip(body);
    });
    return node;
  }

  // ---- table ---------------------------------------------------------------
  // {columns:[{key, label, format, align, bar, better, width}], rows, sort:{key, dir}, highlight, limit, empty}
  function table(el, o) {
    var node = host(el);
    var rows = (o.rows || []).slice();
    if (!rows.length) return empty(node, o);
    var cols = o.columns.map(function (c) { return typeof c === "string" ? { key: c, label: c } : c; });
    var state = { key: o.sort && o.sort.key, dir: (o.sort && o.sort.dir) || "desc", all: false };
    var best = {};
    cols.forEach(function (c) {
      if (!c.better) return;
      var vs = rows.map(function (r) { return get(r, c.key); }).filter(isNum);
      if (vs.length > 1) best[c.label || c.key] = c.better === "lower" ? Math.min.apply(null, vs) : Math.max.apply(null, vs);
    });
    var maxes = {};
    cols.forEach(function (c) { if (c.bar) maxes[c.key] = Math.max.apply(null, rows.map(function (r) { return Math.abs(get(r, c.key)) || 0; })) || 1; });
    function draw() {
      var list = rows.slice();
      if (state.key) {
        var sc = cols.filter(function (c) { return c.key === state.key; })[0] || { key: state.key };
        list.sort(function (a, b) {
          var x = get(a, sc.key), y = get(b, sc.key);
          if (x == null) return 1; if (y == null) return -1;
          var r = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
          return state.dir === "asc" ? r : -r;
        });
      }
      var limit = o.limit && !state.all ? o.limit : list.length;
      var wrap = h("div", "og-table-wrap");
      var t = h("table", "og-table");
      if (o.title) t.setAttribute("aria-label", o.title);
      var thead = h("thead"), tr = h("tr");
      cols.forEach(function (c) {
        var sample = rows.map(function (r) { return get(r, c.key); }).filter(function (v) { return v != null; })[0];
        var numeric = c.align ? c.align === "right" : isNum(sample) || !!c.format;
        c._num = numeric;
        c._wrap = !numeric && rows.some(function (r) { var v = get(r, c.key); return typeof v === "string" && v.length > 32; });
        var th = h("th", (numeric ? "og-num" : "") + (c._wrap ? " og-wrap" : "") + (c.optional ? " og-hide-narrow" : ""));
        th.scope = "col";
        if (c.width) th.style.width = c.width;
        if (o.sortable === false) th.textContent = c.label != null ? c.label : c.key;
        else {
          var b = h("button", "og-sort", c.label != null ? c.label : c.key);
          b.type = "button";
          if (state.key === c.key) th.setAttribute("aria-sort", state.dir === "asc" ? "ascending" : "descending");
          b.addEventListener("click", function () {
            state.dir = state.key === c.key && state.dir === "desc" ? "asc" : "desc";
            state.key = c.key;
            draw();
            var again = node.querySelector("th[aria-sort] .og-sort");
            if (again) again.focus();
          });
          th.appendChild(b);
        }
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      var tbody = h("tbody");
      list.slice(0, limit).forEach(function (r) {
        var hl = o.highlight == null ? false : typeof o.highlight === "function" ? o.highlight(r) : String(get(r, cols[0].key)) === String(o.highlight);
        var row = h("tr", hl ? "og-highlight" : "");
        cols.forEach(function (c, ci) {
          var v = get(r, c.key);
          var cell = h(ci === 0 ? "th" : "td", (c._num ? "og-num" : "") + (c._wrap ? " og-wrap" : "") + (c.optional ? " og-hide-narrow" : ""));
          if (ci === 0) cell.scope = "row";
          var text = typeof c.format === "function" ? c.format(v, r) : c.format ? format(c.format)(v) : v == null ? DASH : String(v);
          if (c.render) { var out = c.render(v, r); if (out instanceof Node) cell.appendChild(out); else cell.textContent = out; }
          else if (c.bar && isNum(v)) {
            var box = h("span", "og-cell-bar");
            var fill = h("span", "og-cell-bar-fill");
            fill.style.width = (Math.abs(v) / maxes[c.key]) * 100 + "%";
            box.appendChild(fill);
            cell.append(box, document.createTextNode(text));
          } else cell.textContent = text;
          if (c.better && isNum(v) && v === best[c.label || c.key]) cell.classList.add("og-best");
          if (c.tone) { var tone = c.tone(v, r); if (tone) cell.classList.add("og-" + tone); }
          row.appendChild(cell);
        });
        tbody.appendChild(row);
      });
      t.append(thead, tbody);
      wrap.appendChild(t);
      node.replaceChildren(wrap);
      if (limit < list.length) {
        var more = h("button", "og-button og-button-ghost og-more", "Show all " + list.length);
        more.type = "button";
        more.addEventListener("click", function () {
          state.all = true;
          draw();
          var first = node.querySelectorAll("tbody tr")[limit];
          if (first) { first.tabIndex = -1; first.focus(); }
        });
        node.appendChild(more);
      }
    }
    draw();
    return node;
  }

  window.og = { fmt: fmt, kpis: kpis, bars: bars, line: line, scatter: scatter, table: table };
})();
`;
