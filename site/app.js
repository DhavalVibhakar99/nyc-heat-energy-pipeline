/* HeatWatch NYC - public dashboard.
   Reads the JSON the daily pipeline exports (data/*.json) and renders everything client-side.
   Every label that comes from data is inserted with textContent, never innerHTML. */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const BANDS = ["1-25", "26-50", "51-75", "76-100"];
const BAND_LABEL = { "1-25": "1–25", "26-50": "26–50", "51-75": "51–75", "76-100": "76–100" };
const SIZES = [1, 2, 3, 4];
const SIZE_LABEL = { 1: "Smallest 25%", 2: "Small–mid", 3: "Mid–large", 4: "Largest 25%" };
const ERAS = ["pre-1930", "1930-59", "1960-89", "1990+"];
const ERA_LABEL = { "pre-1930": "Before 1930", "1930-59": "1930–59", "1960-89": "1960–89", "1990+": "1990 and later" };
const MIN_COMPLAINTS_RANKED = 3;

const state = {
  season: null, boro: "", split: "all", gfaMin: 50000, sort: "rate", lbAll: false,
  meta: null, daily: null, seasonBoro: null, mapCells: null, lots: {}, selected: null,
};

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const nf = new Intl.NumberFormat("en-US");
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const fmt = (n) => (n == null || Number.isNaN(n) ? "–" : nf.format(Math.round(n)));
const fmt1 = (n) => (n == null || !Number.isFinite(n) ? "–" : nf1.format(n));
const compact = (n) => {
  if (n == null) return "–";
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return nf.format(Math.round(n));
};
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const DAY = 864e5;
const toDate = (iso) => new Date(iso + "T00:00:00Z");
const fmtDate = (d, opts = { month: "short", day: "numeric", year: "numeric" }) =>
  d.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
