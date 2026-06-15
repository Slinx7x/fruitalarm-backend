// ================================================================
//  FruitAlarm Backend v3
//  Scrapes fruityblox.com/stock — real in-game stock data
//  Separate Normal + Mirage sections parsed cleanly
// ================================================================

const https = require("https");
const http  = require("http");
const PORT  = process.env.PORT || 3000;

// ── Cache ─────────────────────────────────────────────────────────
let cache = {
  normalStock: [],
  mirageStock: [],
  lastUpdated: null,
  nextResetNormal: null,
  nextResetMirage: null,
  source: "pending",
};

// ── Known fruit IDs (matches our fruits.js database) ─────────────
const KNOWN_FRUITS = new Set([
  "rocket","spin","blade","spring","bomb","smoke","spike",
  "flame","ice","sand","dark","eagle","diamond",
  "light","rubber","ghost","magma",
  "quake","buddha","love","creation","spider","sound",
  "portal","phoenix","lightning","blizzard","pain",
  "gravity","mammoth","trex","t-rex","dough","shadow",
  "venom","gas","spirit","tiger","yeti","kitsune","control","dragon",
]);

// Normalise fruit name from URL slug → our fruit id
function slugToId(slug) {
  const s = slug.toLowerCase().trim();
  if (s === "t-rex") return "trex";
  return s;
}

// ── Fetch fruityblox.com/stock ────────────────────────────────────
function fetchPage() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "fruityblox.com",
      path:     "/stock",
      method:   "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FruitAlarm-Bot/3.0; fan project)",
        "Accept":     "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 12000,
    };

    const req = https.request(options, res => {
      // Follow redirect if needed
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`Redirected to ${res.headers.location}`);
        resolve(fetchUrl(res.headers.location));
        return;
      }
      let html = "";
      res.on("data", chunk => html += chunk);
      res.on("end", () => resolve(html));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── Parse stock from HTML ─────────────────────────────────────────
// fruityblox.com structure:
//   ## Normal  ... /items/fruitname links ...
//   ## Mirage  ... /items/fruitname links ...
function parseStock(html) {
  const normalFruits = [];
  const mirageFruits = [];

  // Find the Normal and Mirage section boundaries
  const normalIdx = html.indexOf("## Normal");
  const mirageIdx = html.indexOf("## Mirage");

  if (normalIdx === -1 && mirageIdx === -1) {
    throw new Error("Could not find Normal or Mirage sections in page");
  }

  // Extract Normal section HTML
  const normalSection = normalIdx !== -1
    ? html.slice(normalIdx, mirageIdx !== -1 ? mirageIdx : normalIdx + 5000)
    : "";

  // Extract Mirage section HTML (everything after ## Mirage)
  const mirageSection = mirageIdx !== -1
    ? html.slice(mirageIdx, mirageIdx + 5000)
    : "";

  // Parse fruit slugs from /items/fruitname links
  const itemPattern = /\/items\/([a-zA-Z0-9_-]+)/g;

  let m;
  const seenNormal = new Set();
  while ((m = itemPattern.exec(normalSection)) !== null) {
    const id = slugToId(m[1]);
    if (KNOWN_FRUITS.has(id) && !seenNormal.has(id)) {
      seenNormal.add(id);
      normalFruits.push(id);
    }
  }

  itemPattern.lastIndex = 0;
  const seenMirage = new Set();
  while ((m = itemPattern.exec(mirageSection)) !== null) {
    const id = slugToId(m[1]);
    if (KNOWN_FRUITS.has(id) && !seenMirage.has(id)) {
      seenMirage.add(id);
      mirageFruits.push(id);
    }
  }

  return { normalFruits, mirageFruits };
}

// ── Next reset times ──────────────────────────────────────────────
function getNextReset(cycleHours) {
  const now    = new Date();
  const sec    = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const cycle  = cycleHours * 3600;
  const rem    = cycle - (sec % cycle);
  return new Date(now.getTime() + rem * 1000).toISOString();
}

// ── Main refresh ──────────────────────────────────────────────────
async function refresh() {
  console.log(`\n[${new Date().toISOString()}] Fetching stock from fruityblox.com...`);
  try {
    const html = await fetchPage();

    if (!html || html.length < 500) {
      throw new Error(`Page too short (${html?.length} chars) — likely blocked or error page`);
    }

    const { normalFruits, mirageFruits } = parseStock(html);

    if (normalFruits.length === 0 && mirageFruits.length === 0) {
      throw new Error("Parsed 0 fruits from both sections — page structure may have changed");
    }

    cache = {
      normalStock:     normalFruits,
      mirageStock:     mirageFruits,
      lastUpdated:     new Date().toISOString(),
      nextResetNormal: getNextReset(4),
      nextResetMirage: getNextReset(2),
      source:          "fruityblox",
    };

    console.log(`✅ Normal stock (${normalFruits.length}): ${normalFruits.join(", ") || "none"}`);
    console.log(`✅ Mirage stock (${mirageFruits.length}): ${mirageFruits.join(", ") || "none"}`);

  } catch (err) {
    console.error(`❌ Scrape failed: ${err.message}`);

    if (cache.normalStock.length > 0) {
      // Keep existing cache, just mark it as stale
      cache.source = "cached";
      cache.lastUpdated = new Date().toISOString();
      console.log(`⚠️  Serving cached stock: ${cache.normalStock.join(", ")}`);
    } else {
      // Absolute fallback — real common fruits that are almost always in stock
      cache = {
        normalStock:     ["rocket", "spin"],
        mirageStock:     [],
        lastUpdated:     new Date().toISOString(),
        nextResetNormal: getNextReset(4),
        nextResetMirage: getNextReset(2),
        source:          "fallback",
      };
      console.log(`⚠️  Using minimal fallback stock`);
    }
  }
}

// ── HTTP Server ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const path = req.url.split("?")[0];

  // ── /stock  — what your app calls ──
  if (path === "/stock") {
    res.writeHead(200);
    res.end(JSON.stringify(cache));
    return;
  }

  // ── /health — Render.com uptime check ──
  if (path === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: "ok",
      source: cache.source,
      normalCount: cache.normalStock.length,
      mirageCount: cache.mirageStock.length,
      lastUpdated: cache.lastUpdated,
    }));
    return;
  }

  // ── /force-refresh — manually trigger a new scrape ──
  if (path === "/force-refresh") {
    refresh(); // fire and forget
    res.writeHead(202);
    res.end(JSON.stringify({ message: "Refresh started — check /stock in a few seconds" }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found. Try /stock or /health" }));
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🍈 FruitAlarm backend v3 running on port ${PORT}`);
  console.log(`   Source: fruityblox.com/stock`);
  console.log(`   Auto-refresh: every 4 hours\n`);
  // Fetch immediately on boot
  await refresh();
  // Then every 4 hours (Normal stock cycle)
  setInterval(refresh, 4 * 60 * 60 * 1000);
  // Also refresh at every Mirage reset (every 2 hours)
  setInterval(refresh, 2 * 60 * 60 * 1000);
});
