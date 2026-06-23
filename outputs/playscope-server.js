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
const parentEnvPath = path.resolve(root, "..", ".env.local");
const dataDir = path.join(root, "work");
const sharedStatePath = path.join(dataDir, "playscope-shared-state.json");
const appVersion = "social-ai-text-fallback-2026-06-17-1";

function readEnv() {
  const env = { ...process.env };
  for (const candidate of [parentEnvPath, envPath]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\uFEFF?([A-Z0-9_]+)=(.*)$/);
      if (match) env[match[1]] = match[2];
    }
  }
  return env;
}

let env = readEnv();

function writeEnv(updates) {
  env = { ...env, ...updates };
  const order = ["YOUTUBE_API_KEY", "OPENAI_API_KEY", "GPT_API_BASE_URL", "GPT_MODEL", "AI_API_BASE_URL", "AI_MODEL", "REVIEW_MODEL", "OPENAI_WIRE_API", "MODEL_REASONING_EFFORT", "DISABLE_RESPONSE_STORAGE", "SERPAPI_KEY", "APIFY_TOKEN", "APIFY_ACTOR_ID", "GOOGLE_CLIENT_SECRET", "TEAM_PASSWORD"];
  const keys = order.filter((key) => env[key] !== undefined && env[key] !== "");
  fs.writeFileSync(envPath, keys.map((key) => `${key}=${env[key]}`).join("\n"), "utf8");
}

function getAiBaseUrl() {
  let base = String(env.GPT_API_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
  base = base.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  if (/^https:\/\/api\.openai\.com$/i.test(base)) base += "/v1";
  return base;
}

function getAiModel() {
  return env.GPT_MODEL && env.GPT_MODEL !== "auto" ? env.GPT_MODEL : "gpt-4o-mini";
}

function getAiModelCandidates() {
  const preferred = env.GPT_MODEL && env.GPT_MODEL !== "auto" ? env.GPT_MODEL : "";
  return [...new Set([
    preferred,
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-3.5-turbo",
    "chatgpt-4o-latest"
  ].filter(Boolean))];
}

function getAiModuleBaseUrl() {
  let base = String(env.AI_API_BASE_URL || env.GPT_API_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
  base = base.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/responses$/i, "");
  if (/^https:\/\/api\.openai\.com$/i.test(base)) base += "/v1";
  return base;
}

function hasOpenAiKey() {
  return Boolean(env.OPENAI_API_KEY || env.GPT_API_KEY || env.AI_API_KEY);
}

function getOpenAiKey() {
  return env.OPENAI_API_KEY || env.GPT_API_KEY || env.AI_API_KEY || "";
}

function getAiModuleWireApi() {
  const value = String(env.OPENAI_WIRE_API || env.GPT_WIRE_API || env.AI_WIRE_API || env.WIRE_API || "responses").trim().toLowerCase();
  return value === "responses" ? "responses" : "chat";
}

function getAiModuleModelCandidates(module) {
  const preferred = module === "review"
    ? (env.REVIEW_MODEL || env.AI_REVIEW_MODEL || env.AI_MODEL || "")
    : (env.AI_MODEL || "");
  const legacyModel = env.GPT_MODEL && env.GPT_MODEL !== "auto" ? env.GPT_MODEL : "";
  return [...new Set([
    preferred && preferred !== "auto" ? preferred : "",
    "gpt-5.5",
    legacyModel,
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-mini",
    "gpt-4.1"
  ].filter(Boolean))];
}

function getAiReasoningEffort() {
  const raw = String(env.MODEL_REASONING_EFFORT || env.OPENAI_REASONING_EFFORT || env.REASONING_EFFORT || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "xhigh") return "high";
  return ["minimal", "low", "medium", "high"].includes(raw) ? raw : "";
}

function responseTextFromResponsesApi(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const chunks = [];
  (data?.output || []).forEach((item) => {
    (item?.content || []).forEach((content) => {
      if (typeof content?.text === "string") chunks.push(content.text);
      if (typeof content?.text?.value === "string") chunks.push(content.text.value);
      if (typeof content?.output_text === "string") chunks.push(content.output_text);
    });
  });
  return chunks.join("").trim();
}

function aiModuleStoreEnabled() {
  const raw = String(env.DISABLE_RESPONSE_STORAGE || env.OPENAI_DISABLE_RESPONSE_STORAGE || env.AI_DISABLE_RESPONSE_STORAGE || "true").trim().toLowerCase();
  return !(raw === "true" || raw === "1" || raw === "yes");
}

async function callAiModuleModel(model, module, prompt) {
  const wireApi = getAiModuleWireApi();
  const baseUrl = getAiModuleBaseUrl();
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`
  };
  const systemText = "You are PlayScope AI for game marketing, localization, review analysis, and professional reports. Return structured JSON only.";

  if (wireApi === "responses") {
    const baseBody = {
      model,
      input: [
        { role: "system", content: systemText },
        { role: "user", content: prompt }
      ],
      max_output_tokens: 1800,
      store: aiModuleStoreEnabled()
    };
    const effort = getAiReasoningEffort();
    const fullBody = effort ? { ...baseBody, reasoning: { effort } } : baseBody;
    let response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(fullBody)
    });
    if (!response.ok && response.status === 400 && effort) {
      response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(baseBody)
      });
    }
    const data = response.ok ? await response.json().catch(() => null) : null;
    return {
      response,
      text: responseTextFromResponsesApi(data),
      wireApi
    };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemText },
        { role: "user", content: prompt }
      ],
      temperature: 0.35,
      max_tokens: 1800,
      stream: false
    })
  });
  const data = response.ok ? await response.json().catch(() => null) : null;
  return {
    response,
    text: data?.choices?.[0]?.message?.content?.trim() || "",
    wireApi
  };
}

async function callVisionJsonModel(model, systemText, promptText, imageDataUrl) {
  const imageDataUrls = (Array.isArray(imageDataUrl) ? imageDataUrl : [imageDataUrl]).filter(Boolean);
  const wireApi = getAiModuleWireApi();
  const baseUrl = getAiModuleBaseUrl();
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`
  };
  if (wireApi === "responses") {
    const baseBody = {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemText }] },
        {
          role: "user",
          content: [
            { type: "input_text", text: promptText },
            ...imageDataUrls.map((url) => ({ type: "input_image", image_url: url }))
          ]
        }
      ],
      max_output_tokens: 1800,
      store: aiModuleStoreEnabled()
    };
    const effort = getAiReasoningEffort();
    const fullBody = effort ? { ...baseBody, reasoning: { effort } } : baseBody;
    let response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(fullBody)
    });
    if (!response.ok && response.status === 400 && effort) {
      response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(baseBody)
      });
    }
    const data = response.ok ? await response.json().catch(() => null) : null;
    return { response, text: responseTextFromResponsesApi(data), wireApi };
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemText },
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } }))
          ]
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 1800,
      stream: false
    })
  });
  const data = response.ok ? await response.json().catch(() => null) : null;
  return { response, text: data?.choices?.[0]?.message?.content?.trim() || "", wireApi };
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