function s(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (parent) parent.append(el);
  return el;
}
function txt(parent, x, y, str, cls = "lbl", anchor = "start", extra = {}) {
  const t = s("text", { x, y, class: cls, "text-anchor": anchor, ...extra }, parent);
  t.textContent = str;
  return t;
}
/** Nice round axis ticks from 0 to >= max. */
function ticks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw);
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
/** Column with a 4px rounded data-end and a square baseline. */
function columnPath(x, y, w, hgt) {
  if (hgt <= 0) return "";
  const r = Math.min(4, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

/* ---------- tooltip ---------- */
const tip = $("#tip");
function showTip(evt, title, rows) {
  tip.replaceChildren(h("div", { class: "tip-title" }, title),
    ...rows.map((r) => h("div", { class: "tip-row" },
      r.color ? h("i", { class: "key", style: `border-color:${r.color}` }) : null,
      h("strong", {}, r.value), h("span", {}, r.label))));
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, ht = tip.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
  if (y + ht > innerHeight - 8) y = evt.clientY - ht - pad;
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = Math.max(8, y) + "px";
}
const hideTip = () => { tip.hidden = true; };

/* ---------- data access ---------- */
async function getJSON(name) {
  const res = await fetch("data/" + name, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}
function rowsOf(col) {
  const keys = Object.keys(col), n = col[keys[0]]?.length ?? 0, out = new Array(n);
  for (let i = 0; i < n; i++) { const o = {}; for (const k of keys) o[k] = col[k][i]; out[i] = o; }
  return out;
}
async function loadLots(season) {
  if (!state.lots[season]) {
    const lots = rowsOf(await getJSON(`lots_${season}.json`));
    for (const l of lots) l.rate = l.gfa > 0 ? (l.no_heat / l.gfa) * 1e5 : null;
    state.lots[season] = lots;
  }
  return state.lots[season];
}
const seasonInfo = (season) => state.meta.seasons.find((x) => x.season === season);
function seasonBounds(season) {
  const y = +season.slice(0, 4);
  return { start: Date.UTC(y, 9, 1), end: Date.UTC(y + 1, 4, 31) };
}
const prevSeason = (season) => {
  const y = +season.slice(0, 4) - 1;
  return `${y}-${String(y + 1).slice(2)}`;
};
const seasonLabel = (season) => season.replace("-", "–");
const boroOK = (b) => !state.boro || b === state.boro;

/** No-heat complaints per day (ms -> count) for the current borough filter. */
function dailyMap() {
  const m = new Map();
  for (const r of state.daily) {
    if (!boroOK(r.boro)) continue;
    const t = toDate(r.d).getTime();
    m.set(t, (m.get(t) || 0) + r.no_heat);
  }
  return m;
}
function sumRange(dm, from, to) {
  let n = 0;
  for (let t = from; t <= to; t += DAY) n += dm.get(t) || 0;
  return n;
}

/* ---------- KPIs ---------- */
function renderKPIs(lots, dm) {
  const { start, end } = seasonBounds(state.season);
  const through = toDate(state.meta.data_through).getTime();
  const dataStart = state.dataStart;
  const upto = Math.min(end, through);
  const inProgress = through < end;
  const cur = sumRange(dm, start, upto);
  $("#k-complaints").textContent = fmt(cur);

  // same window one season earlier, if the data reaches back that far
  const pStart = seasonBounds(prevSeason(state.season)).start;
  const pUpto = pStart + (upto - start);
  const delta = $("#k-complaints-delta");
  delta.replaceChildren();
  if (pStart >= dataStart) {
    const prev = sumRange(dm, pStart, pUpto);
    if (prev > 0) {
      const pct = ((cur - prev) / prev) * 100;
      const up = pct >= 0;
      delta.append(h("strong", { class: up ? "up" : "down" }, `${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%`),
        ` vs ${inProgress ? "same point " : ""}${seasonLabel(prevSeason(state.season))}`);
    }
  } else {
    delta.append(inProgress ? `Season to date, through ${fmtDate(new Date(upto), { month: "short", day: "numeric" })}` : "First season in the data");
  }
  renderSpark(dm, start, upto);

  const sb = state.seasonBoro.find((r) => r.season === state.season && r.boro === (state.boro || "All"));
  $("#k-buildings").textContent = sb ? fmt(sb.buildings) : "–";
  const flagged = lots.filter((l) => boroOK(l.boro) && l.no_heat > 0).length;
  $("#k-buildings-sub").textContent = sb ? `${fmt(flagged)} of them are large, benchmarked buildings` : "";

  const hrs = sb?.median_close_hours;
  $("#k-close").textContent = hrs == null ? "–" : hrs < 48 ? `${fmt1(hrs)} hrs` : `${fmt1(hrs / 24)} days`;
  $("#k-close-sub").textContent = sb ? `across ${fmt(sb.closed)} closed complaints` : "";

  const onLots = lots.reduce((n, l) => n + (boroOK(l.boro) ? l.no_heat : 0), 0);
  const total = sumRange(dm, start, end);
  $("#k-share").textContent = total ? `${Math.round((onLots / total) * 100)}%` : "–";
  $("#k-share-sub").textContent = `${fmt(onLots)} complaints in LL84 apartment buildings`;
}

function renderSpark(dm, start, upto) {
  const svg = $("#k-spark");
  svg.replaceChildren();
  const weeks = weekly(dm, start, upto, false);
  if (weeks.length < 2) return;
  const W = 96, H = 36, max = Math.max(...weeks.map((w) => w.v), 1);
  const pts = weeks.map((w, i) => [(i / (weeks.length - 1)) * W, H - (w.v / max) * (H - 4) - 2]);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  s("path", { d: "M" + pts.map((p) => p.join(",")).join("L"), fill: "none", stroke: cssVar("--accent"),
    "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
  const last = pts[pts.length - 1];
  s("circle", { cx: last[0], cy: last[1], r: 3.5, fill: cssVar("--accent"), stroke: cssVar("--surface"), "stroke-width": 2 }, svg);
}

/** Weekly totals from a season start. Drops a trailing partial week unless keepPartial. */
function weekly(dm, start, upto, keepPartial = true) {
  const out = [];
  for (let w = 0; start + w * 7 * DAY <= upto; w++) {
    const from = start + w * 7 * DAY, to = Math.min(from + 6 * DAY, upto);
    const partial = to < from + 6 * DAY;
    if (partial && !keepPartial) break;
    out.push({ w, from, to, v: sumRange(dm, from, to), partial });
  }
  return out;
}

/* ---------- trend chart ---------- */
function renderTrend(dm) {
  const host = $("#trend-chart");
  host.replaceChildren();
  const { start, end } = seasonBounds(state.season);
  const through = toDate(state.meta.data_through).getTime();
  const cur = weekly(dm, start, Math.min(end, through), false);
  const ps = prevSeason(state.season), pb = seasonBounds(ps);
  const prev = pb.start >= state.dataStart ? weekly(dm, pb.start, Math.min(pb.end, through), true) : [];

  const series = [
    { name: seasonLabel(state.season), pts: cur, color: cssVar("--accent"), main: true },
    ...(prev.length ? [{ name: seasonLabel(ps), pts: prev, color: cssVar("--compare") }] : []),
  ];
  const legend = $("#trend-legend");
  legend.replaceChildren(...(series.length > 1 ? series.map((sr) =>
    h("li", {}, h("i", { class: "key", style: `border-color:${sr.color}` }), sr.name)) : []));
  $("#trend-sub").textContent = series.length > 1
    ? `No-heat complaints per week from October 1, compared with the season before.`
    : `No-heat complaints per week from October 1.`;

  const W = host.clientWidth || 600, H = W < 520 ? 220 : 280;
  const m = { l: 44, r: 16, t: 12, b: 28 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const nWeeks = Math.ceil((end - start) / (7 * DAY));
  const max = Math.max(1, ...series.flatMap((sr) => sr.pts.map((p) => p.v)));
  const yt = ticks(max);
  const x = (w) => m.l + (w / (nWeeks - 1)) * iw;
  const y = (v) => m.t + ih - (v / yt[yt.length - 1]) * ih;

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img",
    "aria-label": `Weekly no-heat complaints, ${series.map((sr) => sr.name).join(" vs ")}` }, host);
  const g = s("g", { class: "axis" }, svg);
  for (const v of yt) {
    s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? "baseline" : "gridline" }, g);
    txt(g, m.l - 8, y(v) + 4, compact(v), "lbl", "end");
  }
  // month starts on the x axis
  const sy = new Date(start).getUTCFullYear();
  for (let i = 0; i < 8; i++) {
    const t = Date.UTC(sy, 9 + i, 1), w = (t - start) / (7 * DAY);
    if (W < 520 && i % 2) continue;
    txt(g, x(w), H - 8, fmtDate(new Date(t), { month: "short" }), "lbl", i === 0 ? "start" : "middle");
  }
  if (!cur.length) {
    txt(svg, m.l + iw / 2, m.t + ih / 2, "Not enough data yet this season", "lbl", "middle");
  }

  // area wash + lines, the compared season underneath
  for (const sr of [...series].reverse()) {
    if (sr.pts.length < 1) continue;
    const d = sr.pts.map((p, i) => `${i ? "L" : "M"}${x(p.w)},${y(p.v)}`).join("");
    if (sr.main && sr.pts.length > 1) {
      s("path", { d: `${d}L${x(sr.pts[sr.pts.length - 1].w)},${y(0)}L${x(sr.pts[0].w)},${y(0)}Z`,
        fill: sr.color, "fill-opacity": 0.1 }, svg);
    }
    s("path", { d, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
  }
  // end dot + value on the main series
  const last = cur[cur.length - 1];
  if (last) {
    s("circle", { cx: x(last.w), cy: y(last.v), r: 4, fill: series[0].color, stroke: cssVar("--surface"), "stroke-width": 2 }, svg);
  }

  // crosshair
  const cross = s("line", { y1: m.t, y2: m.t + ih, stroke: cssVar("--axis"), "stroke-width": 1, visibility: "hidden" }, svg);
  const dots = series.map((sr) => s("circle", { r: 4, fill: sr.color, stroke: cssVar("--surface"), "stroke-width": 2, visibility: "hidden" }, svg));
  const hit = s("rect", { x: m.l, y: m.t, width: iw, height: ih, class: "hit" }, svg);
  const move = (evt) => {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    const w = Math.max(0, Math.min(nWeeks - 1, Math.round(((px - m.l) / iw) * (nWeeks - 1))));
    const pts = series.map((sr) => sr.pts.find((p) => p.w === w));
    if (!pts.some(Boolean)) return hideTip();
    cross.setAttribute("x1", x(w)); cross.setAttribute("x2", x(w)); cross.setAttribute("visibility", "visible");
    pts.forEach((p, i) => {
      dots[i].setAttribute("visibility", p ? "visible" : "hidden");
      if (p) { dots[i].setAttribute("cx", x(w)); dots[i].setAttribute("cy", y(p.v)); }
    });
    const ref = pts[0] || pts[1];
    const from = new Date(start + w * 7 * DAY), to = new Date(start + w * 7 * DAY + 6 * DAY);
    showTip(evt, `Week of ${fmtDate(from, { month: "short", day: "numeric" })} – ${fmtDate(to, { month: "short", day: "numeric" })}`,
      series.map((sr, i) => ({ color: sr.color, value: pts[i] ? fmt(pts[i].v) : "–", label: sr.name })));
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip(); });

  // table view
  const tbl = h("table", { class: "table" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Week of"), ...series.map((sr) => h("th", { scope: "col", class: "num" }, sr.name)))),
    h("tbody", {}, ...Array.from({ length: nWeeks }, (_, w) => {
      const vals = series.map((sr) => sr.pts.find((p) => p.w === w));
      if (!vals.some(Boolean)) return null;
      return h("tr", {}, h("td", {}, fmtDate(new Date(start + w * 7 * DAY), { month: "short", day: "numeric" })),
        ...vals.map((p) => h("td", { class: "num" }, p ? fmt(p.v) : "–")));
    })));
  $("#trend-table").replaceChildren(h("div", { class: "table-wrap" }, tbl));
}

/* ---------- efficiency ---------- */
function pooled(lots) {
  const by = {};
  for (const b of BANDS) by[b] = { band: b, lots: 0, complaints: 0, gfa: 0 };
  for (const l of lots) {
    const c = by[l.band];
    if (!c) continue;
    c.lots++; c.complaints += l.no_heat; c.gfa += l.gfa;
  }
  for (const c of Object.values(by)) c.rate = c.gfa > 0 ? (c.complaints / c.gfa) * 1e5 : null;
  return BANDS.map((b) => by[b]);
}

function renderEfficiency(lots) {
  const scored = lots.filter((l) => l.score != null && l.band && boroOK(l.boro) && l.gfa > 0);
  const groups = state.split === "all"
    ? [{ key: "all", label: "All benchmarked apartment buildings", rows: scored }]
    : (state.split === "size_q" ? SIZES : ERAS).map((k) => ({
      key: k, label: state.split === "size_q" ? SIZE_LABEL[k] : ERA_LABEL[k],
      rows: scored.filter((l) => l[state.split] === k),
    }));
  for (const g of groups) { g.cells = pooled(g.rows); g.n = g.rows.length; }

  const host = $("#eff-chart");
  host.replaceChildren();
  host.className = "multiples" + (groups.length > 1 ? " four" : "");
  const max = Math.max(0.0001, ...groups.flatMap((g) => g.cells.map((c) => c.rate || 0)));
  const yt = ticks(max, groups.length > 1 ? 3 : 4);
  const accent = cssVar("--accent");

  for (const g of groups) {
    const box = h("div", {});
    if (groups.length > 1) box.append(h("p", { class: "mult-title" }, g.label, h("span", {}, ` · ${fmt(g.n)} buildings`)));
    host.append(box);
    const W = box.clientWidth || 260, H = groups.length > 1 ? 190 : (W < 520 ? 220 : 260);
    const m = { l: 36, r: 8, t: groups.length > 1 ? 8 : 22, b: 26 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const slot = iw / BANDS.length, bw = Math.min(groups.length > 1 ? 24 : 28, slot * 0.6);
    const y = (v) => m.t + ih - (v / yt[yt.length - 1]) * ih;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img",
      "aria-label": `${g.label}: complaints per 100,000 sq ft by ENERGY STAR band` }, box);
    const ax = s("g", { class: "axis" }, svg);
    for (const v of yt) {
      s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? "baseline" : "gridline" }, ax);
      txt(ax, m.l - 6, y(v) + 4, v % 1 ? v.toFixed(1) : String(v), "lbl", "end");
    }
    g.cells.forEach((c, i) => {
      const cx = m.l + slot * i + slot / 2;
      txt(ax, cx, H - 8, BAND_LABEL[c.band], "lbl", "middle");
      if (c.rate == null) return;
      const top = y(c.rate);
      const bar = s("path", { d: columnPath(cx - bw / 2, top, bw, y(0) - top), class: "bar", fill: accent }, svg);
      if (groups.length === 1) txt(svg, cx, top - 8, c.rate.toFixed(2), "lbl-strong", "middle");
      const hit = s("rect", { x: m.l + slot * i, y: m.t, width: slot, height: ih, class: "hit", tabindex: 0,
        "aria-label": `ENERGY STAR ${BAND_LABEL[c.band]}: ${c.rate.toFixed(2)} complaints per 100,000 sq ft, ${c.lots} buildings` }, svg);
      const on = (evt) => {
        bar.classList.add("on");
        const r = evt.clientX ? evt : (() => { const b = hit.getBoundingClientRect(); return { clientX: b.left + b.width / 2, clientY: b.top }; })();
        showTip(r, `${g.label} · score ${BAND_LABEL[c.band]}`, [
          { color: accent, value: c.rate.toFixed(2), label: "per 100K sq ft" },
          { value: fmt(c.complaints), label: "complaints" },
          { value: fmt(c.lots), label: "buildings" },
        ]);
      };
      const off = () => { bar.classList.remove("on"); hideTip(); };
      hit.addEventListener("pointermove", on); hit.addEventListener("pointerleave", off);
      hit.addEventListener("focus", on); hit.addEventListener("blur", off);
    });
  }

  $("#eff-insight").replaceChildren(...insight(groups));

  const tbl = h("table", { class: "table" },
    h("thead", {}, h("tr", {}, ...(groups.length > 1 ? [h("th", { scope: "col" }, "Group")] : []),
      h("th", { scope: "col" }, "ENERGY STAR"), h("th", { scope: "col", class: "num" }, "Buildings"),
      h("th", { scope: "col", class: "num" }, "Complaints"), h("th", { scope: "col", class: "num" }, "Per 100K sq ft"))),
    h("tbody", {}, ...groups.flatMap((g) => g.cells.map((c) => h("tr", {},
      ...(groups.length > 1 ? [h("td", {}, g.label)] : []), h("td", {}, BAND_LABEL[c.band]),
      h("td", { class: "num" }, fmt(c.lots)), h("td", { class: "num" }, fmt(c.complaints)),
      h("td", { class: "num" }, c.rate == null ? "–" : c.rate.toFixed(2)))))));
  $("#eff-table").replaceChildren(h("div", { class: "table-wrap" }, tbl));
}

/** One plain-English sentence computed from the numbers on screen, never hard-coded. */
function insight(groups) {
  const diff = (g) => {
    const lo = g.cells[0], hi = g.cells[3];
    if (!lo.rate || hi.rate == null || lo.lots < 20 || hi.lots < 20) return null;
    return ((hi.rate - lo.rate) / lo.rate) * 100;
  };
  if (groups.length === 1) {
    const d = diff(groups[0]);
    if (d == null) return ["Not enough buildings in this selection to compare."];
    return [h("strong", {}, `${Math.abs(d).toFixed(0)}% ${d < 0 ? "fewer" : "more"}`),
      ` complaints per sq ft in the most efficient buildings (76–100) than in the least efficient (1–25). `,
      Math.abs(d) < 15 ? "Pooled together, efficiency barely separates them. Try splitting by size or age." : ""];
  }
  const ds = groups.map((g) => ({ g, d: diff(g) })).filter((x) => x.d != null);
  if (!ds.length) return ["Not enough buildings in these groups to compare."];
  const better = ds.filter((x) => x.d < 0);
  const word = state.split === "size_q" ? "size groups" : "age groups";
  const names = better.map((x) => x.g.label.toLowerCase()).join(", ");
  return [h("strong", {}, `In ${better.length} of ${ds.length} ${word}`),
    `, the most efficient buildings get fewer complaints per sq ft than the least efficient`,
    better.length && better.length < ds.length ? ` (${names}).` : ".",
    state.split === "size_q" ? " Bars share one scale, so the size effect itself is visible too." : ""];
}

/* ---------- map ---------- */
let map, tiles, cellsLayer;
function tileURL() {
  const dark = document.documentElement.dataset.theme === "dark";
  return `https://{s}.basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`;
}
function renderMap() {
  if (!window.L) { $("#map").replaceChildren(h("p", { class: "empty", style: "padding:16px" }, "Map unavailable.")); return; }
  if (!map) {
    map = L.map("map", { zoomControl: true, scrollWheelZoom: false, preferCanvas: true, attributionControl: true })
      .setView([40.71, -73.94], 10);
    tiles = L.tileLayer(tileURL(), {
      maxZoom: 16, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
  } else {
    tiles.setUrl(tileURL());
  }
  if (cellsLayer) cellsLayer.remove();
  const cells = state.mapCells.filter((c) => c.season === state.season && boroOK(c.boro));
  const vals = cells.map((c) => c.n).sort((a, b) => a - b);
  const q = (p) => vals[Math.floor(p * (vals.length - 1))] || 1;
  const cuts = [q(0.5), q(0.8), q(0.95)];
  const ramp = ["--seq-1", "--seq-2", "--seq-3", "--seq-4"].map(cssVar);
  const max = vals[vals.length - 1] || 1;
  const renderer = L.canvas({ padding: 0.2 });
  cellsLayer = L.layerGroup(cells.map((c) => {
    const step = c.n <= cuts[0] ? 0 : c.n <= cuts[1] ? 1 : c.n <= cuts[2] ? 2 : 3;
    return L.circleMarker([c.lat, c.lon], {
      renderer, radius: 2 + Math.sqrt(c.n / max) * 11, stroke: false,
      fillColor: ramp[step], fillOpacity: 0.85,
    }).bindTooltip(`${nf.format(c.n)} no-heat complaint${c.n === 1 ? "" : "s"}`, { direction: "top", offset: [0, -4] });
  })).addTo(map);
  if (state.boro && cells.length) {
    map.fitBounds(L.latLngBounds(cells.map((c) => [c.lat, c.lon])).pad(0.05));
  } else {
    map.setView([40.71, -73.94], 10);
  }
}

/* ---------- building lookup ---------- */
let searchIndex = [], activeOpt = -1;
function buildIndex(lots) {
  searchIndex = lots.map((l) => ({ l, key: `${(l.address || "").toLowerCase()} ${l.bbl}` }));
}
function search(qs) {
  const q = qs.trim().toLowerCase();
  if (q.length < 2) return [];
  const digits = /^\d+$/.test(q);
  const hits = searchIndex.filter((x) => (digits ? x.l.bbl.startsWith(q) : x.key.includes(q)) && boroOK(x.l.boro));
  hits.sort((a, b) => b.l.no_heat - a.l.no_heat);
  return hits.slice(0, 8).map((x) => x.l);
}
function setupSearch() {
  const input = $("#q"), list = $("#q-list");
  let results = [];
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); activeOpt = -1; };
  const paint = () => {
    list.replaceChildren(...results.map((l, i) => h("li", {
      role: "option", id: `opt-${i}`, "aria-selected": i === activeOpt ? "true" : "false",
      onmousedown: (e) => { e.preventDefault(); pick(l); },
    }, l.address || `BBL ${l.bbl}`, h("small", {}, `${l.boro} · BBL ${l.bbl} · ${fmt(l.no_heat)} complaints`))));
    if (activeOpt >= 0) input.setAttribute("aria-activedescendant", `opt-${activeOpt}`);
    else input.removeAttribute("aria-activedescendant");
  };
  const pick = (l) => { input.value = l.address || l.bbl; close(); selectBuilding(l.bbl); };
  input.addEventListener("input", () => {
    results = search(input.value); activeOpt = -1;
    if (!results.length) {
      list.replaceChildren(h("li", { "aria-disabled": "true" }, input.value.trim().length < 2 ? "Keep typing…" : "No matching building in LL84"));
    } else paint();
    list.hidden = !input.value.trim(); input.setAttribute("aria-expanded", String(!list.hidden));
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !results.length) return;
    if (e.key === "ArrowDown") { activeOpt = (activeOpt + 1) % results.length; paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { activeOpt = (activeOpt - 1 + results.length) % results.length; paint(); e.preventDefault(); }
    else if (e.key === "Enter") { pick(results[Math.max(0, activeOpt)]); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
}

function selectBuilding(bbl) {
  state.selected = bbl;
  syncHash();
  renderBuilding();
}
function renderBuilding() {
  const box = $("#building");
  const lots = state.lots[state.season] || [];
  const l = lots.find((x) => x.bbl === state.selected);
  if (!l) {
    box.replaceChildren(h("p", { class: "empty" }, state.selected
      ? "This building has no LL84 record for this season."
      : "Pick a building to see its score, its complaints this season and how it compares with buildings its size."));
    return;
  }
  // peers: every benchmarked apartment building in the same floor-area quartile, citywide
  const gfas = lots.map((x) => x.gfa).filter((g) => g > 0).sort((a, b) => a - b);
  const qcut = [0.25, 0.5, 0.75].map((p) => gfas[Math.floor(p * (gfas.length - 1))]);
  const qOf = (g) => qcut.findIndex((c) => g <= c) === -1 ? 3 : qcut.findIndex((c) => g <= c);
  const peers = lots.filter((x) => x.gfa > 0 && qOf(x.gfa) === qOf(l.gfa));
  const peerRates = peers.map((x) => x.rate).sort((a, b) => a - b);
  const peerMedian = peerRates[Math.floor(peerRates.length / 2)] || 0;
  const below = peerRates.filter((r) => r < l.rate).length;
  const pct = Math.round((below / Math.max(1, peerRates.length)) * 100);
  const scale = Math.max(l.rate || 0, peerMedian, 0.01) * 1.15;

  const era = l.era ? ERA_LABEL[l.era] : null;
  box.replaceChildren(
    h("div", { class: "b-head" },
      h("h3", {}, l.address || `BBL ${l.bbl}`),
      h("p", {}, [`BBL ${l.bbl}`, l.boro, l.built ? `built ${l.built}${era ? ` (${era.toLowerCase()})` : ""}` : null, `${compact(l.gfa)} sq ft`].filter(Boolean).join(" · "))),
    h("div", { class: "b-stats" },
      h("div", { class: "b-stat" }, h("span", {}, "ENERGY STAR"), h("strong", {}, l.score == null ? "Not scored" : String(Math.round(l.score)))),
      h("div", { class: "b-stat" }, h("span", {}, `Complaints ${seasonLabel(state.season)}`), h("strong", {}, fmt(l.no_heat))),
      h("div", { class: "b-stat" }, h("span", {}, "Per 100K sq ft"), h("strong", {}, l.rate == null ? "–" : l.rate.toFixed(2)))),
    h("div", { class: "compare-row" }, h("span", {}, "This building"), h("strong", {}, l.rate == null ? "–" : l.rate.toFixed(2))),
    h("div", { class: "track" }, h("i", { style: `width:${((l.rate || 0) / scale) * 100}%;background:var(--accent)` })),
    h("div", { class: "compare-row" }, h("span", {}, `Median of ${fmt(peers.length)} similar-size buildings`), h("strong", {}, peerMedian.toFixed(2))),
    h("div", { class: "track" }, h("i", { style: `width:${(peerMedian / scale) * 100}%;background:var(--compare)` })),
    h("p", { class: "verdict" }, l.no_heat === 0
      ? "No no-heat complaints this season."
      : `More complaints per sq ft than ${pct}% of similar-size benchmarked buildings.`),
  );
}

/* ---------- leaderboard ---------- */
function renderLeaderboard(lots) {
  const rows = lots.filter((l) => boroOK(l.boro) && l.gfa >= state.gfaMin && l.no_heat >= MIN_COMPLAINTS_RANKED);
  const key = state.sort;
  rows.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  const top = rows.slice(0, state.lbAll ? 25 : 10);
  const more = $("#lb-more");
  more.hidden = rows.length <= 10;
  more.textContent = state.lbAll ? "Show top 10" : `Show top ${Math.min(25, rows.length)}`;
  const maxRate = Math.max(...top.map((l) => l.rate), 0.01);
  const tbody = $("#lb tbody");
  if (!top.length) {
    tbody.replaceChildren(h("tr", {}, h("td", { colspan: 6 }, "No buildings match these filters yet.")));
  } else {
    tbody.replaceChildren(...top.map((l) => h("tr", {
      tabindex: 0, onclick: () => openBuilding(l.bbl),
      onkeydown: (e) => { if (e.key === "Enter") openBuilding(l.bbl); },
    },
    h("td", { class: "bldg" }, l.address || `BBL ${l.bbl}`, h("small", {}, `${l.boro} · BBL ${l.bbl}`)),
    h("td", { class: "num" }, h("span", { class: "rate-bar", style: `width:${Math.max(4, (l.rate / maxRate) * 48)}px`, "aria-hidden": "true" }), l.rate.toFixed(2)),
    h("td", { class: "num" }, fmt(l.no_heat)),
    h("td", { class: "num" }, l.score == null ? "–" : String(Math.round(l.score))),
    h("td", { class: "num hide-sm" }, l.built ? String(l.built) : "–"),
    h("td", { class: "num hide-sm" }, compact(l.gfa)))));
  }
  for (const b of document.querySelectorAll("#lb th button")) {
    if (b.dataset.sort === key) b.setAttribute("aria-sort", "descending"); else b.removeAttribute("aria-sort");
  }
}
function openBuilding(bbl) {
  const l = (state.lots[state.season] || []).find((x) => x.bbl === bbl);
  if (l) $("#q").value = l.address || l.bbl;
  selectBuilding(bbl);
  $("#lookup-title").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

/* ---------- data health ---------- */
function renderHealth() {
  const m = state.meta, p = m.pipeline;
  const icon = (good) => {
    const svg = s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    s("circle", { cx: 12, cy: 12, r: 11, fill: good ? cssVar("--good") : cssVar("--warn") }, svg);
    s("path", { d: good ? "M7 12.5l3 3 7-7" : "M12 7v6M12 16.5v.5", fill: "none", stroke: good ? "#fff" : "#0b0b0b", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
    return svg;
  };
  const through = toDate(m.data_through);
  const ageDays = Math.floor((Date.now() - through.getTime()) / DAY);
  const items = [];
  if (p) {
    const all = p.tests_passed === p.tests_total;
    items.push([all, `${p.tests_passed} of ${p.tests_total} data tests passed`, `${p.models_built} dbt models rebuilt ${relTime(p.built_at)}`]);
  }
  items.push([ageDays <= 4, `Complaints through ${fmtDate(through)}`, ageDays <= 4 ? "The city publishes in batches, usually every 1–2 days" : `No new data for ${ageDays} days`]);
  items.push([true, `${fmt(m.complaints_total)} heat complaints tracked`, `${fmt(m.no_heat_total)} of them about missing heat`]);
  const done = m.seasons.filter((x) => x.complete).map((x) => seasonLabel(x.season));
  items.push([true, `${done.length} complete heat season${done.length === 1 ? "" : "s"}`, done.join(", ") || "First season in progress"]);
  $("#health").replaceChildren(...items.map(([good, title, sub]) => h("li", {}, icon(good), h("div", {}, title, h("small", {}, sub)))));
}
function relTime(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 6e4);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

/* ---------- orchestration ---------- */
function syncHash() {
  const p = new URLSearchParams();
  p.set("season", state.season);
  if (state.boro) p.set("boro", state.boro);
  if (state.selected) p.set("bbl", state.selected);
  history.replaceState(null, "", "#" + p.toString());
}
async function render() {
  const content = $("#content");
  content.setAttribute("aria-busy", "true");
  try {
    const lots = await loadLots(state.season);
    buildIndex(lots);
    const info = seasonInfo(state.season);
    const { start, end } = seasonBounds(state.season);
    $("#season-note").textContent = `${fmtDate(new Date(start))} – ${fmtDate(new Date(end))} · compared with ${info.ll84_year} energy scores${info.complete ? "" : " · in progress"}`;
    const dm = dailyMap();
    renderKPIs(lots, dm);
    renderTrend(dm);
    renderEfficiency(lots);
    renderMap();
    renderBuilding();
    renderLeaderboard(lots);
    syncHash();
  } catch (err) {
    showError(err);
  } finally {
    content.setAttribute("aria-busy", "false");
  }
}
function showError(err) {
  console.error(err);
  const box = $("#error");
  box.hidden = false;
  box.textContent = "The data for this view couldn't be loaded. It refreshes every morning, so please try again later.";
}

function setupTheme() {
  const root = document.documentElement, btn = $("#theme-btn");
  let saved = null;
  try { saved = localStorage.getItem("hw-theme"); } catch { /* storage blocked */ }
  const apply = (t) => {
    root.dataset.theme = t;
    btn.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  };
  apply(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  btn.addEventListener("click", () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark";
    apply(t);
    try { localStorage.setItem("hw-theme", t); } catch { /* ignore */ }
    if (state.meta) render();
  });
}

async function init() {
  setupTheme();
  setupSearch();
  try {
    const [meta, daily, seasonBoro, mapCells] = await Promise.all(
      ["meta.json", "daily.json", "season_boro.json", "map.json"].map(getJSON));
    state.meta = meta;
    state.daily = rowsOf(daily);
    state.seasonBoro = rowsOf(seasonBoro);
    state.mapCells = rowsOf(mapCells);
    state.dataStart = Math.min(...state.daily.map((r) => toDate(r.d).getTime()));
  } catch (err) {
    showError(err);
    $("#content").hidden = true;
    return;
  }

  const seasons = [...state.meta.seasons].sort((a, b) => b.season.localeCompare(a.season));
  const sel = $("#f-season");
  sel.replaceChildren(...seasons.map((x) => h("option", { value: x.season }, `${seasonLabel(x.season)}${x.complete ? "" : " (in progress)"}`)));

  // start on the newest complete season, unless the link says otherwise
  const p = new URLSearchParams(location.hash.slice(1));
  const fromLink = seasons.find((x) => x.season === p.get("season"));
  state.season = (fromLink || seasons.find((x) => x.complete) || seasons[0]).season;
  state.boro = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"].includes(p.get("boro")) ? p.get("boro") : "";
  state.selected = p.get("bbl");
  sel.value = state.season;
  $("#f-boro").value = state.boro;

  const live = $("#live-badge");
  live.hidden = false;
  $("#live-text").textContent = `Updated ${relTime(state.meta.generated_at)}`;
  live.title = `Data through ${fmtDate(toDate(state.meta.data_through))}`;
  renderHealth();

  sel.addEventListener("change", () => { state.season = sel.value; render(); });
  $("#f-boro").addEventListener("change", (e) => { state.boro = e.target.value; render(); });
  $("#f-gfa").addEventListener("change", (e) => { state.gfaMin = +e.target.value; renderLeaderboard(state.lots[state.season]); });
  $("#lb-more").addEventListener("click", () => { state.lbAll = !state.lbAll; renderLeaderboard(state.lots[state.season]); });
  for (const b of document.querySelectorAll("#lb th button")) {
    b.addEventListener("click", () => { state.sort = b.dataset.sort; renderLeaderboard(state.lots[state.season]); });
  }
  for (const b of document.querySelectorAll(".seg button")) {
    b.addEventListener("click", () => {
      state.split = b.dataset.split;
      for (const o of document.querySelectorAll(".seg button")) o.setAttribute("aria-selected", String(o === b));
      renderEfficiency(state.lots[state.season]);
    });
  }
  let rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { const lots = state.lots[state.season]; if (!lots) return; const dm = dailyMap(); renderTrend(dm); renderEfficiency(lots); }, 150);
  });
  addEventListener("scroll", hideTip, { passive: true });

  await render();
}

init();
