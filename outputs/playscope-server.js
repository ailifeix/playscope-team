const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
let googlePlayScraper = null;
try {
  googlePlayScraper = require("google-play-scraper");
} catch (error) {
  googlePlayScraper = null;
}

const root = path.resolve(__dirname, "..");
const publicDir = __dirname;
const envPath = path.join(root, ".env.local");
const dataDir = path.join(root, "work");
const sharedStatePath = path.join(dataDir, "playscope-shared-state.json");

function readEnv() {
  const env = { ...process.env };
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
  const order = ["YOUTUBE_API_KEY", "OPENAI_API_KEY", "GPT_API_BASE_URL", "GPT_MODEL", "SERPAPI_KEY", "GOOGLE_CLIENT_SECRET", "TEAM_PASSWORD"];
  const keys = order.filter((key) => env[key] !== undefined && env[key] !== "");
  fs.writeFileSync(envPath, keys.map((key) => `${key}=${env[key]}`).join("\n"), "utf8");
}

function getAiBaseUrl() {
  return (env.GPT_API_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function getAiModel() {
  return env.GPT_MODEL && env.GPT_MODEL !== "auto" ? env.GPT_MODEL : "gpt-4o-mini";
}

function getTeamPassword() {
  return env.TEAM_PASSWORD || "";
}

function getSerpApiKey() {
  return env.SERPAPI_KEY || env.SERP_API_KEY || "";
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
    "Access-Control-Allow-Headers": "Content-Type, X-Team-Password"
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
name, subscribers, geo, gender, age, avgViews, category, subcategory, format, duration, keywords, comments.
Rules:
- Use only text visible in the image.
- If a field is not visible, use an empty string.
- avgViews must be a number when visible. Convert K/M suffixes.
- age must contain only age average or age ranges. Do not include Female/Male/M/F percentages in age.
- gender must contain only gender split, for example "F65% / M35%".
- If an age/gender bar chart is visible, calculate age as Female+Male total for each age group, for example "13-17: 14%; 18-24: 44%; 25-34: 25%".
- For the same chart, calculate gender separately as total Female vs Male, for example "F52% / M48%".
- Do not write "Dominant age", "Avg age", or explanatory text inside age. Use only the value.
- keywords can be an array or comma-separated string. Use only visible game names, tags, or meaningful content keywords. Do not include UI labels, URLs, tracking text, social links, or random OCR fragments.
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
              { type: "text", text: `Read this image. It belongs to this creator/channel when provided: ${JSON.stringify(input.context || {})}. Extract every visible influencer/creator row as JSON. Return exactly: {\"rows\":[{\"Channel Name\":\"\",\"Link\":\"\",\"GEO\":\"\",\"Gender\":\"\",\"Age\":\"\",\"Category\":\"\",\"Subcategory\":\"\",\"Subscribers\":\"\",\"avg Views\":\"\",\"Avg Comments\":\"\",\"Format\":\"\",\"Duration\":\"\",\"Keywords\":\"\",\"Comments\":\"\"}]}. If a cell is not visible, leave it empty. Preserve YouTube links and names exactly. For Scrumball screenshots, include followers, avg engagement, avg view rate, monthly post, audience location countries, and visible age/gender analysis. If an age/gender bar chart is visible, calculate Age as total Female+Male per age group, formatted like \"13-17: 14%; 18-24: 44%; 25-34: 25%\". Calculate Gender separately as total Female vs Male, formatted like \"F52% / M48%\". Do not put gender percentages inside Age.` },
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

function demoLocalizeGameText(source = "", lang = "en") {
  let text = String(source || "").trim();
  if (!text) return lang === "tr" ? "Filonu kur" : lang === "zh" ? "组建舰队" : "Build your fleet";
  const dictionaries = {
    tr: {
      "build your fleet, explore unknown galaxies, and outsmart rival commanders in fast mobile strategy battles.": "Filonu kur, bilinmeyen galaksileri keşfet ve hızlı mobil strateji savaşlarında rakip komutanları zekânla alt et.",
      "explore unknown galaxies": "bilinmeyen galaksileri keşfet",
      "outsmart rival commanders": "rakip komutanları zekânla alt et",
      "fast mobile strategy battles": "hızlı mobil strateji savaşları",
      "rival commanders": "rakip komutanlar",
      "unknown galaxies": "bilinmeyen galaksiler",
      "build your fleet": "Filonu kur",
      "join a guild": "Bir loncaya katıl",
      "upgrade your hero": "Kahramanını geliştir",
      "claim rewards": "Ödülleri topla",
      "start battle": "Savaşı başlat",
      "tap to continue": "Devam etmek için dokun",
      "daily quest": "Günlük görev",
      "victory": "Zafer",
      "defeat": "Yenilgi",
      "fleet": "Filo",
      "explore": "keşfet",
      "unknown": "bilinmeyen",
      "galaxies": "galaksiler",
      "outsmart": "zekânla alt et",
      "rival": "rakip",
      "commanders": "komutanlar",
      "strategy": "strateji",
      "guild": "Lonca",
      "quest": "Görev",
      "reward": "Ödül",
      "battle": "Savaş",
      "build": "Kur",
      "upgrade": "Geliştir",
      "collect": "Topla"
    },
    zh: {
      "build your fleet, explore unknown galaxies, and outsmart rival commanders in fast mobile strategy battles.": "组建舰队，探索未知星系，在快节奏移动策略战斗中智胜敌方指挥官。",
      "explore unknown galaxies": "探索未知星系",
      "outsmart rival commanders": "智胜敌方指挥官",
      "fast mobile strategy battles": "快节奏移动策略战斗",
      "rival commanders": "敌方指挥官",
      "unknown galaxies": "未知星系",
      "build your fleet": "组建舰队",
      "join a guild": "加入公会",
      "upgrade your hero": "升级英雄",
      "claim rewards": "领取奖励",
      "start battle": "开始战斗",
      "tap to continue": "点击继续",
      "daily quest": "每日任务",
      "victory": "胜利",
      "defeat": "失败",
      "fleet": "舰队",
      "guild": "公会",
      "quest": "任务",
      "reward": "奖励",
      "battle": "战斗",
      "build": "建造",
      "upgrade": "升级",
      "collect": "收集"
    }
  };
  const dict = dictionaries[lang] || {};
  Object.entries(dict).sort((a, b) => b[0].length - a[0].length).forEach(([from, to]) => {
    text = text.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), to);
  });
  return text;
}

async function googleTranslateText(source = "", lang = "en") {
  const text = String(source || "").trim();
  if (!text || typeof fetch !== "function") return "";
  const target = lang === "zh" ? "zh-CN" : lang === "tr" ? "tr" : "en";
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 PlayScope/1.0",
      "Accept": "application/json,text/plain,*/*"
    }
  }, 12000);
  if (!response.ok) throw new Error(`Google translate HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.[0]) ? data[0].map((part) => part?.[0] || "").join("").trim() : "";
}

function shortLocalizationText(text = "", lang = "en", source = "") {
  const clean = String(text || "").trim();
  const sourceText = String(source || "").trim();
  if (!clean) return "";
  if (lang === "zh") return clean.split(/[，。！？]/)[0].slice(0, 8);
  if (lang === "tr") {
    if (/leader|lider/i.test(`${sourceText} ${clean}`)) return "Kendi liderin ol";
    if (/Silahını kuşan, loncanla dünyayı fethet/i.test(clean)) return "Loncanla fethet";
    if (/Silahını kuşan, hedefe kilitlen ve dünyayı fethet/i.test(clean)) return "Hedefe kilitlen";
    if (/Ordunu hazırla ve dünyayı stratejinle fethet/i.test(clean)) return "Ordunu hazırla";
    if (/Hazırlan ve dünyayı kazan/i.test(clean)) return "Hazırlan ve kazan";
    if (/Silahını kuşan ve karanlığı alt et/i.test(clean)) return "Karanlığı alt et";
    if (/Hazırlan ve zirveye çık/i.test(clean)) return "Zirveye çık";
    if (/Düzenini kur ve kendi dünyanı inşa et/i.test(clean)) return "Dünyanı inşa et";
    if (clean.split(/\s+/).length <= 6) return clean;
  }
  if (lang === "en") {
    if (/leader/i.test(`${sourceText} ${clean}`)) return "Be your leader";
    if (/conquer the world with your guild/i.test(clean)) return "Conquer with your guild";
    if (/dominate the battlefield/i.test(clean)) return "Dominate the battlefield";
    if (/conquer the world with strategy/i.test(clean)) return "Command and conquer";
    if (/survive the darkness/i.test(clean)) return "Survive the darkness";
    if (/race to the top/i.test(clean)) return "Race to the top";
    if (/build/i.test(clean)) return "Build your world";
  }
  if (clean.includes(",")) return clean.split(",")[0].trim();
  const words = clean.split(/\s+/);
  return words.length <= 6 ? clean : words.slice(0, 6).join(" ");
}

function naturalLocalizationText(baseText = "", adaptedText = "", lang = "en", genre = "", source = "") {
  const base = String(baseText || "").trim();
  const adapted = String(adaptedText || "").trim();
  const sourceText = String(source || "").trim();
  if (!base && !adapted) return "";
  if (lang === "tr") {
    if (/leader|lider/i.test(`${sourceText} ${base} ${adapted}`)) return "Hazırlan, kendi liderin ol";
    if (/^Silahını hazırla ve dünyayı fethet$/i.test(base)) {
      if (genre === "mmo") return "Silahını kuşan ve loncanla dünyayı fethet";
      if (genre === "fps") return "Silahını kuşan, hedefe kilitlen ve savaşı kazan";
      if (genre === "strategy") return "Ordunu hazırla ve dünyayı stratejinle fethet";
      if (genre === "casual") return "Hazırlan, dene ve dünyayı kazan";
      if (genre === "horror") return "Silahını kuşan ve karanlığa meydan oku";
      if (genre === "racing") return "Hazırlan ve zirveye doğru yarış";
      if (genre === "simulation") return "Düzenini kur ve kendi dünyanı büyüt";
    }
    return adapted
      .replace(/, loncanla /i, " ve loncanla ")
      .replace(/hedefe kilitlen ve dünyayı fethet/i, "hedefe kilitlen ve savaşı kazan")
      .replace(/dünyayı stratejinle fethet/i, "dünyayı stratejinle ele geçir");
  }
  if (lang === "en") {
    return adapted
      .replace(/conquer the world with your guild/i, "conquer the world together with your guild")
      .replace(/dominate the battlefield/i, "win every fight")
      .replace(/conquer the world with strategy/i, "conquer through strategy");
  }
  if (lang === "zh") {
    return adapted
      .replace(/与公会一起征服世界/, "和公会一起征服世界")
      .replace(/主宰战场/, "赢下战场")
      .replace(/用策略征服世界/, "用策略拿下世界");
  }
  return adapted || base;
}

function genreAdaptedGoogleText(text = "", lang = "en", genre = "") {
  const clean = String(text || "").trim();
  if (!clean) return "";
  if (lang === "tr") {
    let out = clean;
    if (/^Silahını hazırla ve dünyayı fethet$/i.test(out)) {
      if (genre === "mmo") return "Silahını kuşan, loncanla dünyayı fethet";
      if (genre === "fps") return "Silahını kuşan, hedefe kilitlen ve dünyayı fethet";
      if (genre === "strategy") return "Ordunu hazırla ve dünyayı stratejinle fethet";
      if (genre === "casual") return "Hazırlan ve dünyayı kazan";
      if (genre === "horror") return "Silahını kuşan ve karanlığı alt et";
      if (genre === "racing") return "Hazırlan ve zirveye çık";
      if (genre === "simulation") return "Düzenini kur ve kendi dünyanı inşa et";
    }
    if (genre === "mmo") out = out.replace(/Silahını hazırla/i, "Silahını kuşan").replace(/dünyayı fethet/i, "loncanla dünyayı fethet");
    if (genre === "fps") out = out.replace(/Silahını hazırla/i, "Silahını kuşan").replace(/dünyayı fethet/i, "hedefe kilitlen ve dünyayı fethet");
    if (genre === "strategy") out = out.replace(/Silahını hazırla/i, "Ordunu hazırla").replace(/dünyayı fethet/i, "dünyayı stratejinle fethet");
    if (genre === "casual") out = out.replace(/fethet/i, "kazan").replace(/kuşan/i, "hazırla");
    if (genre === "horror") out = out.replace(/dünyayı fethet/i, "karanlığı alt et");
    if (genre === "racing") out = out.replace(/dünyayı fethet/i, "zirveye çık");
    if (genre === "simulation") out = out.replace(/fethet/i, "inşa et").replace(/Silahını/i, "Düzenini");
    return out;
  }
  if (lang === "en") {
    let out = clean;
    if (genre === "mmo") out = out.replace(/Ready your weapon/i, "Equip your weapon").replace(/conquer the world/i, "conquer the world with your guild");
    if (genre === "fps") out = out.replace(/Ready your weapon/i, "Lock and load").replace(/conquer the world/i, "dominate the battlefield");
    if (genre === "strategy") out = out.replace(/Ready your weapon/i, "Ready your army").replace(/conquer the world/i, "conquer the world with strategy");
    if (genre === "casual") out = out.replace(/conquer/i, "win").replace(/Ready your weapon/i, "Get ready");
    if (genre === "horror") out = out.replace(/conquer the world/i, "survive the darkness");
    if (genre === "racing") out = out.replace(/conquer the world/i, "race to the top");
    if (genre === "simulation") out = out.replace(/conquer/i, "build").replace(/weapon/i, "world");
    return out;
  }
  if (lang === "zh") {
    let out = clean;
    if (genre === "mmo") out = out.replace(/准备好武器/, "装备武器").replace(/征服世界/, "与公会一起征服世界");
    if (genre === "fps") out = out.replace(/准备好武器/, "装弹上阵").replace(/征服世界/, "主宰战场");
    if (genre === "strategy") out = out.replace(/准备好武器/, "集结军队").replace(/征服世界/, "用策略征服世界");
    if (genre === "casual") out = out.replace(/征服世界/, "赢下挑战");
    if (genre === "horror") out = out.replace(/征服世界/, "逃出黑暗");
    if (genre === "racing") out = out.replace(/征服世界/, "冲上巅峰");
    if (genre === "simulation") out = out.replace(/征服世界/, "打造你的世界");
    return out;
  }
  return clean;
}

function formatGoogleTranslateLocalization({ source, translated, lang, genre, mode, tone }) {
  const adapted = genreAdaptedGoogleText(translated, lang, genre);
  const naturalText = naturalLocalizationText(translated, adapted, lang, genre, source);
  const shortText = shortLocalizationText(adapted, lang, source);
  const labels = {
    tr: {
      gameType: "Oyun türü",
      style: "Tarz analizi",
      rule: "Dil kuralı",
      tone: "Ton",
      normal: "Normal çeviri",
      option1: "Seçenek 1 - Oyun içi çeviri",
      option2: "Seçenek 2 - Daha doğal",
      option3: "Seçenek 3 - Kısa UI",
      source: "Kaynak metin",
      note: "Not",
      noteText: "Google Translate fallback kullanıldı; oyun tonunu GPT kadar derin uyarlamayabilir."
    },
    en: {
      gameType: "Game type",
      style: "Style analysis",
      rule: "Language rule",
      tone: "Tone",
      normal: "Normal translation",
      option1: "Option 1 - In-game translation",
      option2: "Option 2 - More natural",
      option3: "Option 3 - Short UI",
      source: "Source text",
      note: "Note",
      noteText: "Google Translate fallback was used; game tone may be less nuanced than GPT."
    },
    zh: {
      gameType: "游戏类型",
      style: "风格分析",
      rule: "语言规则",
      tone: "语气",
      normal: "普通翻译",
      option1: "选项 1 - 游戏内翻译",
      option2: "选项 2 - 更自然",
      option3: "选项 3 - 短 UI",
      source: "源文本",
      note: "备注",
      noteText: "已使用 Google Translate fallback；游戏语气可能不如 GPT 细致。"
    }
  }[lang] || {};
  const normalBlock = mode === "normal" || mode === "both" ? `${labels.normal}:\n${translated}\n\n` : "";
  if (mode === "normal") {
    return `${labels.normal}:\n${translated}\n\n${labels.source}:\n${source}\n\n${labels.note}: ${labels.noteText}`;
  }
  return `${labels.gameType}: ${genre}
${labels.style}: ${lang === "zh" ? "先做基础翻译，再作为游戏内文本使用。" : lang === "tr" ? "Önce temel çeviri yapıldı, sonra oyun içi metin olarak kullanılabilir hale getirildi." : "Base translation first, then prepared as in-game text."}
${labels.rule}: ${lang === "zh" ? "Anlamı koru, kısa ve doğal tut." : lang === "tr" ? "Anlamı koru, kısa ve doğal tut." : "Keep the meaning clear, short, and natural."}
${labels.tone}: ${tone}

${normalBlock}${labels.option1}:
${adapted}

${labels.option2}:
${naturalText}

${labels.option3}:
${shortText}

${labels.source}:
${source}

${labels.note}: ${labels.noteText}`;
}

async function localize(input) {
  const languageName = input.lang === "zh" ? "Chinese" : input.lang === "tr" ? "Turkish" : "English";
  const genre = input.genre || input.project?.genre || "auto";
  const mode = input.mode || "game";
  const prompt = `You are a senior mobile game in-game localization specialist.
Analyze the game genre and text function first, then localize the in-game word/sentence into ${languageName}.

Rules:
- Translation mode: ${mode}. If mode is "normal", provide a clear normal translation without game-style adaptation. If mode is "game", adapt for in-game usage. If mode is "both", show both normal translation and in-game adaptation.
- Do not translate word by word.
- Preserve the source meaning.
- Adapt the wording to the game type and in-game context.
- This is for UI strings, skill names, dialogue, tutorial text, buttons, item names, quests, rewards, and system messages.
- Keep UI strings short when the source is short.
- Give word-by-word term suggestions when useful.
- FPS/Shooter: short, punchy, combat, squad, skill, ranked pressure.
- MMO/RPG: world, class, guild, raid, loot, progression, adventure.
- Strategy/4X: command, alliance, resources, tactics, conquest, expansion.
- Casual/Puzzle: clear, friendly, easy reward language, low pressure.
- Horror: suspense, survival, secrets, atmosphere.
- Racing: speed, drift, upgrade, competition.
- Simulation: build, manage, customize, daily growth.
- Return exactly: game type, style analysis, language rule, 3 translation options, word-by-word suggestions, source text, and one short note.
- Use heading labels in the target language.

Requested game type: ${genre}.
Tone: ${input.tone || "Store-ready"}.
Project: ${input.project?.name || "Game"}.
Source: ${input.source || ""}`;
  const ai = await openAiText(prompt);
  if (ai) return { source: "openai", text: ai };
  const source = String(input.source || "").trim();
  const googleText = await googleTranslateText(source, input.lang || "en").catch(() => "");
  if (googleText && googleText.toLowerCase() !== source.toLowerCase()) {
    return {
      source: "googletrans",
      text: formatGoogleTranslateLocalization({
        source,
        translated: googleText,
        lang: input.lang || "en",
        genre,
        mode,
        tone: input.tone || "Store-ready"
      })
    };
  }
  return {
    source: "unavailable",
    text: "",
    error: "No translation provider available. Configure GPT or allow Google Translate fallback from the backend."
  };
}

function decodeHtml(value = "") {
  return String(value)
    .replace(/\\u003d/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textFromMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["']`, "i"),
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function keywordSummary(text) {
  const stop = new Set("the and for with you your our are this that from into game play apps app mobile free new now all can will get more best build create games".split(" "));
  const counts = {};
  String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g)?.forEach((word) => {
    if (!stop.has(word)) counts[word] = (counts[word] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word]) => word).join(", ");
}