function xmlText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function xlsxColumnIndex(reference) {
  const letters = String(reference || "A").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

function readZipEntries(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0 && offset > buffer.length - 66000; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("Invalid XLSX file.");
  const count = buffer.readUInt16LE(eocd + 10);
  let cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cdOffset + 10);
    const compressedSize = buffer.readUInt32LE(cdOffset + 20);
    const nameLength = buffer.readUInt16LE(cdOffset + 28);
    const extraLength = buffer.readUInt16LE(cdOffset + 30);
    const commentLength = buffer.readUInt16LE(cdOffset + 32);
    const localOffset = buffer.readUInt32LE(cdOffset + 42);
    const name = buffer.subarray(cdOffset + 46, cdOffset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    cdOffset += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const raw = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (raw) entries.set(name, raw);
  }
  return entries;
}

function parseXlsxRows(buffer) {
  const entries = readZipEntries(buffer);
  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8") || "";
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)]
    .map((match) => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((part) => xmlText(part[1])).join(""));
  const sheetName = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort()[0];
  if (!sheetName) throw new Error("Excel worksheet not found.");
  const sheet = entries.get(sheetName).toString("utf8");
  const relName = sheetName.replace(/^xl\/worksheets\//i, "xl/worksheets/_rels/") + ".rels";
  const relXml = entries.get(relName)?.toString("utf8") || "";
  const rels = new Map();
  for (const rel of relXml.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    const attrs = rel[1] || "";
    const id = attrs.match(/\bId="([^"]+)"/i)?.[1] || "";
    const target = attrs.match(/\bTarget="([^"]+)"/i)?.[1] || "";
    const type = attrs.match(/\bType="([^"]+)"/i)?.[1] || "";
    if (id && target && /hyperlink/i.test(type)) rels.set(id, xmlText(target));
  }
  const hyperlinks = new Map();
  for (const link of sheet.matchAll(/<hyperlink\b([^>]*)\/?>/gi)) {
    const attrs = link[1] || "";
    const ref = attrs.match(/\bref="([^"]+)"/i)?.[1] || "";
    const rid = attrs.match(/\br:id="([^"]+)"/i)?.[1] || "";
    const location = attrs.match(/\blocation="([^"]+)"/i)?.[1] || "";
    const target = rels.get(rid) || xmlText(location);
    if (ref && target) hyperlinks.set(ref, target);
  }
  return [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)].map((rowMatch) => {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const reference = attrs.match(/\br="([^"]+)"/i)?.[1] || "A";
      const type = attrs.match(/\bt="([^"]+)"/i)?.[1] || "";
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] || "";
      const inline = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((part) => xmlText(part[1])).join("");
      const display = type === "s" ? (shared[Number(raw)] || "") : type === "inlineStr" ? inline : xmlText(raw);
      const link = hyperlinks.get(reference);
      row[xlsxColumnIndex(reference)] = link ? [display, link].filter(Boolean).join(" ") : display;
    }
    return row.map((value) => value ?? "");
  }).filter((row) => row.some((value) => String(value || "").trim()));
}

