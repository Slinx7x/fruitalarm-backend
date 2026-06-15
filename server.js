// ================================================================
//  FruitAlarm Backend v4
//  Uses blox-fruits-api.onrender.com — real JSON stock API
//  No scraping, no HTML parsing. Clean JSON in, clean JSON out.
//  Falls back to Fandom Wiki text parse if API is down.
// ================================================================

const https = require("https");
const http  = require("http");
const PORT  = process.env.PORT || 3000;

// ── Cache ─────────────────────────────────────────────────────────
let cache = {
  normalStock:     [],
  mirageStock:     [],
  lastUpdated:     null,
  nextResetNormal: null,
  nextResetMirage: null,
  source:          "pending",
};

// ── Known fruit IDs — must match fruits.js exactly ───────────────
const KNOWN_FRUITS = new Set([
  "rocket","spin","blade","spring","bomb","smoke","spike",
  "flame","ice","sand","dark","eagle","diamond",
  "light","rubber","ghost","magma",
  "quake","buddha","love","creation","spider","sound",
  "portal","phoenix","lightning","blizzard","pain",
  "gravity","mammoth","trex","dough","shadow",
  "venom","gas","spirit","tiger","yeti","kitsune","control","dragon",
]);

// Normalise any fruit name/slug → our fruit id
function toId(raw) {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, "")  // remove dashes, spaces, special chars
    .replace("trex", "trex");   // keep as-is
}

// ── Simple HTTPS GET ──────────────────────────────────────────────
function get(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: "GET",
        headers: {
          "User-Agent": "FruitAlarm/4.0 (fan project; github.com/fruitalarm)",
          "Accept":     "application/json, text/html",
        },
        timeout: 12000,
      },
      res => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── SOURCE 1: blox-fruits-api.onrender.com ───────────────────────
// Returns JSON like:
// { "Normal": ["Flame","Ice","Diamond"], "Mirage": ["Kitsune","Dough"] }
// (exact format may vary — we handle multiple possible shapes)
async function fetchFromCommunityAPI() {
  const { status, body } = await get(
    "blox-fruits-api.onrender.com",
    "/api/bloxfruits/stock"
  );

  if (status !== 200) throw new Error(`API returned HTTP ${status}`);

  // The API may return a JSON string or object
  let data = body;
  if (typeof data === "string") {
    data = JSON.parse(data);
    // API wraps in another string sometimes
    if (typeof data === "string") data = JSON.parse(data);
  }

  // Handle multiple possible response shapes
  let normalRaw = [];
  let mirageRaw = [];

  if (Array.isArray(data)) {
    // Shape: [ { name:"Flame", type:"normal" }, ... ]
    normalRaw = data.filter(f => (f.type||"").toLowerCase() !== "mirage").map(f => f.name || f.fruit || f);
    mirageRaw = data.filter(f => (f.type||"").toLowerCase() === "mirage").map(f => f.name || f.fruit || f);
  } else if (data.Normal || data.normal) {
    // Shape: { Normal: [...], Mirage: [...] }
    normalRaw = data.Normal || data.normal || [];
    mirageRaw = data.Mirage || data.mirage || [];
  } else if (data.stock) {
    normalRaw = data.stock;
  } else {
    // Last resort — grab any array values
    const vals = Object.values(data);
    normalRaw = vals.find(v => Array.isArray(v)) || [];
  }

  const normalStock = normalRaw.map(toId).filter(id => KNOWN_FRUITS.has(id));
  const mirageStock = mirageRaw.map(toId).filter(id => KNOWN_FRUITS.has(id));

  if (normalStock.length === 0) throw new Error("API returned 0 valid fruits");

  return { normalStock, mirageStock, source: "community-api" };
}

