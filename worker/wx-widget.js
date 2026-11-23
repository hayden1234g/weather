// wx-widget: a Cloudflare Worker that turns a lat/lon into one small, display-ready JSON
// for a KWGT home-screen widget. Same sources and rules as the weather site:
//   - current conditions from the nearest NWS station (falls back to the NWS hourly forecast)
//   - "feel": wind chill when cold, NWS WBGT with the regional risk scale when warm
//   - caution sign: any NWS warning or watch at the point, or SPC Marginal+ in days 1-3
// GET /?lat=30.27&lon=-97.74   (coordinates are rounded to 2 decimals, ~1 km)
// Nothing is stored except a 10-minute cache of the answer per rounded location.

const IN_BROWSER = typeof window !== "undefined"; // for the local test page
const HEADERS = IN_BROWSER ? {} : { "User-Agent": "wx-widget (personal weather widget)", Accept: "application/geo+json" };
const SITE = "https://hayden1234g.github.io/weather/";
const CACHE_SECONDS = 600;

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const lat = Math.round(parseFloat(u.searchParams.get("lat")) * 100) / 100;
    const lon = Math.round(parseFloat(u.searchParams.get("lon")) * 100) / 100;
    if (!isFinite(lat) || !isFinite(lon)) return json({ error: "add ?lat=..&lon=.." }, 400, 0);

    const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
    const key = new Request(`https://wx-widget.cache/${lat},${lon}`);
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }

    let body;
    try { body = await build(lat, lon); }
    catch (e) { return json({ error: String(e.message || e), temp: "", cond: "Unavailable", caution: { on: false, icon: "" } }, 502, 60); }
    const res = json(body, 200, CACHE_SECONDS);
    if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};

function json(obj, status, maxAge) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, "access-control-allow-origin": "*" },
  });
}

async function get(url, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) return await r.json();
      last = new Error(`${r.status} from ${new URL(url).host}`);
      if (r.status < 500) break;
    } catch (e) { last = e; }
  }
  throw last;
}

/* ---------- units + helpers ---------- */
const cToF = c => (c == null ? null : c * 9 / 5 + 32);
const kmhToMph = k => (k == null ? null : k * 0.621371);
const r0 = v => (v == null || isNaN(v) ? null : Math.round(v));
const compass = d => (d == null ? "" : ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16]);
function isoDur(d) {
  const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(d) || [];
  return (((+m[1] || 0) * 24 + (+m[2] || 0)) * 60 + (+m[3] || 0)) * 60000;
}
function valueAt(prop, t) {
  for (const v of prop?.values || []) {
    const [s, d] = v.validTime.split("/"); const a = Date.parse(s);
    if (t >= a && t < a + isoDur(d)) return v.value;
  }
  return null;
}
function iconCode(url) { try { return new URL(url).pathname.split("/")[4].split(",")[0]; } catch { return ""; } }
const EMOJI = {
  skc: ["☀️", "🌙"], few: ["🌤️", "🌙"], sct: ["⛅", "🌙"], bkn: ["🌥️", "☁️"], ovc: ["☁️", "☁️"],
  rain: ["🌧️", "🌧️"], rain_showers: ["🌦️", "🌧️"], rain_showers_hi: ["🌦️", "🌧️"], tsra: ["⛈️", "⛈️"], tsra_sct: ["⛈️", "⛈️"], tsra_hi: ["⛈️", "⛈️"],
  snow: ["🌨️", "🌨️"], blizzard: ["🌨️", "🌨️"], rain_snow: ["🌨️", "🌨️"], snow_sleet: ["🌨️", "🌨️"], rain_sleet: ["🧊", "🧊"], sleet: ["🧊", "🧊"],
  fzra: ["🧊", "🧊"], rain_fzra: ["🧊", "🧊"], snow_fzra: ["🧊", "🧊"], fog: ["🌫️", "🌫️"], haze: ["🌫️", "🌫️"], smoke: ["🌫️", "🌫️"], dust: ["🌫️", "🌫️"],
  hot: ["☀️", "🌙"], cold: ["☀️", "🌙"], tornado: ["🌪️", "🌪️"], hurricane: ["🌀", "🌀"], tropical_storm: ["🌀", "🌀"],
};
const emojiFor = (code, day) => (EMOJI[code.replace(/^wind_/, "")] || ["🌡️", "🌡️"])[day ? 0 : 1];

