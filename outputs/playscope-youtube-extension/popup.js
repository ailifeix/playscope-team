const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

function collectYouTubePageSeed() {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() || "";
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  const title =
    text("yt-dynamic-text-view-model h1") ||
    text("ytd-channel-name yt-formatted-string") ||
    text("#channel-name yt-formatted-string") ||
    text("h1") ||
    document.title.replace(/\s*-\s*YouTube$/i, "").trim() ||
    "YouTube creator";
  const handleMatch =
    canonical.match(/youtube\.com\/(@[^/?#]+)/i) ||
    location.href.match(/youtube\.com\/(@[^/?#]+)/i) ||
    (document.body?.innerText || "").match(/@[a-z0-9_.-]{3,}/i);

  return {
    source: "youtube-page-extension",
    name: title,
    link: canonical,
    handle: handleMatch ? handleMatch[0] : "",
    country: "Missing",
    geo: "Missing",
    category: "Gaming",
    subcategory: "YouTube API will classify",
    subscribers: "Missing",
    gender: "Missing",
    age: "Missing",
    demographicsSource: "YouTube API does not provide gender/age",
    flag: "",
    channel: "YouTube",
    views: 0,
    avgComments: 0,
    match: 70,
    format: "YouTube API latest videos",
    duration: "-",
    keywords: "",
    comments: "Collected page seed only. PlayScope will calculate subscribers, avg views, avg comments, and keywords using YouTube API.",
    genres: ["youtube"],
    tone: "youtube api",
    audience: "Missing",
    notes: `Collected YouTube page seed from ${canonical}.`,
    shortlisted: false,
    note: ""
  };
}

async function collect() {
  try {
    setStatus("Collecting YouTube page...");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus("Open a YouTube channel or video page first.");
      return;
    }

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectYouTubePageSeed
    });
    const result = injected?.[0]?.result;
    if (!result) {
      setStatus("Could not read this YouTube page. Refresh and try again.");
      return;
    }

    const response = await fetch("http://127.0.0.1:5177/api/extension-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    }).catch(() => null);

    await navigator.clipboard.writeText(JSON.stringify(result, null, 2)).catch(() => null);
    setStatus(response?.ok
      ? `Collected: ${result.name}. Now click Import Extension Data in PlayScope.`
      : `Collected page seed, but PlayScope server did not accept it. JSON copied to clipboard.`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
}

document.getElementById("collect").addEventListener("click", collect);