function firstSentence(text) {
  const sentence = String(text || "").split(/(?<=[.!?])\s+/)[0] || "";
  return sentence.length > 130 ? `${sentence.slice(0, 127)}...` : sentence;
}

function inferStrength(description) {
  const lower = String(description || "").toLowerCase();
  if (/build|upgrade|collect|craft|manage|strategy|battle/.test(lower)) return "Feature-led positioning";
  if (/story|world|adventure|explore|discover/.test(lower)) return "Fantasy-led opening";
  if (/free|download|play now|join/.test(lower)) return "Clear CTA";
  return "Description-based keywords";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseTextSafe(response) {
  const encoding = String(response.headers.get("content-encoding") || "").toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  try {
    if (encoding.includes("br")) return zlib.brotliDecompressSync(buffer).toString("utf8");
    if (encoding.includes("gzip") || (buffer[0] === 0x1f && buffer[1] === 0x8b)) return zlib.gunzipSync(buffer).toString("utf8");
    if (encoding.includes("deflate")) return zlib.inflateSync(buffer).toString("utf8");
  } catch (error) {
    return buffer.toString("utf8");
  }
  return buffer.toString("utf8");
}

async function responseJsonSafe(response, label = "API") {
  const text = await responseTextSafe(response);
  try {
    return JSON.parse(text);
  } catch (error) {
    const preview = text.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`${label} returned non-JSON response: ${preview || error.message}`);
  }
}

