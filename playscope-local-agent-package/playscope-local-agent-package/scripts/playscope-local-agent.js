const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const scriptPath = path.join(__dirname, "playscope-capture-screen.ps1");
const outputRoot = path.join(root, "Screenshots");
const port = Number(process.env.PLAYSCOPE_AGENT_PORT || 5199);
function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true"
  });
  res.end(JSON.stringify(body));
}
function readJson(req) { return new Promise((resolve, reject) => { let data=""; req.on("data", c => data += c); req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch(e) { reject(e); } }); }); }
function imageFileToDataUrl(filePath) { return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`; }
function capture(body) {
  const url = String(body.url || "").trim();
  if (!/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) return { ok:false, error:"Paste a valid YouTube link first." };
  if (process.platform !== "win32") return { ok:false, error:"Mouse control requires Windows." };
  fs.mkdirSync(outputRoot, { recursive:true });
  const waitSeconds = Math.max(3, Math.min(Number(body.waitSeconds || 12), 60));
  const args = ["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath,"-OutputRoot",outputRoot,"-Url",url,"-WaitSeconds",String(waitSeconds),"-CropMode","ScrumballPanel","-CropRightPercent",String(body.cropRightPercent || 42),"-CropTopPixels",String(body.cropTopPixels || 70),"-ClickBeforeCapture","-ClickXPercent",String(body.clickXPercent || 96),"-ClickYPercent",String(body.clickYPercent || 8),"-PostClickWaitSeconds",String(body.postClickWaitSeconds || 4)];
  const result = spawnSync("powershell.exe", args, { encoding:"utf8", timeout:(waitSeconds + 45) * 1000 });
  if (result.error) return { ok:false, error:result.error.message };
  if (result.status !== 0) return { ok:false, error:(result.stderr || result.stdout || "Capture failed.").trim() };
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const panel = output.match(/Saved Scrumball panel crop:\s*(.+scrumball-panel\.png)/i)?.[1]?.trim() || "";
  const full = output.match(/Saved screenshot:\s*(.+full-screen\.png)/i)?.[1]?.trim() || "";
  if (!panel || !fs.existsSync(panel)) return { ok:false, error:"Scrumball panel crop was not created.", output };
  return { ok:true, source:"playscope-local-agent", panelPath:panel, fullPath:full, image:imageFileToDataUrl(panel), output };
}
http.createServer(async (req,res) => {
  if (req.method === "OPTIONS") return send(res, 204, {ok:true});
  try {
    if (req.method === "GET" && req.url === "/api/status") return send(res, 200, {ok:true, name:"PlayScope Local Agent", port});
    if (req.method === "POST" && req.url === "/api/capture-scrumball") return send(res, 200, capture(await readJson(req)));
    return send(res, 404, {ok:false, error:"Not found"});
  } catch(e) { return send(res, 500, {ok:false, error:e.message}); }
}).listen(port, "127.0.0.1", () => console.log(`PlayScope Local Agent running at http://127.0.0.1:${port}`));