function parseDelimitedRowsServer(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  if (!text) return [];
  const separator = text.includes("\t") ? "\t" : (text.includes(";") && !text.includes(",") ? ";" : ",");
  return text.split("\n").map((line) => line.split(separator).map((cell) => cell.trim().replace(/^"|"$/g, ""))).filter((row) => row.some(Boolean));
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

function parseYouTubeDurationSeconds(value) {
  const match = String(value || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function formatDurationSeconds(seconds) {
  const total = Math.round(Number(seconds || 0));
  if (!total) return "-";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function serverVideoKind(video) {
  const seconds = parseYouTubeDurationSeconds(video.contentDetails?.duration);
  const title = String(video.snippet?.title || "").toLowerCase();
  if (seconds > 0 && seconds < 60) return "Short video";
  if (video.liveStreamingDetails?.actualStartTime || /\b(vod|live|stream|yayın|yayin|replay|tekrar)\b/i.test(title)) return "Stream replay video";
  if (seconds >= 180 && seconds <= 2400) return "Edited long video";
  if (seconds >= 60 && seconds < 180) return "Short edited video";
  if (seconds > 2400) return "Long uploaded video";
  return "Latest YouTube video";
}

function averageServerDuration(videoItems = []) {
  const durations = videoItems
    .map((video) => parseYouTubeDurationSeconds(video.contentDetails?.duration))
    .filter((seconds) => seconds >= 60);
  if (!durations.length) return 0;
  return Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length);
}

function dominantServerFormat(videoItems = []) {
  const counts = new Map();
  videoItems.forEach((video) => {
    const kind = serverVideoKind(video);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Latest YouTube videos";
}

async function youtubeResearch(input) {
  if (!env.YOUTUBE_API_KEY || typeof fetch !== "function") return demoInfluencer(input, "YouTube API key is missing or the runtime cannot make external requests.");
  const lookupValue = String(input.name || "").trim();
  const channelMatch = lookupValue.match(/youtube\.com\/channel\/(UC[\w-]{20,})/i) || lookupValue.match(/\b(UC[\w-]{20,})\b/);
  const handleMatch = lookupValue.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i) || lookupValue.match(/^@([A-Za-z0-9._-]+)$/);
  const videoMatch = lookupValue.match(/[?&]v=([A-Za-z0-9_-]{6,})/i) || lookupValue.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/i);
  let channelId = channelMatch?.[1] || "";
  if (!channelId && handleMatch) {
    const handleUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent(handleMatch[1])}&key=${env.YOUTUBE_API_KEY}`;
    const handleResponse = await fetch(handleUrl).catch(() => null);
    const handleData = handleResponse ? await handleResponse.json().catch(() => ({})) : {};
    channelId = handleData.items?.[0]?.id || "";
  }
  if (!channelId && videoMatch) {
    const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoMatch[1])}&key=${env.YOUTUBE_API_KEY}`;
    const videoResponse = await fetch(videoUrl).catch(() => null);
    const videoData = videoResponse ? await videoResponse.json().catch(() => ({})) : {};
    channelId = videoData.items?.[0]?.snippet?.channelId || "";
  }
  const query = encodeURIComponent(input.fallbackName || lookupValue.replace(/^@/, ""));
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=3&q=${query}&key=${env.YOUTUBE_API_KEY}`;
  let searchResponse;
  if (!channelId) {
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
    channelId = search.items?.[0]?.snippet?.channelId || "";
  }
  if (!channelId) return demoInfluencer(input, "No matching YouTube channel was found. Try the exact YouTube channel name or channel URL.");

  const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${env.YOUTUBE_API_KEY}`;
  const channelData = await fetch(channelUrl).then((res) => res.json());
  const channel = channelData.items?.[0];
  if (!channel) return demoInfluencer(input, "YouTube channel lookup returned no details.");

  const videoSearchUrl = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&order=date&type=video&maxResults=8&key=${env.YOUTUBE_API_KEY}`;
  const videoSearch = await fetch(videoSearchUrl).then((res) => res.json());
  const ids = (videoSearch.items || []).map((item) => item.id?.videoId).filter(Boolean);
  let avgViews = Number(input.views) || 0;
  let avgComments = 0;
  let duration = "-";
  let format = "-";
  if (ids.length) {
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,liveStreamingDetails&id=${ids.join(",")}&key=${env.YOUTUBE_API_KEY}`;
    const videoData = await fetch(videosUrl).then((res) => res.json());
    const videos = videoData.items || [];
    const counts = videos.map((item) => Number(item.statistics?.viewCount || 0)).filter(Boolean);
    const commentCounts = videos.map((item) => Number(item.statistics?.commentCount || 0)).filter((value) => Number.isFinite(value));
    if (counts.length) avgViews = Math.round(counts.reduce((sum, value) => sum + value, 0) / counts.length);
    if (commentCounts.length) avgComments = Math.round(commentCounts.reduce((sum, value) => sum + value, 0) / commentCounts.length);
    duration = formatDurationSeconds(averageServerDuration(videos));
    format = dominantServerFormat(videos);
  }

  const genres = String(input.genres || "game mobile").split(/[,\s]+/).filter(Boolean);
  return {
    source: "youtube",
    name: channel.snippet?.title || input.name,
    handle: "@" + (channel.snippet?.customUrl || channel.snippet?.title || input.name || "creator").replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_.-]/g, ""),
    country: input.country || "Unknown",
    flag: input.country === "Germany" ? "DE" : input.country === "USA" ? "US" : "TR",
    channel: "YouTube",
    link: `https://www.youtube.com/channel/${channelId}`,
    views: avgViews || Number(channel.statistics?.viewCount || 0),
    avgComments,
    subscribers: channel.statistics?.hiddenSubscriberCount ? "hidden" : channel.statistics?.subscriberCount || "",
    format,
    duration,
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
  for (const model of getAiModelCandidates()) {
    const response = await fetch(`${getAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a concise game marketing localization assistant. Return only the requested copy." },
          { role: "user", content: prompt }
        ],
        temperature: 0.4
      })
    }).catch(() => null);
    if (!response || !response.ok) continue;
    const data = await response.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (text) return text;
  }
  return null;
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

  let lastError = "";
  for (const model of getAiModuleModelCandidates("vision")) {
    const result = await callVisionJsonModel(
      model,
      "You extract structured influencer marketing data from screenshots. Return strict JSON only.",
      prompt,
      input.image
    ).catch((error) => ({ response: { ok: false, status: "network", error }, text: "" }));
    const response = result.response;
    if (!response.ok) {
      const detail = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      lastError = response.error?.message || `${model}: HTTP ${response.status}. ${detail}`.slice(0, 220);
      continue;
    }
    const parsed = parseJsonObject(result.text || "");
    const item = cleanOcrInfluencer(parsed, input.current || {});
    if (item) return { ok: true, item };
    lastError = `${model}: GPT did not return parseable JSON.`;
  }
  return { ok: false, error: `GPT screen read failed: ${lastError}` };
}

async function readImageData(input) {
  if (!env.OPENAI_API_KEY || typeof fetch !== "function") {
    return { ok: false, error: "GPT API key is missing or backend cannot make external requests." };
  }
  const images = (Array.isArray(input.images) ? input.images : [input.image]).filter((value) => String(value || "").startsWith("data:image/"));
  if (!images.length) {
    return { ok: false, error: "No image received." };
  }
  const modelCandidates = getAiModuleModelCandidates("vision");
  let lastError = "";
  for (const model of modelCandidates) {
    const prompt = `Read this image. It belongs to this creator/channel when provided: ${JSON.stringify(input.context || {})}. Extract every visible influencer/creator row as JSON. Return exactly: {"rows":[{"Channel Name":"","Link":"","GEO":"","Gender":"","Age":"","Category":"","Subcategory":"","Subscribers":"","avg Views":"","Avg Comments":"","Format":"","Duration":"","Keywords":"","Comments":""}]}. If a cell is not visible, leave it empty. Preserve YouTube links and names exactly. For Scrumball screenshots, include followers, avg engagement, avg view rate, monthly post, audience location countries, and visible age/gender analysis. If an age/gender bar chart is visible, calculate Age as total Female+Male per age group, formatted like "13-17: 14%; 18-24: 44%; 25-34: 25%". Calculate Gender separately as total Female vs Male, formatted like "F52% / M48%". Do not put gender percentages inside Age.`;
    const result = await callVisionJsonModel(
      model,
      "Extract influencer research table data from images. Return strict JSON only. Do not invent missing values.",
      prompt,
      images
    ).catch((error) => ({ response: { ok: false, status: "network", error }, text: "" }));
    const response = result.response;
    if (!response.ok) {
      const detail = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      lastError = response.error?.message || `HTTP ${response.status}. ${detail}`.slice(0, 220);
      continue;
    }
    const parsed = parseJsonObject(result.text || "");
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (rows.length) return { ok: true, source: "backend-gpt-vision", model, wireApi: result.wireApi, rows };
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

function manualLocalizationOutput({ source = "", lang = "en", tone = "Store-ready", genre = "auto", mode = "game" }) {
  const raw = String(source || "").trim();
  const key = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const labels = {
    tr: { gameType: "Oyun türü", style: "Tarz analizi", rule: "Dil kuralı", tone: "Ton", option1: "Seçenek 1 - Oyun içi çeviri", option2: "Seçenek 2 - Daha doğal", option3: "Seçenek 3 - Kısa UI", source: "Kaynak metin", note: "Not", noteText: "Kısa slogan için yerel oyun lokalizasyonu kullanıldı." },
    en: { gameType: "Game type", style: "Style analysis", rule: "Language rule", tone: "Tone", option1: "Option 1 - In-game translation", option2: "Option 2 - More natural", option3: "Option 3 - Short UI", source: "Source text", note: "Note", noteText: "Curated game localization was used for this short slogan." },
    zh: { gameType: "游戏类型", style: "风格分析", rule: "语言规则", tone: "语气", option1: "选项 1 - 游戏内翻译", option2: "选项 2 - 更自然", option3: "选项 3 - 短 UI", source: "源文本", note: "备注", noteText: "此短标语使用了游戏本地化表达。" }
  }[lang] || {};
  let options = null;
  if (/life is your|life is yours|either create|either conquer|create.*conquer|yarat.*fethet/.test(key)) {
    options = {
      tr: ["Hayat senin; ya yarat ya fethet", "Hayat senin. İster yarat, ister fethet", "Yarat ya da fethet"],
      en: ["Life is yours: create or conquer", "Your life, your choice: create or conquer", "Create or conquer"],
      zh: ["人生由你掌控：创造，或征服", "人生属于你，创造或征服", "创造或征服"]
    }[lang];
  } else if (/be your own leader|own leader|kendi lider/.test(key)) {
    options = {
      tr: ["Hazırlan ve kendi liderin ol", "Hazırsan liderliği ele al", "Kendi liderin ol"],
      en: ["Get ready and become your own leader", "Ready up and lead your own way", "Be your own leader"],
      zh: ["准备好，成为自己的领袖", "准备出发，掌控自己的道路", "成为自己的领袖"]
    }[lang];
  }
  if (!options) return "";
  const genreLabel = genre || "auto";
  if (mode === "normal") {
    return `${labels.option2}:\n${options[1]}\n\n${labels.source}:\n${raw}\n\n${labels.note}: ${labels.noteText}`;
  }
  return `${labels.gameType}: ${genreLabel}
${labels.style}: ${lang === "zh" ? "短标语；优先保留力量感和选择感。" : lang === "tr" ? "Kısa slogan; anlam, güç ve seçim hissi korundu." : "Short slogan; preserves meaning, power, and choice."}
${labels.rule}: ${lang === "zh" ? "自然、短、适合游戏内按钮或宣传句。" : lang === "tr" ? "Doğal, kısa ve oyun içi metne uygun." : "Natural, short, and ready for in-game use."}
${labels.tone}: ${tone}

${labels.option1}:
${options[0]}

${labels.option2}:
${options[1]}

${labels.option3}:
${options[2]}

${labels.source}:
${raw}

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
- Option 1 must be accurate and ready to use in-game.
- Option 2 must be a more natural/emotional alternative, not a duplicate.
- Option 3 must be a complete short UI version, never a cut-off fragment.
- Preserve key meaning such as create, conquer, build, lead, reward, claim, upgrade, join, battle, survive, explore.
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
  return {
    source: "unavailable",
    text: "",
    error: "GPT localization failed. Check OPENAI_API_KEY, model access, and API credits."
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
  return keywordListSummary(text, 12).join(", ");
}

function keywordListSummary(text, limit = 80) {
  const stop = new Set("the and for with you your our are this that from into game play apps app mobile free new now all can will get more best build create games".split(" "));
  const counts = {};
  String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g)?.forEach((word) => {
    if (!stop.has(word)) counts[word] = (counts[word] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word);
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

function getApifyToken() {
  return env.APIFY_TOKEN || env.APIFY_API_TOKEN || "";
}

function instagramUsernameFromUrl(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const direct = text.replace(/^@/, "");
  const match = direct.match(/instagram\.com\/([^/?#]+)/i);
  return (match?.[1] || direct).replace(/^@/, "").replace(/\/+$/, "");
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Math.max(1, Number(days || 30)));
  return date.toISOString().slice(0, 10);
}

function postTimestamp(item = {}) {
  const value = item.timestamp || item.takenAt || item.takenAtTimestamp || item.taken_at_timestamp || item.date || item.time || item.createdAt;
  if (!value) return "";
  if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalizeInstagramPost(item = {}) {
  const shortcode = item.shortCode || item.shortcode || item.code || "";
  const images = [
    item.displayUrl,
    item.display_url,
    item.imageUrl,
    item.image_url,
    item.image,
    item.thumbnailUrl,
    item.thumbnail,
    item.thumbnail_src,
    item.url,
    ...(Array.isArray(item.images) ? item.images.map((image) => image.url || image.src || image.displayUrl || image) : []),
    ...(Array.isArray(item.childPosts) ? item.childPosts.map((post) => post.displayUrl || post.imageUrl || post.url) : [])
  ].filter(Boolean);
  const timestamp = postTimestamp(item);
  return {
    id: String(item.id || shortcode || item.url || ""),
    shortcode,
    url: item.url || item.postUrl || item.permalink || (item.shortCode || item.shortcode ? `https://www.instagram.com/p/${item.shortCode || item.shortcode}/` : ""),
    type: item.type || item.productType || item.mediaType || (item.isVideo || item.is_video ? "video" : "image"),
    caption: item.caption || item.description || item.text || item.alt || item.title || "",
    timestamp,
    date: timestamp ? timestamp.slice(0, 10) : "",
    likes: Number(item.likesCount ?? item.likes ?? item.count_like ?? item.likeCount ?? item.likes_count ?? 0),
    comments: Number(item.commentsCount ?? item.comments ?? item.count_comment ?? item.commentCount ?? item.comments_count ?? 0),
    views: Number(item.videoViewCount ?? item.videoPlayCount ?? item.viewsCount ?? item.views ?? 0),
    imageUrl: images[0] || "",
    images: [...new Set(images)].slice(0, 6),
    videoUrl: item.videoUrl || item.video_url || item.video || "",
    hashtags: item.hashtags || [],
    mentions: item.mentions || [],
    ownerUsername: item.ownerUsername || item.owner?.username || item.username || ""
  };
}

function filterRecentPosts(posts, sinceDate) {
  const since = sinceDate ? new Date(`${sinceDate}T00:00:00Z`) : null;
  if (!since || Number.isNaN(since.getTime())) return posts;
  return posts.filter((post) => {
    if (!post.timestamp) return true;
    const date = new Date(post.timestamp);
    return Number.isNaN(date.getTime()) || date >= since;
  });
}

function flattenApifyPostItems(value) {
  const found = [];
  const visit = (item, depth = 0) => {
    if (!item || depth > 3) return;
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (typeof item !== "object") return;
    const itemUrl = String(item.url || item.postUrl || item.permalink || "");
    const hasPostUrl = /instagram\.com\/(p|reel|tv)\//i.test(itemUrl);
    const hasShortcode = Boolean(item.shortCode || item.shortcode || item.code);
    const hasPostTime = Boolean(item.takenAt || item.takenAtTimestamp || item.taken_at_timestamp || item.timestamp || item.date || item.time);
    const hasMedia = Boolean(item.displayUrl || item.display_url || item.videoUrl || item.video_url || item.thumbnailUrl);
    const looksLikePost = hasPostUrl || hasShortcode || (hasPostTime && (item.caption || hasMedia));
    if (looksLikePost) found.push(item);
    ["posts", "latestPosts", "items", "data", "media", "edges"].forEach((key) => {
      if (Array.isArray(item[key])) visit(item[key], depth + 1);
    });
    if (item.node && typeof item.node === "object") visit(item.node, depth + 1);
  };
  visit(value);
  return found;
}

async function fetchInstagramPostsWithApify(input = {}) {
  const token = getApifyToken();
  if (!token) return { ok: false, code: "APIFY_NOT_CONFIGURED", error: "Apify token is missing. Add APIFY_TOKEN in Settings." };
  const profile = String(input.profileUrl || input.username || "").trim();
  const username = instagramUsernameFromUrl(profile);
  if (!username) return { ok: false, code: "PROFILE_REQUIRED", error: "Instagram username or profile URL is required." };
  const days = Math.max(1, Math.min(Number(input.days || 30), 180));
  const maxPosts = Math.max(1, Math.min(Number(input.maxPosts || 50), 200));
  const sinceDate = input.sinceDate || isoDateDaysAgo(days);
  const directUrl = profile.includes("instagram.com") ? profile : `https://www.instagram.com/${username}/`;
  const actorName = String(env.APIFY_ACTOR_ID || "apify/instagram-post-scraper");
  const actorId = actorName.replace("/", "~");
  const endpoint = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&format=json&clean=true`;
  const isApifyPostActor = /apify[~/]instagram-post-scraper/i.test(actorName);
  const isApifyProfileActor = /apify[~/]instagram-profile-scraper/i.test(actorName);
  const runInput = isApifyPostActor
    ? {
        username: [directUrl],
        resultsLimit: maxPosts,
        skipPinnedPosts: Boolean(input.skipPinnedPosts ?? true),
        dataDetailLevel: input.dataDetailLevel || "basicData"
      }
    : isApifyProfileActor
      ? {
          usernames: [username],
          resultsLimit: maxPosts,
          skipPinnedPosts: Boolean(input.skipPinnedPosts ?? true)
        }
    : {
        username: [directUrl],
        resultsLimit: maxPosts,
        skipPinnedPosts: Boolean(input.skipPinnedPosts ?? true),
        dataDetailLevel: input.dataDetailLevel || "basicData"
      };
  let response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(runInput)
    }, 65000);
  } catch (error) {
    return {
      ok: false,
      code: "APIFY_TIMEOUT",
      actor: actorName,
      error: "Apify actor uzun sürdü veya cevap vermedi. Maksimum post sayısını azaltıp tekrar dene ya da Render deploy'un güncel mi kontrol et."
    };
  }
  const data = await responseJsonSafe(response, "Apify");
  if (!response.ok) {
    return {
      ok: false,
      code: "APIFY_REQUEST_FAILED",
      actor: actorName,
      error: data?.error?.message || data?.message || `Apify HTTP ${response.status}`
    };
  }
  const rawItems = flattenApifyPostItems(Array.isArray(data) ? data : (data?.items || data?.data || data));
  const posts = filterRecentPosts(rawItems.map(normalizeInstagramPost), sinceDate)
    .filter((post) => {
      const hasPostUrl = /instagram\.com\/(p|reel|tv)\//i.test(String(post.url || ""));
      return hasPostUrl || post.shortcode || (post.caption && (post.imageUrl || post.videoUrl));
    })
    .slice(0, maxPosts);
  if (!posts.length && isApifyProfileActor && rawItems.length) {
    return {
      ok: false,
      code: "PROFILE_ACTOR_NO_POSTS",
      actor: actorName,
      error: "Bu Apify actor profil bilgisi döndürdü ama post/caption/görsel döndürmedi. Son gönderi analizi için APIFY_ACTOR_ID değerini apify/instagram-post-scraper yap."
    };
  }
  if (!posts.length || posts.every((post) => !post.caption && !post.shortcode && !post.imageUrl && !post.videoUrl)) {
    return {
      ok: false,
      code: "NO_USABLE_POST_DATA",
      actor: actorName,
      rawCount: rawItems.length,
      error: "Apify sonuç döndürdü ama kullanılabilir post/caption/görsel verisi yok. Render'da APIFY_ACTOR_ID değerini apify/instagram-post-scraper yapıp yeniden deploy et."
    };
  }
  return {
    ok: true,
    source: "apify",
    username,
    profileUrl: directUrl,
    days,
    sinceDate,
    maxPosts,
    rawCount: rawItems.length,
    posts
  };
}

function socialAnalysisPrompt(collection = {}) {
  const posts = (collection.posts || []).map((post, index) => ({
    index: index + 1,
    date: post.date,
    type: post.type,
    caption: post.caption,
    likes: post.likes,
    comments: post.comments,
    views: post.views,
    url: post.url,
    imageUrl: post.imageUrl
  }));
  return `Analyze this Instagram profile for mobile game marketing and competitor/content strategy.
Profile: ${collection.username}
Period: last ${collection.days} days, since ${collection.sinceDate}
Posts:
${JSON.stringify(posts, null, 2)}

Return JSON only:
{"summary":"","period":{"username":"","days":0,"postCount":0},"contentMix":[{"type":"","count":0,"note":""}],"visualThemes":[],"captionTone":[],"bestPosts":[{"index":0,"reason":"","url":""}],"weaknesses":[],"opportunities":[],"recommendedActions":[],"sevenDayContentPlan":[{"day":"","idea":"","format":"","why":""}],"executiveSummary":""}`;
}

async function analyzeSocialContent(collection = {}) {
  if (!hasOpenAiKey() || typeof fetch !== "function") {
    return { ok: false, code: "AI_NOT_CONFIGURED", error: "OpenAI key is missing. Render'da OPENAI_API_KEY olarak ekli olduğundan emin ol." };
  }
  const prompt = socialAnalysisPrompt(collection);
  const imageUrls = [...new Set((collection.posts || []).flatMap((post) => post.images || post.imageUrl || []).filter(Boolean))].slice(0, 8);
  const systemText = "You are PlayScope AI for mobile game social content strategy. Analyze only provided public post data and images. Return strict JSON only.";
  let lastError = "";
  for (const model of getAiModuleModelCandidates("vision")) {
    const wireApi = getAiModuleWireApi();
    const baseUrl = getAiModuleBaseUrl();
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getOpenAiKey()}`
    };
    let response;
    if (wireApi === "responses") {
      const content = [
        { type: "input_text", text: prompt },
        ...imageUrls.map((image_url) => ({ type: "input_image", image_url }))
      ];
      response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: [{ type: "input_text", text: systemText }] },
            { role: "user", content }
          ],
          max_output_tokens: 2200,
          store: aiModuleStoreEnabled()
        })
      }).catch((error) => ({ ok: false, status: "network", error }));
    } else {
      const content = [
        { type: "text", text: prompt },
        ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))
      ];
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemText },
            { role: "user", content }
          ],
          response_format: { type: "json_object" },
          temperature: 0.25,
          max_tokens: 2200
        })
      }).catch((error) => ({ ok: false, status: "network", error }));
    }
    if (!response?.ok) {
      const detail = typeof response?.text === "function" ? await response.text().catch(() => "") : "";
      lastError = response?.error?.message || `HTTP ${response?.status || "network"} ${detail}`.slice(0, 260);
      continue;
    }
    const data = await response.json().catch(() => null);
    const text = wireApi === "responses" ? responseTextFromResponsesApi(data) : data?.choices?.[0]?.message?.content?.trim();
    const parsed = parseJsonObject(text || "");
    if (parsed) return { ok: true, source: "openai", model, wireApi, imageCount: imageUrls.length, data: parsed };
    lastError = "AI returned non-JSON output.";
  }

  const textOnlyPrompt = `${prompt}

Image analysis failed or was unavailable. Continue using only captions, dates, links, and metrics. If fields are missing, still produce a useful strategy report from the available post text and metadata.`;
  for (const model of getAiModuleModelCandidates("socialText")) {
    const wireApi = getAiModuleWireApi();
    const baseUrl = getAiModuleBaseUrl();
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getOpenAiKey()}`
    };
    let response;
    if (wireApi === "responses") {
      response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: [{ type: "input_text", text: systemText }] },
            { role: "user", content: [{ type: "input_text", text: textOnlyPrompt }] }
          ],
          max_output_tokens: 2200,
          store: aiModuleStoreEnabled()
        })
      }).catch((error) => ({ ok: false, status: "network", error }));
    } else {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemText },
            { role: "user", content: textOnlyPrompt }
          ],
          response_format: { type: "json_object" },
          temperature: 0.25,
          max_tokens: 2200
        })
      }).catch((error) => ({ ok: false, status: "network", error }));
    }
    if (!response?.ok) {
      const detail = typeof response?.text === "function" ? await response.text().catch(() => "") : "";
      lastError = response?.error?.message || `HTTP ${response?.status || "network"} ${detail}`.slice(0, 260);
      continue;
    }
    const data = await response.json().catch(() => null);
    const text = wireApi === "responses" ? responseTextFromResponsesApi(data) : data?.choices?.[0]?.message?.content?.trim();
    const parsed = parseJsonObject(text || "");
    if (parsed) return { ok: true, source: "openai", model, wireApi, imageCount: 0, fallback: "text-only", data: parsed };
    lastError = "AI returned non-JSON output in text-only fallback.";
  }
  return { ok: false, code: "AI_RESPONSE_INVALID", error: lastError || "AI analysis failed." };
}

async function socialContentAnalysis(input = {}) {
  const collection = await fetchInstagramPostsWithApify(input);
  if (!collection.ok) return collection;
  if (!collection.posts.length) {
    return { ...collection, ok: false, code: "NO_POSTS_FOUND", error: "No accessible posts were returned for this period." };
  }
  const analysis = await analyzeSocialContent(collection).catch((error) => ({ ok: false, code: "AI_REQUEST_FAILED", error: error.message }));
  return { ok: true, version: appVersion, collection, analysis };
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
    originalKeywords: keywordListSummary(`${title} ${description}`),
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
    originalKeywords: keywordListSummary(`${title} ${details.genre || ""} ${details.categories?.join(" ") || ""} ${description}`),
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
    originalKeywords: keywordListSummary(`${title} ${item.author || ""} ${category} ${description}`),
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
      originalKeywords: keywordListSummary(`${title} ${item.primaryGenreName || ""} ${item.genres?.join(" ") || ""} ${description}`),
      keywords: keywordSummary(`${title} ${item.primaryGenreName || ""} ${item.genres?.join(" ") || ""} ${description}`),
      url: item.trackViewUrl || ""
    };
  });
  return { ok: true, source: "app-store-search", query, results };
}

function storeCountry(value = "Turkey") {
  const key = String(value || "").trim().toLowerCase();
  const map = {
    turkey: "TR",
    türkiye: "TR",
    tr: "TR",
    china: "CN",
    cn: "CN",
    global: "US",
    "mena/gulf": "SA",
    europe: "DE",
    "southeast asia": "SG",
    us: "US",
    usa: "US",
    english: "US",
    turkish: "TR",
    chinese: "CN"
  };
  return map[key] || String(value || "US").slice(0, 2).toUpperCase();
}

function reviewLangCode(value = "Turkish") {
  const key = String(value || "").trim().toLowerCase();
  if (/turkish|türk|tr/.test(key)) return "tr";
  if (/chinese|中文|zh|cn/.test(key)) return "zh";
  if (/arabic|ar/.test(key)) return "ar";
  return "en";
}

function googlePlayIdFromText(value = "") {
  const text = String(value || "");
  return text.match(/[?&]id=([A-Za-z0-9._]+)/)?.[1] || text.match(/\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+){1,})\b/)?.[1] || "";
}

function appStoreIdFromText(value = "") {
  const text = String(value || "");
  return text.match(/\/id(\d+)/)?.[1] || text.match(/[?&]id=(\d+)/)?.[1] || "";
}

async function googlePlayReviewSearch(input = {}) {
  if (!googlePlayScraper) return { ok: false, error: "Google Play review parser is not installed.", reviews: [] };
  const query = String(input.query || input.gameName || "").trim();
  if (!query) return { ok: false, error: "Game keyword is required.", reviews: [] };
  const country = storeCountry(input.market || input.country || "Turkey").toLowerCase();
  const lang = reviewLangCode(input.reviewLanguage || input.lang || "Turkish");
  const limit = Math.max(1, Math.min(Number(input.limit || 30), 100));
  let appId = googlePlayIdFromText(query);
  let appTitle = "";
  if (!appId) {
    const found = await googlePlayScraper.search({ term: query, num: 1, lang, country });
    appId = found?.[0]?.appId || "";
    appTitle = found?.[0]?.title || "";
  }
  if (!appId) return { ok: false, error: "No Google Play app found for this keyword.", reviews: [] };
  const sort = googlePlayScraper.sort?.NEWEST || 2;
  const raw = await googlePlayScraper.reviews({ appId, sort, num: limit, lang, country });
  const list = Array.isArray(raw) ? raw : (raw?.data || []);
  const reviews = list.map((item) => ({
    text: String(item.text || item.comment || item.title || "").trim(),
    rating: item.score || item.rating || "",
    author: item.userName || item.user || "",
    date: item.date || item.dateText || ""
  })).filter((item) => item.text);
  return { ok: true, source: "google-play-reviews", appId, appName: appTitle || appId, reviews };
}

async function appStoreReviewSearch(input = {}) {
  const query = String(input.query || input.gameName || "").trim();
  if (!query) return { ok: false, error: "Game keyword is required.", reviews: [] };
  const country = storeCountry(input.market || input.country || "Turkey");
  const limit = Math.max(1, Math.min(Number(input.limit || 30), 100));
  let appId = appStoreIdFromText(query);
  let appName = "";
  if (!appId) {
    const search = await appStoreSearch({ query, country, limit: 1 });
    appId = search.results?.[0]?.id || "";
    appName = search.results?.[0]?.name || "";
  }
  if (!appId) return { ok: false, error: "No App Store app found for this keyword.", reviews: [] };
  const url = `https://itunes.apple.com/${country.toLowerCase()}/rss/customerreviews/id=${encodeURIComponent(appId)}/sortBy=mostRecent/json`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 PlayScope/1.0",
      "Accept": "application/json"
    }
  }, 15000);
  if (!response.ok) throw new Error(`App Store reviews HTTP ${response.status}`);
  const data = await response.json();
  const entries = Array.isArray(data.feed?.entry) ? data.feed.entry : [];
  const reviews = entries.map((entry) => ({
    text: String(entry.content?.label || entry.title?.label || "").trim(),
    rating: entry["im:rating"]?.label || "",
    author: entry.author?.name?.label || "",
    date: entry.updated?.label || ""
  })).filter((item) => item.text).slice(0, limit);
  return { ok: true, source: "app-store-reviews", appId, appName: appName || appId, reviews };
}