async function googlePlayDetails(appId, hl = "en", gl = "US") {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 PlayScope/1.0",
      "Accept-Language": `${hl},en;q=0.8`
    }
  }, 15000);
  if (!response.ok) throw new Error(`Google Play details HTTP ${response.status}`);
  const html = await response.text();
  const title = decodeHtml(textFromMeta(html, "og:title") || (html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || "").replace(/\s*-\s*Apps on Google Play\s*$/i, ""));
  const description = decodeHtml(textFromMeta(html, "description") || textFromMeta(html, "og:description"));
  return {
    id: appId,
    name: title || appId,
    store: "Google Play",
    length: String(description.length || "-"),
    message: firstSentence(description) || "Google Play description loaded",
    strength: inferStrength(description),
    desc: description || "Description could not be read from Google Play.",
    keywords: keywordSummary(`${title} ${description}`),
    url
  };
}

function mapGooglePlayApp(item = {}, details = {}) {
  const title = details.title || item.title || item.appId || "Google Play app";
  const description = details.description || details.summary || item.summary || "";
  const url = details.url || item.url || `https://play.google.com/store/apps/details?id=${encodeURIComponent(item.appId || details.appId || "")}`;
  return {
    id: item.appId || details.appId || title,
    name: title,
    store: "Google Play",
    length: String(description.length || "-"),
    message: firstSentence(description) || item.summary || details.genre || "Google Play description loaded",
    strength: inferStrength(description),
    desc: description || item.summary || "Description could not be read from Google Play.",
    keywords: keywordSummary(`${title} ${details.genre || ""} ${details.categories?.join(" ") || ""} ${description}`),
    url
  };
}

