const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const publicDir = __dirname;
const envPath = path.join(root, ".env.local");
const dataDir = path.join(root, "work");
const sharedStatePath = path.join(dataDir, "playscope-shared-state.json");

function readEnv() {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

let env = readEnv();

function writeEnv(updates) {
  env = { ...env, ...updates };
  const order = ["YOUTUBE_API_KEY", "OPENAI_API_KEY", "GPT_API_BASE_URL", "GPT_MODEL", "GOOGLE_CLIENT_SECRET"];
  const keys = [...new Set([...order, ...Object.keys(env)])].filter((key) => env[key] !== undefined && env[key] !== "");
  fs.writeFileSync(envPath, keys.map((key) => `${key}=${env[key]}`).join("\n"), "utf8");
}

function getAiBaseUrl() {
  return (env.GPT_API_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function getAiModel() {
  return env.GPT_MODEL || "gpt-4o-mini";
}

function getTeamPassword() {
  return env.TEAM_PASSWORD || "";
}

function isAuthed(req) {
  const password = getTeamPassword();
  if (!password) return true;
  return req.headers["x-team-password"] === password;
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 12_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readSharedState() {
  if (!fs.existsSync(sharedStatePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(sharedStatePath, "utf8"));
  } catch (error) {
    return {};
  }
}

function writeSharedState(state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sharedStatePath, JSON.stringify({
    ...state,
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");
}

function demoInfluencer(input, reason = "Real API was unavailable or the API request failed.") {
  const genres = String(input.genres || "strategy mobile").split(/[,\s]+/).filter(Boolean);
  return {
    source: "demo",
    name: input.name || "Creator",
    handle: "@" + String(input.name || "creator").toLowerCase().replace(/[^a-z0-9]/g, ""),
    country: input.country || "Turkey",
    flag: input.country === "Germany" ? "DE" : input.country === "USA" ? "US" : "TR",
    channel: input.channel || "YouTube",
    views: Number(input.views) || 62000,
    match: genres.includes("strategy") ? 86 : 68,
    genres,
    tone: "research",
    audience: "estimated players",
    notes: `Demo result. ${reason}`,
    shortlisted: false,
    note: ""
  };
}

async function youtubeResearch(input) {
  if (!env.YOUTUBE_API_KEY || typeof fetch !== "function") return demoInfluencer(input, "YouTube API key is missing or the runtime cannot make external requests.");
  const query = encodeURIComponent(input.name || "");
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${query}&key=${env.YOUTUBE_API_KEY}`;
  let searchResponse;
  try {
    searchResponse = await fetch(searchUrl);
  } catch (error) {
    return demoInfluencer(input, `Could not connect to YouTube Data API: ${error.message}. Check network/VPN/proxy access to www.googleapis.com.`);
  }
  const search = await searchResponse.json();
  if (!searchResponse.ok) {
    const reason = search.error?.errors?.[0]?.reason || search.error?.message || `YouTube returned HTTP ${searchResponse.status}.`;
    return demoInfluencer(input, `YouTube API error: ${reason}`);
  }
  const channelId = search.items?.[0]?.snippet?.channelId;
  if (!channelId) return demoInfluencer(input, "No matching YouTube channel was found. Try the exact YouTube channel name or channel URL.");

  const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${env.YOUTUBE_API_KEY}`;
  const channelData = await fetch(channelUrl).then((res) => res.json());
  const channel = channelData.items?.[0];
  if (!channel) return demoInfluencer(input, "YouTube channel lookup returned no details.");

  const videoSearchUrl = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&order=date&type=video&maxResults=8&key=${env.YOUTUBE_API_KEY}`;
  const videoSearch = await fetch(videoSearchUrl).then((res) => res.json());
  const ids = (videoSearch.items || []).map((item) => item.id?.videoId).filter(Boolean);
  let avgViews = Number(input.views) || 0;
  if (ids.length) {
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(",")}&key=${env.YOUTUBE_API_KEY}`;
    const videoData = await fetch(videosUrl).then((res) => res.json());
    const counts = (videoData.items || []).map((item) => Number(item.statistics?.viewCount || 0)).filter(Boolean);
    if (counts.length) avgViews = Math.round(counts.reduce((sum, value) => sum + value, 0) / counts.length);
  }

  const genres = String(input.genres || "game mobile").split(/[,\s]+/).filter(Boolean);
  return {
    source: "youtube",
    name: channel.snippet?.title || input.name,
    handle: "@" + (channel.snippet?.customUrl || channel.snippet?.title || input.name || "creator").replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_.-]/g, ""),
    country: input.country || "Unknown",
    flag: input.country === "Germany" ? "DE" : input.country === "USA" ? "US" : "TR",
    channel: "YouTube",
    views: avgViews || Number(channel.statistics?.viewCount || 0),
    match: genres.includes("strategy") || genres.includes("space") ? 88 : 70,
    genres,
    tone: "youtube researched",
    audience: `${channel.statistics?.subscriberCount || "unknown"} subscribers`,
    notes: `YouTube channel found. Recent-video average is based on up to ${ids.length} latest videos.`,
    shortlisted: false,
    note: ""
  };
}

async function openAiText(prompt) {
  if (!env.OPENAI_API_KEY || typeof fetch !== "function") return null;
  const response = await fetch(`${getAiBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: getAiModel(),
      messages: [
        { role: "system", content: "You are a concise game marketing localization assistant. Return only the requested copy." },
        { role: "user", content: prompt }
      ],
      temperature: 0.4
    })
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

function parseJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (innerError) {
      return null;
    }
  }
}

function cleanOcrInfluencer(raw, current = {}) {
  if (!raw || typeof raw !== "object") return null;
  const keywords = Array.isArray(raw.keywords) ? raw.keywords.join(", ") : String(raw.keywords || current.keywords || "");
  const genres = keywords.split(/[,;\s]+/).filter(Boolean).slice(0, 8);
  return {
    source: "screen-ocr",
    name: raw.name || current.name || "Influencer",
    link: current.link || "",
    handle: current.handle || "",
    country: raw.geo || current.country || "Missing",
    geo: raw.geo || current.geo || "Missing",
    category: raw.category || current.category || "Gaming",
    subcategory: raw.subcategory || current.subcategory || (genres.length ? genres.join(" / ") : "Visible screen"),
    subscribers: raw.subscribers || current.subscribers || "Missing",
    gender: raw.gender || current.gender || "Missing",
    age: raw.age || current.age || "Missing",
    demographicsSource: raw.gender || raw.age || raw.geo ? "Screen OCR / Scrumball panel" : "Missing",
    flag: current.flag || "",
    channel: current.channel || "YouTube",
    views: Number(raw.avgViews || raw.views || current.views || 0),
    avgComments: Number(raw.avgComments || current.avgComments || 0),
    match: Number(current.match || 70),
    format: raw.format || current.format || "Visible screen",
    duration: raw.duration || current.duration || "-",
    keywords,
    comments: raw.comments || "Extracted from visible Scrumball panel screenshot.",
    genres: genres.length ? genres : current.genres || ["youtube"],
    tone: current.tone || "collected",
    audience: raw.subscribers || current.audience || "Missing",
    notes: "Screen read attempted on the visible tab. Review once before export.",
    shortlisted: false,
    note: current.note || ""
  };
}

async function ocrScreenshot(input) {
  if (!env.OPENAI_API_KEY || typeof fetch !== "function") {
    return { ok: false, error: "OpenAI API key is missing or backend cannot make external requests." };
  }
  if (!input.image || !String(input.image).startsWith("data:image/")) {
    return { ok: false, error: "No screenshot image received." };
  }

  const prompt = `Extract influencer analytics from this screenshot. It may show a Scrumball-like panel on YouTube.
Return JSON only with these keys:
name, subscribers, geo, gender, age, avgViews, avgComments, category, subcategory, format, duration, keywords, comments.
Rules:
- Use only text visible in the image.
- If a field is not visible, use an empty string.
- avgViews and avgComments must be numbers when visible. Convert K/M suffixes.
- keywords can be an array or comma-separated string.
- Do not guess gender, age, or geo.`;

  const response = await fetch(`${getAiBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: getAiModel(),
      messages: [
        { role: "system", content: "You extract structured influencer marketing data from screenshots. Return strict JSON only." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: input.image } }
          ]
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, error: `OpenAI screen read failed: HTTP ${response.status}. ${detail.slice(0, 180)}` };
  }
  const data = await response.json();
  const parsed = parseJsonObject(data.choices?.[0]?.message?.content || "");
  const item = cleanOcrInfluencer(parsed, input.current || {});
  if (!item) return { ok: false, error: "OpenAI did not return parseable JSON." };
  return { ok: true, item };
}

async function readImageData(input) {
  if (!env.OPENAI_API_KEY || typeof fetch !== "function") {
    return { ok: false, error: "GPT API key is missing or backend cannot make external requests." };
  }
  if (!input.image || !String(input.image).startsWith("data:image/")) {
    return { ok: false, error: "No image received." };
  }
  const preferred = getAiModel();
  const modelCandidates = [...new Set([
    preferred && preferred !== "auto" ? preferred : "",
    "gpt-4o",
    "gpt-4.1",
    "gpt-5",
    "gpt-5-mini",
    "chatgpt-4o-latest"
  ].filter(Boolean))];
  let lastError = "";
  for (const model of modelCandidates) {
    const response = await fetch(`${getAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Extract influencer research table data from images. Return strict JSON only. Do not invent missing values." },
          {
            role: "user",
            content: [
              { type: "text", text: `Read this image. It belongs to this creator/channel when provided: ${JSON.stringify(input.context || {})}. Extract every visible influencer/creator row as JSON. Return exactly: {\"rows\":[{\"Channel Name\":\"\",\"Link\":\"\",\"GEO\":\"\",\"Category\":\"\",\"Subcategory\":\"\",\"Subscribers\":\"\",\"avg Views\":\"\",\"Avg Comments\":\"\",\"Format\":\"\",\"Duration\":\"\",\"Keywords\":\"\",\"Comments\":\"\"}]}. If a cell is not visible, leave it empty. Preserve YouTube links and names exactly. For Scrumball screenshots, include followers, avg engagement, avg view rate, monthly post, audience location countries, and visible age/gender analysis in Comments.` },
              { type: "image_url", image_url: { url: input.image } }
            ]
          }
        ],
        temperature: 0,
        max_tokens: 1800,
        stream: false
      })
    }).catch((error) => ({ ok: false, status: "network", error }));
    if (!response.ok) {
      const detail = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      lastError = response.error?.message || `HTTP ${response.status}. ${detail}`.slice(0, 220);
      continue;
    }
    const data = await response.json();
    const parsed = parseJsonObject(data.choices?.[0]?.message?.content || "");
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (rows.length) return { ok: true, source: "backend-gpt-vision", model, rows };
    lastError = "GPT returned no usable rows.";
  }
  return { ok: false, error: `GPT image read failed: ${lastError}` };
}