/* ---------- WBGT regional scale (same as the site; Grundstein et al. 2015 / KSI) ---------- */
const WBGT_CUTS = { 1: [76.2, 81.2, 84.2, 86.1], 2: [79.8, 84.7, 87.7, 89.7], 3: [82.3, 87.1, 90.1, 92.1] };
const WBGT_LEVELS = [["Low", "#4caf50"], ["Elevated", "#f2e64d"], ["Moderate", "#f0a830"], ["High", "#e0402f"], ["Extreme", "#000000"]];
const WBGT_STATE = {
  1: "AK WA OR ID MT WY CO ND MN WI MI NY VT NH ME MA",
  2: "CA NV UT SD NE KS IA IL IN OH PA NJ CT RI",
  3: "TX OK NM AZ MO AR LA MS AL TN KY WV VA MD DE DC NC SC GA FL HI PR VI GU AS MP",
};
function wbgtRegion(st, lat, lon, e) {
  st = (st || "").toUpperCase(); e = e ?? 0;
  let cat = +(Object.keys(WBGT_STATE).find(k => WBGT_STATE[k].split(" ").includes(st)) || 2);
  if (st === "TX" && lon < -100) cat = 2;
  if (st === "NY" && lat < 41.3) cat = 2;
  if (st === "CA" && e < 300 && ((lat > 35 && lon > -122.2) || lon > -117.5)) cat = 3;
  if (["NV", "UT"].includes(st) && e < 1000) cat = 3;
  if (["CO", "UT"].includes(st) && e < 1600 && cat === 1) cat = 2;
  if (["AZ", "NM"].includes(st) && e >= 1500) cat = 2;
  if (e >= 2000) cat = 1;
  return cat;
}

/* ---------- SPC categorical outlook, days 1-3, at a point ---------- */
const SPC = { MRGL: ["Marginal", "#7fc57f", 1], SLGT: ["Slight", "#f6f67f", 2], ENH: ["Enhanced", "#e6c27f", 3], MDT: ["Moderate", "#e67f7f", 4], HIGH: ["High", "#ff7fff", 5] };
async function spcRisk(lat, lon) {
  const u = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer/identify" +
    `?geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&tolerance=0&mapExtent=${lon - 1},${lat - 1},${lon + 1},${lat + 1}` +
    "&imageDisplay=400,400,96&returnGeometry=false&layers=all:1,9,17&f=json";
  const d = await get(u, 1);
  let best = null;
  for (const r of d.results || []) {
    const day = { 1: 1, 9: 2, 17: 3 }[r.layerId];
    const label = Object.entries(r.attributes).find(([k]) => k.toLowerCase() === "label")?.[1];
    if (day && SPC[label] && (!best || SPC[label][2] > SPC[best.label][2] || (SPC[label][2] === SPC[best.label][2] && day < best.day))) best = { day, label };
  }
  return best;
}

