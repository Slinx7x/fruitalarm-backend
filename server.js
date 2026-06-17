// ================================================================
//  FruitAlarm Backend v6
//  Reads Vulcan bot's stock embed from your Discord server
//  No scraping. No broken APIs. Real stock from Discord.
// ================================================================

const https  = require("https");
const http   = require("http");
const PORT   = process.env.PORT || 3000;

// ── Config (set these in Render environment variables) ────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;   // your bot token
const CHANNEL_ID     = process.env.CHANNEL_ID || "1516502352281075884";

// ── Cache ─────────────────────────────────────────────────────────
let cache = {
  normalStock:     [],
  mirageStock:     [],
  lastUpdated:     null,
  nextResetNormal: null,
  nextResetMirage: null,
  source:          "pending",
};

// ── Known fruit names (exact spelling Vulcan uses) ────────────────
const KNOWN_FRUITS = new Set([
  "Rocket","Spin","Blade","Spring","Bomb","Smoke","Spike",
  "Flame","Ice","Sand","Dark","Eagle","Diamond",
  "Light","Rubber","Ghost","Magma",
  "Quake","Buddha","Love","Creation","Spider","Sound",
  "Portal","Phoenix","Lightning","Blizzard","Pain",
  "Gravity","Mammoth","T-Rex","Dough","Shadow",
  "Venom","Gas","Spirit","Tiger","Yeti","Kitsune","Control","Dragon",
]);

// Convert display name → our fruit id (matches fruits.js)
function toId(name) {
  return name.toLowerCase().replace(/[^a-z]/g,"").replace("trex","trex");
}

// ── Discord API call ──────────────────────────────────────────────
function discordGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "discord.com",
        path:     `/api/v10${path}`,
        method:   "GET",
        headers: {
          "Authorization": `Bot ${DISCORD_TOKEN}`,
          "Content-Type":  "application/json",
          "User-Agent":    "FruitAlarm (fan project, v6)",
        },
        timeout: 10000,
      },
      res => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch(e) { resolve({ status: res.statusCode, data: body }); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Discord API timeout")); });
    req.end();
  });
}

