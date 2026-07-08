// PlayScope website integration idea:
// First try local mouse-control agent from Render/local browser.
async function captureWithPlayScopeLocalAgent(url) {
  const response = await fetch("http://127.0.0.1:5199/api/capture-scrumball", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      waitSeconds: 12,
      clickXPercent: 96,
      clickYPercent: 8,
      cropRightPercent: 42,
      cropTopPixels: 70
    })
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "Local mouse-control capture failed.");
  return result.image; // data:image/png;base64,... send this to /api/read-image-data
}
