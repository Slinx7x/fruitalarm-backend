// ================================================================
//  FruitAlarm Backend v7
//  Discord stock reader + Firebase push notifications
// ================================================================

const https  = require("https");
const http   = require("http");
const PORT   = process.env.PORT || 3000;

// ── Config from Render environment variables ──────────────────────
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN;
const CHANNEL_ID       = process.env.CHANNEL_ID || "1516502352281075884";
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_EMAIL   = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_KEY     = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// ── In-memory stores ──────────────────────────────────────────────
let cache = {
  normalStock: [], mirageStock: [],
  lastUpdated: null, nextResetNormal: null, nextResetMirage: null,
  source: "pending",
};

// FCM tokens submitted by users: { token, wishlist: [], alarmMode }
let userTokens = [];

// ── Known fruits ──────────────────────────────────────────────────
const KNOWN_FRUITS = new Set([
  "Rocket","Spin","Blade","Spring","Bomb","Smoke","Spike",
  "Flame","Ice","Sand","Dark","Eagle","Diamond",
  "Light","Rubber","Ghost","Magma",
  "Quake","Buddha","Love","Creation","Spider","Sound",
  "Portal","Phoenix","Lightning","Blizzard","Pain",
  "Gravity","Mammoth","T-Rex","Dough","Shadow",
  "Venom","Gas","Spirit","Tiger","Yeti","Kitsune","Control","Dragon",
]);
function toId(name) { return name.toLowerCase().replace(/[^a-z]/g,""); }

// ── HTTP helpers ──────────────────────────────────────────────────
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

