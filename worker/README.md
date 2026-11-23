# wx-widget (Cloudflare Worker for a KWGT widget)

`wx-widget.js` takes your phone's location and returns one small JSON with exactly what the widget shows. It uses the same NWS/SPC sources and rules as the site.

```
GET https://wx-widget.<your-subdomain>.workers.dev/?lat=30.27&lon=-97.74
```

```json
{
  "temp": 73, "cond": "Clear", "icon": "skc", "daytime": false, "emoji": "🌙",
  "dew": 70, "wind": "WNW 10", "gust": 18,
  "feel":    { "type": "wbgt", "value": 84, "label": "Moderate", "color": "#f0a830", "text": "WBGT 84° · Moderate" },
  "caution": { "on": true, "icon": "⚠", "why": "Slight severe risk Mon", "color": "#f6f67f" },
  "place": "Port St. Lucie, FL", "observed": "Witham Field Airport", "updated": "9:22 PM",
  "link": "https://hayden1234g.github.io/weather/?at=27.27,-80.35&n=…"
}
```

- **temp / cond / icon / dew / wind / gust:** come from the nearest NWS station if its observation is under 2 hours old. Otherwise they come from the NWS hourly forecast, and `observed` says `"forecast"`. `gust` is blank unless gusts run at least 3 mph above the wind.
- **icon:** the NWS icon code (`skc`, `few`, `sct`, `bkn`, `ovc`, `rain`, `rain_showers`, `tsra`, `snow`, `fog`, …), plus `daytime` so you can map it to your own icon set. `emoji` is a ready-made fallback.
- **feel:** wind chill when it's 50°F or colder and at least 2° below the temperature. NWS WBGT with the regional risk color when it's warm enough to matter. Otherwise all fields are blank strings. `text` is ready to display.
- **caution:** turns on for any NWS warning or watch at your location, or SPC Marginal or higher for your location in days 1–3. General thunder doesn't count. Priority is warning (red), then watch (orange), then SPC (the risk color). `icon` is `⚠` when on and blank when off, so you can just display it.
- **Privacy:** coordinates are rounded to 2 decimals (~1 km). The only thing kept is a 10-minute cache of the answer per rounded location.

## Deploy (one time, about 5 minutes)

1. Sign up for a free account at <https://dash.cloudflare.com/sign-up>.
2. Go to **Workers & Pages** → **Create** → **Create Worker** (the "Hello World" starter). Name it `wx-widget`, then **Deploy**.
3. Click **Edit code**, delete everything, paste in the contents of `wx-widget.js`, and click **Deploy**.
4. Open `https://wx-widget.<your-subdomain>.workers.dev/?lat=30.27&lon=-97.74`. You should see the JSON above.

If the site's rules change later (e.g. WBGT regions), paste the updated file in again. The free plan allows 100,000 requests a day, far more than one widget uses.

To check changes before deploying, open `worker/test.html` through the local preview. It runs the same file in the browser against live data.

## KWGT setup

1. **Location:** in KWGT settings, allow location, including background location. "Low power" accuracy is plenty.
2. **Global for the URL:** in your widget, open **Globals** and add a **Text** global named `wx` with this value (put in your subdomain):

   ```
   https://wx-widget.YOUR-SUBDOMAIN.workers.dev/?lat=$mu(round, li(lat), 2)$&lon=$mu(round, li(lon), 2)$
   ```

   Because it's built from your location, the URL changes when you move, and KWGT fetches fresh data for the new spot.
3. **Fields:** each text item uses a formula like the ones below.

   | Shows | Formula |
   |---|---|
   | Temperature | `$wg(gv(wx), json, ".temp")$°` |
   | Condition | `$wg(gv(wx), json, ".cond")$` |
   | Icon code (for your own icon set) | `$wg(gv(wx), json, ".icon")$` and `$wg(gv(wx), json, ".daytime")$` |
   | Emoji icon (fallback) | `$wg(gv(wx), json, ".emoji")$` |
   | Dew point | `Dew $wg(gv(wx), json, ".dew")$°` |
   | Wind | `$wg(gv(wx), json, ".wind")$` |
   | Gust (blank when none) | `$if(wg(gv(wx), json, ".gust")="", "", "G" + wg(gv(wx), json, ".gust"))$` |
   | Wind chill / WBGT text | `$wg(gv(wx), json, ".feel.text")$` |
   | WBGT color (as a paint color) | `$wg(gv(wx), json, ".feel.color")$` |
   | Caution sign | `$wg(gv(wx), json, ".caution.icon")$` |
   | Caution color | `$wg(gv(wx), json, ".caution.color")$` |
   | Why the caution (e.g. for a long-press) | `$wg(gv(wx), json, ".caution.why")$` |
   | Place / updated time | `$wg(gv(wx), json, ".place")$ · $wg(gv(wx), json, ".updated")$` |

4. **Tap action:** set **Touch → Open link** to `$wg(gv(wx), json, ".link")$` to open the full forecast for where you are.
5. **Refresh:** KWGT re-fetches web data on its own update interval (set in its settings). 15–30 minutes is plenty, since the Worker caches each answer for 10 minutes anyway.

Tip: for a field that should disappear when blank (gust, feel, caution), set the layer's **Visible** to something like `$if(wg(gv(wx), json, ".caution.icon")="", REMOVE, ALWAYS)$`.