// ── Parse Vulcan embed ────────────────────────────────────────────
// Actual Vulcan format (from /debug):
// field.name = "**NORMAL STOCK**" or "**MIRAGE STOCK**"
// field.value = "<:spring:1300167775947460709> **Spring • <:money:...>`60,000`**\n..."
//
// Steps:
// 1. Check field name for NORMAL or MIRAGE
// 2. Strip all Discord emoji tags <:name:id> from value
// 3. Strip markdown bold **text**
// 4. Extract fruit name before the " • " separator
function parseVulcanEmbed(embeds) {
  const normalStock = [];
  const mirageStock = [];

  for (const embed of embeds) {
    const fields = embed.fields || [];

    for (const field of fields) {
      // Determine section from field name
      const fieldName = field.name || "";
      let section = null;
      if (/NORMAL/i.test(fieldName)) section = "normal";
      if (/MIRAGE/i.test(fieldName)) section = "mirage";
      if (!section) continue;

      const target = section === "normal" ? normalStock : mirageStock;

      // Process each line in the field value
      const lines = (field.value || "").split("\n");
      for (const line of lines) {
        // Remove Discord custom emoji tags: <:name:id>
        let clean = line.replace(/<:[^>]+>/g, "");
        // Remove markdown bold **
        clean = clean.replace(/\*\*/g, "");
        // Remove backtick numbers like `60,000`
        clean = clean.replace(/`[^`]+`/g, "");
        // Remove -# (Discord subtext prefix)
        clean = clean.replace(/^-#/, "");
        clean = clean.trim();

        // Now line looks like: "Spring • " or "Spring • "
        // Extract the fruit name — everything before " • "
        const parts = clean.split("•");
        if (parts.length < 2) continue;
        const name = parts[0].trim();
        if (!name) continue;

        // Match against known fruits
        for (const known of KNOWN_FRUITS) {
          if (known.toLowerCase() === name.toLowerCase()) {
            const id = toId(known);
            if (!target.includes(id)) target.push(id);
            break;
          }
        }
      }
    }
  }

  return { normalStock, mirageStock };
}

// ── Fetch latest Vulcan message from channel ──────────────────────
async function fetchFromDiscord() {
  if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN not set in environment variables");

  // Get last 20 messages from the stock channel
  const { status, data } = await discordGet(
    `/channels/${CHANNEL_ID}/messages?limit=20`
  );

  if (status === 401) throw new Error("Invalid bot token — check DISCORD_TOKEN");
  if (status === 403) throw new Error("Bot doesn't have permission to read this channel");
  if (status === 404) throw new Error("Channel not found — check CHANNEL_ID");
  if (status !== 200) throw new Error(`Discord API error: HTTP ${status}`);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("No messages found in channel");
  }

  // Find the most recent message from Vulcan that has embeds with stock data
  for (const msg of data) {
    // Vulcan sends embeds — look for messages with embeds containing "STOCK"
    if (!msg.embeds || msg.embeds.length === 0) continue;

    const hasStockEmbed = msg.embeds.some(e =>
      (e.title || "").toUpperCase().includes("STOCK") ||
      (e.description || "").toUpperCase().includes("STOCK") ||
      (e.fields || []).some(f =>
        f.name.toUpperCase().includes("STOCK") ||
        f.value.toUpperCase().includes("STOCK")
      ) ||
      // Also check for "NORMAL" or "MIRAGE" keywords
      JSON.stringify(e).toUpperCase().includes("NORMAL") ||
      JSON.stringify(e).toUpperCase().includes("MIRAGE")
    );

    if (!hasStockEmbed) continue;

    // Parse the embed
    const { normalStock, mirageStock } = parseVulcanEmbed(msg.embeds);

    if (normalStock.length > 0 || mirageStock.length > 0) {
      console.log(`✅ Found Vulcan stock message (ID: ${msg.id})`);
      return { normalStock, mirageStock, source: "discord-vulcan" };
    }
  }

  throw new Error("No valid Vulcan stock embed found in last 20 messages");
}

// ── Next reset times ──────────────────────────────────────────────
function nextReset(hours) {
  const now   = new Date();
  const sec   = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
  const cycle = hours * 3600;
  return new Date(now.getTime() + (cycle - sec % cycle) * 1000).toISOString();
}

// ── Main refresh ──────────────────────────────────────────────────
async function refresh() {
  console.log(`\n[${new Date().toISOString()}] Refreshing stock from Discord...`);
  try {
    const result = await fetchFromDiscord();
    cache = {
      normalStock:     result.normalStock,
      mirageStock:     result.mirageStock,
      lastUpdated:     new Date().toISOString(),
      nextResetNormal: nextReset(4),
      nextResetMirage: nextReset(2),
      source:          result.source,
    };
    console.log(`✅ Normal: ${result.normalStock.join(", ") || "none"}`);
    console.log(`✅ Mirage: ${result.mirageStock.join(", ") || "none"}`);
  } catch(e) {
    console.error(`❌ Discord fetch failed: ${e.message}`);
    if (cache.normalStock.length > 0) {
      cache.source      = "cached";
      cache.lastUpdated = new Date().toISOString();
      console.log(`⚠️  Serving cached stock: ${cache.normalStock.join(", ")}`);
    } else {
      cache = {
        normalStock:     [],
        mirageStock:     [],
        lastUpdated:     new Date().toISOString(),
        nextResetNormal: nextReset(4),
        nextResetMirage: nextReset(2),
        source:          "fallback",
      };
      console.log(`⚠️  No cache available — serving empty stock`);
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

  if (path === "/stock") {
    res.writeHead(200);
    res.end(JSON.stringify(cache));
    return;
  }
  if (path === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      status:      "ok",
      source:      cache.source,
      normalCount: cache.normalStock.length,
      mirageCount: cache.mirageStock.length,
      lastUpdated: cache.lastUpdated,
      tokenSet:    !!DISCORD_TOKEN,
      channelId:   CHANNEL_ID,
    }));
    return;
  }
  if (path === "/force-refresh") {
    refresh();
    res.writeHead(202);
    res.end(JSON.stringify({ message: "Refreshing — check /stock in 5 seconds" }));
    return;
  }

  // /debug — shows raw Discord messages to diagnose Vulcan format
  if (path === "/debug") {
    discordGet(`/channels/${CHANNEL_ID}/messages?limit=5`)
      .then(({ status, data }) => {
        const simplified = Array.isArray(data) ? data.map(m => ({
          id:      m.id,
          author:  m.author?.username,
          content: m.content,
          embeds:  m.embeds,
        })) : data;
        res.writeHead(200);
        res.end(JSON.stringify(simplified, null, 2));
      })
      .catch(e => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Try /stock, /health, /debug or /force-refresh" }));
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🍈 FruitAlarm backend v6`);
  console.log(`   Channel : ${CHANNEL_ID}`);
  console.log(`   Token   : ${DISCORD_TOKEN ? "✅ set" : "❌ MISSING — set DISCORD_TOKEN in Render"}`);
  await refresh();
  // Refresh every 30 minutes — catches stock updates quickly
  setInterval(refresh, 30 * 60 * 1000);
});