async function storeReviews(input = {}) {
  const platform = String(input.platform || "Google Play").toLowerCase();
  if (platform.includes("app")) return appStoreReviewSearch(input);
  return googlePlayReviewSearch(input);
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

function aiLanguageName(code) {
  if (code === "zh" || code === "Chinese") return "Chinese";
  if (code === "tr" || code === "Turkish") return "Turkish";
  return "English";
}

function normalizeAiModule(module) {
  const key = String(module || "").trim();
  const aliases = {
    reviewAnalyzer: "review",
    review: "review",
    localizationQa: "localizationQa",
    campaignIdeas: "campaignIdeas",
    weeklyReport: "weeklyReport",
    workspace: "workspace",
    status: "status"
  };
  return aliases[key] || key || "workspace";
}

function aiModuleInstructions(module, inputs = {}) {
  const common = `Return JSON only. Do not wrap in markdown. Do not invent unsupported facts. Do not claim internet, store, API, or database access unless provided in the input.`;
  const modules = {
    review: `${common}
Analyze only the provided player reviews. If no real review text is provided, do not analyze and do not infer reviews.
Do not quote original review lines in the output. Summarize themes only; keep example fields empty or paraphrased without copying user text.
Return:
{"summary":"","sentiment":{"positive":0,"neutral":0,"negative":0},"topComplaints":[{"category":"","severity":"Low|Medium|High","explanation":"","example":""}],"topPraises":[{"category":"","explanation":"","example":""}],"productActions":[],"marketingActions":[],"localizationRisks":[{"language":"","issue":"","suggestion":""}],"executiveSummary":""}`,
    localizationQa: `${common}
Check source text and current translation. Every explanation, verdict, note, and suggestion must be written in the selected output language. If the target language is Turkish, write natural Turkish with Turkish characters.
Respect established terminology if provided; do not invent a random fixed glossary. If terminology is missing, provide reusable suggestions only as recommendations.
For Chinese/Japanese/Korean source terms, always provide a target-language meaning/recommendation instead of leaving it blank.
Return:
{"score":0,"verdict":"","meaningAccuracy":{"status":"Good|Needs review|Problematic","explanation":""},"naturalness":{"status":"Good|Needs improvement","explanation":""},"uiLengthRisk":{"status":"Safe|Slightly long|Too long","explanation":""},"terminology":{"status":"Consistent|Inconsistent|Needs review","issues":[],"suggestions":[{"source":"","recommended":"","note":""}]},"toneStyle":{"status":"","explanation":""},"culturalRisk":{"status":"Low|Medium|High","explanation":""},"suggestedTranslation":"","glossarySuggestions":[{"source":"","recommended":"","note":""}],"explanation":""}`,
    campaignIdeas: `${common}
Generate game campaign ideas only. Do not use or modify influencer database. Do not invent real partnerships. Return:
{"campaignName":"","concept":"","audienceInsight":"","creativeAngle":"","socialIdeas":[{"channel":"","idea":"","execution":""}],"kolIdeas":[],"inGameEventIdeas":[],"localizationSuggestions":[],"riskNotes":[],"adCopies":{"headlines":[],"bodyTexts":[],"pushNotifications":[]}}`,
    weeklyReport: `${common}
Polish only the user's notes. Do not invent specific completed work. Return:
{"language":"","title":"","sections":[{"heading":"","items":[]}],"risks":[],"supportNeeded":[]}`,
    workspace: `${common}
Reply as a practical project assistant. If route is code, answer like a code/debug assistant; otherwise use GPT-style marketing/localization/report help. Return:
{"role":"assistant","title":"","summary":"","bullets":[],"suggestedNextActions":[],"text":""}`
  };
  return modules[module] || modules.workspace;
}

async function aiModuleResponse(body = {}) {
  const module = normalizeAiModule(body.module);
  const hasKey = Boolean(env.OPENAI_API_KEY);
  console.log(`[ai] route reached module=${module} keyConfigured=${hasKey}`);
  if (module === "status") {
    return { ok: true, configured: hasKey, data: { configured: hasKey } };
  }
  const reviewText = String(body.inputs?.reviews || "").trim();
  if (module === "review" && (!reviewText || /^one review per line/i.test(reviewText))) {
    return { ok: false, code: "AI_INPUT_REQUIRED", error: "AI_INPUT_REQUIRED", message: "Please paste real review text before analyzing." };
  }
  if (!hasKey || typeof fetch !== "function") {
    console.log(`[ai] not configured module=${module}`);
    return {
      ok: false,
      code: "AI_NOT_CONFIGURED",
      error: "AI_NOT_CONFIGURED",
      notConfigured: true,
      message: "AI service is not configured. Please connect the backend AI service."
    };
  }
  const language = aiLanguageName(body.language);
  const prompt = `${aiModuleInstructions(module, body.inputs)}

Output language: ${language}
Response style: ${body.responseStyle || "professional"}
Model routing mode: ${body.modelMode || "Auto"}
Project context:
${JSON.stringify(body.projectContext || {}, null, 2)}

User inputs:
${JSON.stringify(body.inputs || {}, null, 2)}`;

  let lastError = "";
  let lastCode = "AI_REQUEST_FAILED";
  for (const model of getAiModuleModelCandidates(module)) {
    console.log(`[ai] using model=${model} module=${module} wire=${getAiModuleWireApi()}`);
    const result = await callAiModuleModel(model, module, prompt).catch((error) => {
      lastError = error.message;
      lastCode = "AI_REQUEST_FAILED";
      console.log(`[ai] openai call failed module=${module} model=${model}`);
      return null;
    });
    const response = result?.response || null;
    if (!response || !response.ok) {
      lastError = response ? `HTTP ${response.status}` : lastError;
      lastCode = "AI_REQUEST_FAILED";
      console.log(`[ai] openai not ok module=${module} model=${model} status=${response ? response.status : "network"}`);
      continue;
    }
    const text = result?.text || "";
    const parsed = parseJsonObject(text);
    if (parsed) {
      console.log(`[ai] parse ok module=${module} model=${model} wire=${result.wireApi}`);
      return { ok: true, module, language, source: "openai", model, wireApi: result.wireApi, data: parsed };
    }
    lastError = "AI returned non-JSON output.";
    lastCode = "AI_RESPONSE_INVALID";
    console.log(`[ai] parse failed module=${module} model=${model}`);
  }
  return {
    ok: false,
    code: lastCode,
    error: lastCode,
    message: lastCode === "AI_RESPONSE_INVALID" ? "AI response format was invalid. Please retry." : "AI request failed. Please check the server logs or try again."
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    if (req.method === "POST" && req.url === "/api/ai") {
      const body = await readJson(req);
      const result = await aiModuleResponse(body).catch((error) => {
        console.log(`[ai] route error module=${normalizeAiModule(body.module)}`);
        return { ok: false, code: "AI_REQUEST_FAILED", error: "AI_REQUEST_FAILED", message: "AI request failed. Please check the server logs or try again." };
      });
      return send(res, 200, result);
    }
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
    if (req.method === "POST" && req.url === "/api/store-reviews") {
      const body = await readJson(req);
      const result = await storeReviews(body).catch((error) => ({ ok: false, error: error.message, reviews: [] }));
      return send(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/api/social-content-analysis") {
      const body = await readJson(req);
      const result = await socialContentAnalysis(body).catch((error) => ({ ok: false, code: "SOCIAL_ANALYSIS_FAILED", error: error.message }));
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
      if (body.openaiBaseUrl) updates.GPT_API_BASE_URL = String(body.openaiBaseUrl).trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
      if (body.openaiModel) updates.GPT_MODEL = body.openaiModel;
      if (body.serpapiKey) updates.SERPAPI_KEY = body.serpapiKey;
      if (body.apifyToken) updates.APIFY_TOKEN = body.apifyToken;
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
    if (req.method === "POST" && req.url === "/api/import-file") {
      const body = await readJson(req);
      const name = String(body.name || "");
      const encoded = String(body.data || "").replace(/^data:[^,]+,/, "");
      if (!encoded) return send(res, 400, { ok: false, error: "File data is required." });
      const fileBuffer = Buffer.from(encoded, "base64");
      const rows = /\.xlsx?$/i.test(name)
        ? parseXlsxRows(fileBuffer)
        : parseDelimitedRowsServer(fileBuffer.toString("utf8"));
      return send(res, 200, { ok: true, rows });
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
        version: appVersion,
        youtube: Boolean(env.YOUTUBE_API_KEY),
        openai: hasOpenAiKey(),
        apify: Boolean(getApifyToken()),
        googleSecret: Boolean(env.GOOGLE_CLIENT_SECRET)
      });
    }
    if (req.method === "GET" && req.url === "/api/client-config") {
      return send(res, 200, {
        youtubeApiKey: env.YOUTUBE_API_KEY || "",
        openaiApiKey: env.OPENAI_API_KEY || "",
        serpapiKey: getSerpApiKey(),
        apifyConfigured: Boolean(getApifyToken()),
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