function mapSerpApiGooglePlay(item = {}) {
  const title = item.title || item.name || item.app_name || item.product_title || "Google Play app";
  const appId = item.product_id || item.app_id || item.appId || item.package_name || "";
  const description = item.description || item.snippet || item.summary || item.extracted_description || "";
  const url = item.link || item.store_link || item.serpapi_link || (appId ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}` : "");
  const category = item.category || item.genre || "";
  return {
    id: appId || title,
    name: title,
    store: "Google Play",
    length: String(description.length || "-"),
    message: firstSentence(description) || category || "Google Play result loaded",
    strength: inferStrength(description || category),
    desc: description || "Description was not included in this search result.",
    keywords: keywordSummary(`${title} ${item.author || ""} ${category} ${description}`),
    meta: [item.author, item.rating ? `Rating ${item.rating}` : "", item.downloads ? `${item.downloads} downloads` : "", category].filter(Boolean).join(" · "),
    url
  };
}

function flattenSerpApiResults(data = {}) {
  const buckets = [
    data.organic_results,
    data.app_highlight,
    data.items_highlight,
    data.ads_results,
    data.search_information?.organic_results,
    data.results
  ].filter(Boolean);
  const flat = [];
  for (const bucket of buckets) {
    const list = Array.isArray(bucket) ? bucket : [bucket];
    for (const item of list) {
      if (Array.isArray(item.items)) flat.push(...item.items);
      else if (Array.isArray(item.apps)) flat.push(...item.apps);
      else if (Array.isArray(item.items_highlight)) item.items_highlight.flat().forEach((entry) => flat.push(entry));
      else flat.push(item);
    }
  }
  const seen = new Set();
  return flat.filter((item) => {
    const key = item.product_id || item.app_id || item.appId || item.package_name || item.title || item.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function serpApiGooglePlaySearch(input = {}) {
  const apiKey = getSerpApiKey();
  if (!apiKey) return null;
  const query = String(input.query || "").trim();
  const lang = input.lang || "en";
  const country = String(input.country || "US").toLowerCase();
  const params = new URLSearchParams({
    engine: "google_play",
    q: query,
    store: "apps",
    hl: lang,
    gl: country,
    api_key: apiKey
  });
  const response = await fetchWithTimeout(`https://serpapi.com/search.json?${params.toString()}`, {
    headers: {
      "User-Agent": "PlayScope/1.0",
      "Accept": "application/json",
      "Accept-Encoding": "identity"
    }
  }, 20000);
  if (!response.ok) throw new Error(`SerpAPI HTTP ${response.status}`);
  const data = await responseJsonSafe(response, "SerpAPI");
  if (data.error) throw new Error(`SerpAPI: ${data.error}`);
  const limit = Number(input.limit || 5);
  const results = flattenSerpApiResults(data).slice(0, limit).map(mapSerpApiGooglePlay);
  return { ok: true, source: "serpapi-google-play", query, results };
}