async function localize(input) {
  const languageName = input.lang === "zh" ? "Chinese" : input.lang === "tr" ? "Turkish" : "English";
  const prompt = `Localize this mobile game store copy into ${languageName}. Tone: ${input.tone || "energetic"}.
Project: ${input.project?.name || "Game"}.
Source: ${input.source || ""}`;
  const ai = await openAiText(prompt);
  if (ai) return { source: "openai", text: ai };
  const fallback = {
    tr: `Filonu kur, bilinmeyen galaksileri kesfet ve hizli mobil strateji savaslarinda rakip komutanlari alt et. Ton: ${input.tone || "Energetic"}.`,
    en: `Build your fleet, explore unknown galaxies, and outplay rival commanders in fast mobile strategy battles. Tone: ${input.tone || "Energetic"}.`,
    zh: `组建你的舰队，探索未知星系，在快节奏移动策略战斗中击败对手。语气：${input.tone || "Energetic"}。`
  };
  return { source: "demo", text: fallback[input.lang] || fallback.en };
}

function serveFile(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const fileName = urlPath === "/" ? "playscope-prototype.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, fileName);
  const safeRoot = path.resolve(publicDir).toLowerCase();
  const safeFile = filePath.toLowerCase();
  if (!safeFile.startsWith(safeRoot) || !fs.existsSync(filePath)) return send(res, 404, "Not found", "text/plain");
  const ext = path.extname(filePath);
  const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
  send(res, 200, fs.readFileSync(filePath), type);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    if (req.method === "POST" && req.url === "/api/research") {
      const body = await readJson(req);
      const result = await youtubeResearch(body).catch(() => demoInfluencer(body));
      return send(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/api/localize") {
      const body = await readJson(req);
      const result = await localize(body).catch(() => ({ source: "demo", text: "Localization failed; demo mode is still available." }));
      return send(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/api/ocr-screenshot") {
      const body = await readJson(req);
      const result = await ocrScreenshot(body).catch((error) => ({ ok: false, error: error.message }));
      return send(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/api/read-image-data") {
      const body = await readJson(req);
      const result = await readImageData(body).catch((error) => ({ ok: false, error: error.message }));
      return send(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/api/save-config") {
      const body = await readJson(req);
      const updates = {};
      if (body.youtubeApiKey) updates.YOUTUBE_API_KEY = body.youtubeApiKey;
      if (body.openaiApiKey) updates.OPENAI_API_KEY = body.openaiApiKey;
      if (body.openaiBaseUrl) updates.GPT_API_BASE_URL = body.openaiBaseUrl;
      if (body.openaiModel) updates.GPT_MODEL = body.openaiModel;
      if (body.googleSecret) updates.GOOGLE_CLIENT_SECRET = body.googleSecret;
      if (body.teamPassword) updates.TEAM_PASSWORD = body.teamPassword;
      writeEnv(updates);
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/api/team-status") {
      return send(res, 200, {
        passwordRequired: Boolean(getTeamPassword())
      });
    }
    if (req.method === "POST" && req.url === "/api/team-login") {
      const body = await readJson(req);
      const password = getTeamPassword();
      return send(res, 200, {
        ok: !password || body.password === password,
        passwordRequired: Boolean(password)
      });
    }
    if (req.method === "GET" && req.url === "/api/shared-state") {
      if (!isAuthed(req)) return send(res, 401, { ok: false, error: "Team password required." });
      return send(res, 200, { ok: true, state: readSharedState() });
    }
    if (req.method === "POST" && req.url === "/api/shared-state") {
      if (!isAuthed(req)) return send(res, 401, { ok: false, error: "Team password required." });
      const body = await readJson(req);
      writeSharedState(body.state || {});
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/extension-import") {
      const body = await readJson(req);
      const importPath = path.join(root, "work", "playscope-extension-import.json");
      fs.mkdirSync(path.dirname(importPath), { recursive: true });
      fs.writeFileSync(importPath, JSON.stringify(body, null, 2), "utf8");
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/api/extension-import") {
      const importPath = path.join(root, "work", "playscope-extension-import.json");
      if (!fs.existsSync(importPath)) return send(res, 200, { item: null });
      return send(res, 200, { item: JSON.parse(fs.readFileSync(importPath, "utf8")) });
    }
    if (req.method === "GET" && req.url === "/api/status") {
      return send(res, 200, {
        youtube: Boolean(env.YOUTUBE_API_KEY),
        openai: Boolean(env.OPENAI_API_KEY),
        googleSecret: Boolean(env.GOOGLE_CLIENT_SECRET)
      });
    }
    if (req.method === "GET" && req.url === "/api/client-config") {
      return send(res, 200, {
        youtubeApiKey: env.YOUTUBE_API_KEY || "",
        openaiApiKey: env.OPENAI_API_KEY || "",
        openaiBaseUrl: getAiBaseUrl(),
        openaiModel: getAiModel()
      });
    }
    return serveFile(req, res);
  } catch (error) {
    return send(res, 500, { error: "Server error", detail: error.message });
  }
});

const port = Number(process.env.PORT || 5177);
server.listen(port, "127.0.0.1", () => {
  console.log(`PlayScope running at http://127.0.0.1:${port}`);
});