function discordGet(path) {
  return request({
    hostname: "discord.com",
    path: `/api/v10${path}`,
    method: "GET",
    headers: {
      "Authorization": `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "FruitAlarm/7.0",
    },
    timeout: 10000,
  });
}

// ── Parse Vulcan embed ────────────────────────────────────────────
function parseVulcanEmbed(embeds) {
  const normalStock = [], mirageStock = [];
  for (const embed of embeds) {
    for (const field of (embed.fields || [])) {
      const fieldName = field.name || "";
      let section = null;
      if (/NORMAL/i.test(fieldName)) section = "normal";
      if (/MIRAGE/i.test(fieldName)) section = "mirage";
      if (!section) continue;
      const target = section === "normal" ? normalStock : mirageStock;
      for (const line of (field.value || "").split("\n")) {
        let clean = line.replace(/<:[^>]+>/g,"").replace(/<t:[^>]+>/g,"")
                       .replace(/\*\*/g,"").replace(/`[^`]+`/g,"")
                       .replace(/^-#/,"").trim();
        const parts = clean.split("•");
        if (parts.length < 2) continue;
        const name = parts[0].trim();
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

// ── Firebase OAuth2 token ─────────────────────────────────────────
// We implement a minimal JWT signer to get Firebase access tokens
// without needing the firebase-admin npm package
const crypto = require("crypto");

function base64url(str) {
  return Buffer.from(str).toString("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

async function getFirebaseToken() {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss: FIREBASE_EMAIL,
    sub: FIREBASE_EMAIL,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  };
  const header  = base64url(JSON.stringify({ alg:"RS256", typ:"JWT" }));
  const payload = base64url(JSON.stringify(claim));
  const sign    = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(FIREBASE_KEY, "base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  const jwt = `${header}.${payload}.${sig}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const { data } = await request({
    hostname: "oauth2.googleapis.com",
    path: "/token",
    method: "POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    timeout: 10000,
  }, body);
  return data.access_token;
}

// ── Send FCM push notification ────────────────────────────────────
async function sendPush(token, fruitName, stockType) {
  try {
    const accessToken = await getFirebaseToken();
    const label = stockType === "mirage" ? "Mirage Stock" : "Normal Stock";
    const msg = {
      message: {
        token,
        notification: {
          title: `🚨 ${fruitName} is in ${label}!`,
          body:  `Buy it now before the stock resets!`,
        },
        webpush: {
          notification: {
            icon:  "/icon.svg",
            badge: "/icon.svg",
            vibrate: [200, 100, 200, 100, 200],
            requireInteraction: true,
            tag: "fruit-stock-alert",
          },
          fcm_options: { link: "/" },
        },
      },
    };
    const body = JSON.stringify(msg);
    const { status, data } = await request({
      hostname: "fcm.googleapis.com",
      path: `/v1/projects/${FIREBASE_PROJECT}/messages:send`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    }, body);
    if (status === 200) {
      console.log(`📲 Push sent to token ...${token.slice(-8)}: ${fruitName}`);
    } else {
      console.warn(`⚠️ Push failed (${status}):`, data);
      // Remove invalid tokens
      if (data?.error?.status === "INVALID_ARGUMENT" || data?.error?.status === "NOT_FOUND") {
        userTokens = userTokens.filter(u => u.token !== token);
        console.log(`🗑️ Removed invalid token ...${token.slice(-8)}`);
      }
    }
  } catch(e) {
    console.error(`❌ Push error: ${e.message}`);
  }
}

// ── Check wishlist matches and send pushes ────────────────────────
async function checkAndNotify(normalStock, mirageStock) {
  if (userTokens.length === 0) return;
  const normalIds = new Set(normalStock);
  const mirageIds = new Set(mirageStock);

  for (const user of userTokens) {
    const mode     = user.alarmMode || "both";
    const wishlist = user.wishlist  || [];
    for (const id of wishlist) {
      if ((mode === "both" || mode === "normal") && normalIds.has(id)) {
        const name = id.charAt(0).toUpperCase() + id.slice(1);
        await sendPush(user.token, name, "normal");
        break;
      }
      if ((mode === "both" || mode === "mirage") && mirageIds.has(id)) {
        const name = id.charAt(0).toUpperCase() + id.slice(1);
        await sendPush(user.token, name, "mirage");
        break;
      }
    }
  }
}

// ── Discord fetch ─────────────────────────────────────────────────
async function fetchFromDiscord() {
  if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN not set");
  const { status, data } = await discordGet(`/channels/${CHANNEL_ID}/messages?limit=20`);
  if (status === 401) throw new Error("Invalid bot token");
  if (status === 403) throw new Error("No permission to read channel");
  if (status === 404) throw new Error("Channel not found");
  if (status !== 200) throw new Error(`Discord API error: HTTP ${status}`);
  if (!Array.isArray(data) || data.length === 0) throw new Error("No messages in channel");

  let normalStock = [];
  let mirageStock = [];

  // Scan all recent messages — collect Normal and Mirage separately
  // because stockalert posts them as two separate messages
  for (const msg of data) {
    if (!msg.embeds?.length) {
      console.log(`  Skipping msg ${msg.id} — no embeds`);
      continue;
    }
    console.log(`  Parsing msg ${msg.id} from "${msg.author?.username}" — ${msg.embeds.length} embed(s)`);
    const { normalStock: n, mirageStock: m } = parseVulcanEmbed(msg.embeds);
    console.log(`  → Normal: [${n.join(",")}] Mirage: [${m.join(",")}]`);
    if (n.length > 0 && normalStock.length === 0) normalStock = n;
    if (m.length > 0 && mirageStock.length === 0) mirageStock = m;
    if (normalStock.length > 0 && mirageStock.length > 0) break;
  }

  if (normalStock.length === 0 && mirageStock.length === 0) {
    throw new Error("No valid Vulcan stock found in last 20 messages");
  }

  return { normalStock, mirageStock, source: "discord-vulcan" };
}

function nextReset(hours) {
  const now = new Date();
  const sec = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
  const cycle = hours * 3600;
  return new Date(now.getTime() + (cycle - sec % cycle) * 1000).toISOString();
}

// ── Main refresh ──────────────────────────────────────────────────
async function refresh() {
  console.log(`\n[${new Date().toISOString()}] Refreshing...`);
  try {
    const result = await fetchFromDiscord();
    const prevNormal = new Set(cache.normalStock);
    const prevMirage = new Set(cache.mirageStock);

    cache = {
      normalStock:     result.normalStock,
      mirageStock:     result.mirageStock,
      lastUpdated:     new Date().toISOString(),
      nextResetNormal: nextReset(4),
      nextResetMirage: nextReset(2),
      source:          result.source,
    };

    console.log(`✅ Normal: ${result.normalStock.join(", ")||"none"}`);
    console.log(`✅ Mirage: ${result.mirageStock.join(", ")||"none"}`);

    // Only send push if stock actually changed
    const normalChanged = result.normalStock.some(f => !prevNormal.has(f));
    const mirageChanged = result.mirageStock.some(f => !prevMirage.has(f));
    if (normalChanged || mirageChanged) {
      console.log(`📲 Stock changed — sending push notifications...`);
      await checkAndNotify(result.normalStock, result.mirageStock);
    }
  } catch(e) {
    console.error(`❌ Refresh failed: ${e.message}`);
    if (cache.normalStock.length > 0) {
      cache.source = "cached";
      cache.lastUpdated = new Date().toISOString();
    } else {
      cache = {
        normalStock: [], mirageStock: [],
        lastUpdated: new Date().toISOString(),
        nextResetNormal: nextReset(4),
        nextResetMirage: nextReset(2),
        source: "fallback",
      };
    }
  }
}

// ── HTTP Server ───────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const path = req.url.split("?")[0];

  // ── GET /stock ──
  if (req.method === "GET" && path === "/stock") {
    res.writeHead(200);
    res.end(JSON.stringify(cache));
    return;
  }

  // ── GET /health ──
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: "ok", source: cache.source,
      normalCount: cache.normalStock.length,
      mirageCount: cache.mirageStock.length,
      lastUpdated: cache.lastUpdated,
      tokenSet: !!DISCORD_TOKEN,
      firebaseSet: !!FIREBASE_KEY,
      subscribers: userTokens.length,
    }));
    return;
  }

  // ── GET /force-refresh ──
  if (req.method === "GET" && path === "/force-refresh") {
    refresh();
    res.writeHead(202);
    res.end(JSON.stringify({ message: "Refreshing..." }));
    return;
  }

  // ── POST /subscribe — frontend sends FCM token + wishlist ──
  if (req.method === "POST" && path === "/subscribe") {
    const body = await parseBody(req);
    const { token, wishlist, alarmMode } = body;
    if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: "token required" })); return; }
    // Update or add token
    const existing = userTokens.findIndex(u => u.token === token);
    if (existing >= 0) {
      userTokens[existing] = { token, wishlist: wishlist||[], alarmMode: alarmMode||"both" };
    } else {
      userTokens.push({ token, wishlist: wishlist||[], alarmMode: alarmMode||"both" });
    }
    console.log(`📱 Subscriber updated: ...${token.slice(-8)} | wishlist: ${(wishlist||[]).join(",")} | mode: ${alarmMode}`);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, subscribers: userTokens.length }));
    return;
  }

  // ── GET /debug ──
  if (req.method === "GET" && path === "/debug") {
    discordGet(`/channels/${CHANNEL_ID}/messages?limit=5`)
      .then(({ status, data }) => {
        const simplified = Array.isArray(data) ? data.map(m => ({
          id: m.id, author: m.author?.username,
          content: m.content, embeds: m.embeds,
        })) : data;
        res.writeHead(200);
        res.end(JSON.stringify(simplified, null, 2));
      })
      .catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Try /stock, /health, /force-refresh" }));
});

server.listen(PORT, async () => {
  console.log(`\n🍈 FruitAlarm backend v7`);
  console.log(`   Discord channel : ${CHANNEL_ID}`);
  console.log(`   Firebase project: ${FIREBASE_PROJECT || "NOT SET"}`);
  console.log(`   Token set       : ${!!DISCORD_TOKEN}`);
  console.log(`   Firebase key    : ${!!FIREBASE_KEY}\n`);
  await refresh();
  setInterval(refresh, 30 * 60 * 1000);
});