async function googlePlayScraperSearch(input = {}) {
  if (!googlePlayScraper) return null;
  const query = String(input.query || "").trim();
  const lang = input.lang || "en";
  const country = input.country || "us";
  const limit = Number(input.limit || 5);
  const found = await googlePlayScraper.search({
    term: query,
    num: Math.max(limit, 5),
    lang,
    country: country.toLowerCase()
  });
  const results = [];
  for (const item of found.slice(0, limit)) {
    try {
      const details = await googlePlayScraper.app({
        appId: item.appId,
        lang,
        country: country.toLowerCase()
      });
      results.push(mapGooglePlayApp(item, details));
    } catch (error) {
      results.push(mapGooglePlayApp(item, {}));
    }
  }
  return { ok: true, source: "google-play-scraper", query, results };
}

async function googlePlaySearch(input = {}) {
  const query = String(input.query || "").trim();
  if (!query) return { ok: false, error: "Search text is required.", results: [] };
  const hl = input.lang || "en";
  const gl = input.country || "US";
  if (getSerpApiKey()) {
    try {
      const serpResult = await serpApiGooglePlaySearch({ ...input, query, lang: hl });
      if (serpResult?.results?.length) return serpResult;
      return { ok: false, error: "SerpAPI returned no Google Play results.", results: [] };
    } catch (error) {
      return { ok: false, error: `SerpAPI request failed: ${error.message}`, results: [] };
    }
  }
  const scraperResult = await googlePlayScraperSearch({ ...input, query, lang: hl, country: gl }).catch(() => null);
  if (scraperResult?.results?.length) return scraperResult;
  if (!googlePlayScraper) {
    return {
      ok: false,
      error: "Google Play parser is not installed on this local server. Run npm install, then restart the local app.",
      results: []
    };
  }
  const searchUrl = `https://play.google.com/store/search?q=${encodeURIComponent(query)}&c=apps&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`;
  const response = await fetchWithTimeout(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 PlayScope/1.0",
      "Accept-Language": `${hl},en;q=0.8`
    }
  }, 15000);
  if (!response.ok) throw new Error(`Google Play search HTTP ${response.status}`);
  const html = await response.text();
  const ids = [];
  for (const match of html.matchAll(/\/store\/apps\/details\?id=([A-Za-z0-9._]+)/g)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
    if (ids.length >= 8) break;
  }
  if (!ids.length) {
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(`site:play.google.com/store/apps/details ${query}`)}&hl=${encodeURIComponent(hl)}`;
    const googleResponse = await fetchWithTimeout(googleUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 PlayScope/1.0",
        "Accept-Language": `${hl},en;q=0.8`
      }
    }, 15000);
    if (googleResponse.ok) {
      const googleHtml = await googleResponse.text();
      for (const match of googleHtml.matchAll(/(?:id%3D|id=)([A-Za-z0-9._]+)/g)) {
        if (!ids.includes(match[1])) ids.push(match[1]);
        if (ids.length >= 8) break;
      }
    }
  }
  const results = [];
  for (const id of ids.slice(0, Number(input.limit || 5))) {
    try {
      results.push(await googlePlayDetails(id, hl, gl));
    } catch (error) {
      results.push({ id, name: id, store: "Google Play", length: "-", message: "Details could not be loaded", strength: "Search result only", desc: error.message, keywords: "", url: `https://play.google.com/store/apps/details?id=${id}` });
    }
  }
  return { ok: true, source: "google-play-web", query, results };
}

