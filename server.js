// ================================================================
//  FruitAlarm — backend/server.js
//  
//  This is your "stock bot". It's a tiny web server that:
//  1. Scrapes the Blox Fruits Wiki every 4 hours for live stock
//  2. Saves it in memory
//  3. Lets your app fetch it with a simple URL call
//
//  DEPLOY FREE on Render.com — full instructions in README.md
// ================================================================

const https  = require("https");
const http   = require("http");
const PORT   = process.env.PORT || 3000;

// ── Stock cache ───────────────────────────────────────────────────
let stockCache = {
  fruits:      [],
  lastUpdated: null,
  nextReset:   null,
  source:      "pending",
};

// ── Rarity map ────────────────────────────────────────────────────
const RARITY = {
  "kitsune":"mythical","dragon":"mythical","leopard":"mythical",
  "control":"mythical","dough":"mythical","venom":"mythical",
  "soul":"mythical","gas":"mythical","t-rex":"mythical","mammoth":"mythical",
  "buddha":"legendary","shadow":"legendary","blizzard":"legendary",
  "rumble":"legendary","quake":"legendary","gravity":"legendary",
  "phoenix":"legendary","portal":"legendary","pain":"legendary",
  "dark":"legendary","light":"legendary","magma":"legendary",
  "flame":"legendary","ice":"legendary","sand":"legendary",
  "spin":"legendary","lightning":"legendary","eagle":"legendary",
  "rubber":"rare","spider":"rare","love":"rare","diamond":"rare",
  "smoke":"rare","spike":"rare","bomb":"rare","ghost":"rare",
  "creation":"rare","barrier":"rare","door":"rare","string":"rare",
  "paw":"rare","falcon":"rare",
  "rocket":"common","spring":"common","kilo":"common","chop":"common",
  "slow":"common","revive":"common","stomp":"common",
};

// ── Wiki scraper ──────────────────────────────────────────────────
function scrapeWiki() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "blox-fruits.fandom.com",
      path:     '/wiki/Blox_Fruits_%22Stock%22',
      method:   "GET",
      headers:  {
        "User-Agent": "FruitAlarm-StockBot/1.0 (educational fan project)",
        "Accept":     "text/html",
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let html = "";
      res.on("data", chunk => html += chunk);
      res.on("end", () => {
        try {
          const fruits = parseStockFromHtml(html);
          if (fruits.length === 0) {
            reject(new Error("Parsed 0 fruits"));
          } else {
            resolve(fruits);
          }
        } catch (e) { reject(e); }
      });
    });

    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── HTML parser ───────────────────────────────────────────────────
function parseStockFromHtml(html) {
  const found = [];
  const knownFruits = new Set(Object.keys(RARITY));
  const linkPattern = /href="\/wiki\/([^"#?]+)(?:#[^"]*)?"/g;

  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const raw  = decodeURIComponent(match[1]).replace(/_/g, " ");
    const name = raw.trim();
    const key  = name.toLowerCase();
    if (knownFruits.has(key) && !found.includes(name)) {
      found.push(name);
    }
  }

  // Fallback: scan table cells
  if (found.length < 2) {
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((match = cellPattern.exec(html)) !== null) {
      const cellText = match[1].replace(/<[^>]+>/g, "").trim();
      const key = cellText.toLowerCase();
      if (knownFruits.has(key) && !found.includes(cellText)) {
        found.push(cellText);
      }
    }
  }
  return found;
}

// ── Next 4-hour reset ─────────────────────────────────────────────
function getNextReset() {
  const now  = new Date();
  const h    = now.getUTCHours();
  const next = new Date(now);
  next.setUTCHours(Math.ceil((h + 1) / 4) * 4 % 24, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

// ── Refresh ───────────────────────────────────────────────────────
async function refreshStock() {
  console.log(`[${new Date().toISOString()}] Refreshing from wiki...`);
  try {
    const fruits = await scrapeWiki();
    stockCache = { fruits, lastUpdated: new Date().toISOString(), nextReset: getNextReset(), source: "wiki" };
    console.log(`Stock updated: ${fruits.join(", ")}`);
  } catch (err) {
    console.error(`Scrape failed: ${err.message}`);
    if (stockCache.fruits.length > 0) {
      stockCache.source = "cached";
    } else {
      stockCache = { fruits: ["Flame","Ice","Smoke"], lastUpdated: new Date().toISOString(), nextReset: getNextReset(), source: "fallback" };
    }
  }
}

// ── HTTP server ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const path = req.url.split("?")[0];

  if (path === "/stock") {
    res.writeHead(200);
    res.end(JSON.stringify(stockCache));
    return;
  }
  if (path === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", fruitsInCache: stockCache.fruits.length }));
    return;
  }
  if (path === "/force-refresh") {
    refreshStock();
    res.writeHead(202);
    res.end(JSON.stringify({ message: "Refresh started" }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, async () => {
  console.log(`FruitAlarm backend running on port ${PORT}`);
  await refreshStock();
  setInterval(refreshStock, 14_400_000); // every 4 hours
});