// ── SOURCE 2: Fandom Wiki plain text (fallback) ───────────────────
// The wiki's raw action=raw endpoint returns clean Lua text
// with fruit names we can regex out easily
async function fetchFromWiki() {
  const { status, body } = await get(
    "blox-fruits.fandom.com",
    "/wiki/Blox_Fruits_%22Stock%22?action=raw"
  );

  if (status !== 200) throw new Error(`Wiki returned HTTP ${status}`);

  const found = [];
  // Wiki raw format has fruit names as wiki links: [[FruitName]]
  const pattern = /\[\[([A-Za-z\-]+)\]\]/g;
  let m;
  while ((m = pattern.exec(body)) !== null) {
    const id = toId(m[1]);
    if (KNOWN_FRUITS.has(id) && !found.includes(id)) found.push(id);
  }

  if (found.length === 0) throw new Error("Wiki parse returned 0 fruits");

  return { normalStock: found, mirageStock: [], source: "wiki" };
}

// ── Next reset times ──────────────────────────────────────────────
function nextReset(cycleHours) {
  const now   = new Date();
  const sec   = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const cycle = cycleHours * 3600;
  return new Date(now.getTime() + (cycle - sec % cycle) * 1000).toISOString();
}

// ── Main refresh — tries sources in order ─────────────────────────
async function refresh() {
  console.log(`\n[${new Date().toISOString()}] Refreshing stock...`);

  let result = null;

  // Try community API first
  try {
    result = await fetchFromCommunityAPI();
    console.log(`✅ Community API → Normal: ${result.normalStock.join(", ")||"none"}`);
    console.log(`✅ Community API → Mirage: ${result.mirageStock.join(", ")||"none"}`);
  } catch (e) {
    console.warn(`⚠️  Community API failed: ${e.message}`);
  }

  // Fallback to wiki
  if (!result) {
    try {
      result = await fetchFromWiki();
      console.log(`✅ Wiki fallback → Normal: ${result.normalStock.join(", ")||"none"}`);
    } catch (e) {
      console.warn(`⚠️  Wiki fallback failed: ${e.message}`);
    }
  }

  // Update cache
  if (result) {
    cache = {
      normalStock:     result.normalStock,
      mirageStock:     result.mirageStock,
      lastUpdated:     new Date().toISOString(),
      nextResetNormal: nextReset(4),
      nextResetMirage: nextReset(2),
      source:          result.source,
    };
  } else if (cache.normalStock.length > 0) {
    // Keep stale cache
    cache.source      = "cached";
    cache.lastUpdated = new Date().toISOString();
    console.log(`⚠️  All sources failed — serving stale cache`);
  } else {
    // Absolute last resort
    cache = {
      normalStock:     ["rocket", "spin"],
      mirageStock:     [],
      lastUpdated:     new Date().toISOString(),
      nextResetNormal: nextReset(4),
      nextResetMirage: nextReset(2),
      source:          "fallback",
    };
    console.log(`❌ All sources failed — serving minimal fallback`);
  }
}

// ── HTTP Server ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const path = req.url.split("?")[0];

  if (path === "/stock") {
    res.writeHead(200);
    res.end(JSON.stringify(cache));
    return;
  }
  if (path === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      status:       "ok",
      source:       cache.source,
      normalCount:  cache.normalStock.length,
      mirageCount:  cache.mirageStock.length,
      lastUpdated:  cache.lastUpdated,
    }));
    return;
  }
  if (path === "/force-refresh") {
    refresh();
    res.writeHead(202);
    res.end(JSON.stringify({ message: "Refresh started — check /stock in ~5 seconds" }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found. Try /stock or /health" }));
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🍈 FruitAlarm backend v4`);
  console.log(`   Port    : ${PORT}`);
  console.log(`   Source 1: blox-fruits-api.onrender.com`);
  console.log(`   Source 2: Fandom Wiki (fallback)\n`);
  await refresh();
  // Refresh every 2 hours (covers both Normal 4h and Mirage 2h cycles)
  setInterval(refresh, 2 * 60 * 60 * 1000);
});