/* ---------- build the widget payload ---------- */
async function build(lat, lon) {
  const now = Date.now();
  const pt = (await get(`https://api.weather.gov/points/${lat},${lon}`)).properties;
  const tz = pt.timeZone || "America/Chicago";
  const fmt = (t, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(new Date(t));
  const rl = pt.relativeLocation?.properties || {};

  const [hr, grid, al, st, spc] = await Promise.allSettled([
    get(pt.forecastHourly), get(pt.forecastGridData), get(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, 1),
    get(`${pt.observationStations}?limit=3`, 1), spcRisk(lat, lon),
  ]);
  const hour = (hr.value?.properties?.periods || []).find(h => Date.parse(h.endTime) > now);
  const g = grid.value?.properties || {};
  const station = st.value?.features?.[0];
  const o = station ? (await get(`${station.id}/observations/latest`, 1).catch(() => null))?.properties : null;
  const fresh = o && o.temperature?.value != null && now - Date.parse(o.timestamp) < 2 * 3600e3;

  const temp = fresh ? cToF(o.temperature.value) : hour?.temperature;
  const dew = fresh && o.dewpoint?.value != null ? cToF(o.dewpoint.value) : cToF(hour?.dewpoint?.value);
  const windMph = fresh && o.windSpeed?.value != null ? kmhToMph(o.windSpeed.value) : parseFloat(hour?.windSpeed);
  const windDir = fresh && o.windDirection?.value != null ? compass(o.windDirection.value) : hour?.windDirection || "";
  const gust = fresh && o.windGust?.value != null ? kmhToMph(o.windGust.value) : kmhToMph(valueAt(g.windGust, now));
  // icon matches the condition text: the station's own icon when we're using its observation
  const obsIcon = fresh && o.icon ? o.icon : null;
  const code = iconCode(obsIcon || hour?.icon);
  const day = obsIcon ? /\/day\//.test(obsIcon) : (hour?.isDaytime ?? true);

  // feel: wind chill when cold, WBGT when warm, otherwise nothing
  let feel = { type: "", value: "", label: "", color: "", text: "" };
  let chill = fresh ? cToF(o.windChill?.value) : null;
  if (chill == null && temp != null && temp <= 50) { const a = cToF(valueAt(g.apparentTemperature, now)); if (a != null && a < temp) chill = a; }
  const wb = cToF(valueAt(g.wetBulbGlobeTemperature, now));
  const cat = wbgtRegion(rl.state, lat, lon, g.elevation?.value);
  if (chill != null && temp != null && temp <= 50 && temp - chill >= 2) {
    feel = { type: "windchill", value: r0(chill), label: "Wind chill", color: "", text: `Wind chill ${r0(chill)}°` };
  } else if (wb != null && (wb >= WBGT_CUTS[cat][0] - 6 || temp >= 80)) {
    const lv = WBGT_CUTS[cat].filter(c => wb >= c).length;
    feel = { type: "wbgt", value: r0(wb), label: WBGT_LEVELS[lv][0], color: WBGT_LEVELS[lv][1], text: `WBGT ${r0(wb)}° · ${WBGT_LEVELS[lv][0]}`, category: cat };
  }

  // caution: warning > watch > SPC Marginal+ in days 1-3 (general thunder doesn't count)
  const alerts = (al.value?.features || []).map(a => a.properties.event || "");
  const warning = alerts.find(e => /Warning/i.test(e)), watch = alerts.find(e => /Watch/i.test(e));
  let caution = { on: false, icon: "", why: "", color: "" };
  if (warning) caution = { on: true, icon: "⚠", why: warning, color: "#e0584a" };
  else if (watch) caution = { on: true, icon: "⚠", why: watch, color: "#e8a33c" };
  else if (spc.value) {
    const t = new Date(now - 6 * 3600e3);
    const d1 = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 12) + (spc.value.day - 1) * 86400e3;
    const when = fmt(d1, { weekday: "short" }) === fmt(now, { weekday: "short" }) ? "today" : fmt(d1, { weekday: "short" });
    const [name, color] = SPC[spc.value.label];
    caution = { on: true, icon: "⚠", why: `${name} severe risk ${when}`, color };
  }

  return {
    temp: r0(temp) ?? "", cond: (fresh && o.textDescription) || hour?.shortForecast || "",
    icon: code, daytime: day, emoji: emojiFor(code, day),
    dew: r0(dew) ?? "",
    wind: windMph != null && !isNaN(windMph) ? (r0(windMph) === 0 ? "Calm" : `${windDir} ${r0(windMph)}`) : "",
    gust: gust != null && gust > (windMph || 0) + 3 ? r0(gust) : "",
    feel, caution,
    place: rl.city ? `${rl.city}, ${rl.state}` : "",
    observed: fresh ? (station?.properties?.name || "") : "forecast",
    updated: fmt(now, { hour: "numeric", minute: "2-digit" }),
    link: `${SITE}?at=${lat},${lon}&n=${encodeURIComponent(rl.city ? `${rl.city}, ${rl.state}` : "")}`,
    partial: [hr, grid, al, st, spc].filter(x => x.status === "rejected").length || undefined,
  };
}