function appStoreCountry(lang = "en") {
  if (lang === "tr") return "TR";
  if (lang === "de") return "DE";
  if (lang === "ja") return "JP";
  if (lang === "zh") return "CN";
  return "US";
}

async function appStoreSearch(input = {}) {
  const query = String(input.query || "").trim();
  if (!query) return { ok: false, error: "Search text is required.", results: [] };
  const country = input.country || appStoreCountry(input.lang || "en");
  const limit = Number(input.limit || 5);
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=software&country=${encodeURIComponent(country)}&limit=${encodeURIComponent(limit)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 PlayScope/1.0",
      "Accept": "application/json"
    }
  }, 15000);
  if (!response.ok) throw new Error(`App Store search HTTP ${response.status}`);
  const data = await response.json();
  const results = (data.results || []).map((item) => {
    const description = item.description || "";
    const title = item.trackName || item.bundleId || "App Store app";
    return {
      id: String(item.trackId || item.bundleId || title),
      name: title,
      store: "App Store",
      length: String(description.length || "-"),
      message: firstSentence(description) || item.primaryGenreName || "App Store description loaded",
      strength: inferStrength(description),
      desc: description || "Description could not be read from App Store.",
      keywords: keywordSummary(`${title} ${item.primaryGenreName || ""} ${item.genres?.join(" ") || ""} ${description}`),
      url: item.trackViewUrl || ""
    };
  });
  return { ok: true, source: "app-store-search", query, results };
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
    if (req.method === "POST" && req.url === "/api/google-play-search") {
      const body = await readJson(req);
      const result = await googlePlaySearch(body).catch((error) => ({ ok: false, error: error.message, results: [] }));
      return send(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/api/app-store-search") {
      const body = await readJson(req);
      const result = await appStoreSearch(body).catch((error) => ({ ok: false, error: error.message, results: [] }));
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
      if (body.serpapiKey) updates.SERPAPI_KEY = body.serpapiKey;
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
        serpapiKey: getSerpApiKey(),
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
server.listen(port, "0.0.0.0", () => {
  console.log(`PlayScope running at http://0.0.0.0:${port}`);
});
