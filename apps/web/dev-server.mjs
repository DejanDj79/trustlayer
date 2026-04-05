import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = process.cwd();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function resolvePath(urlPath) {
  const clean = urlPath === "/" ? "/index.html" : urlPath;
  const fullPath = path.join(ROOT, clean);
  if (!fullPath.startsWith(ROOT)) {
    return null;
  }
  return fullPath;
}

const server = http.createServer(async (req, res) => {
  try {
    const fullPath = resolvePath(req.url || "/");
    if (!fullPath) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const type = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`TrustLayer web listening on http://${HOST}:${PORT}`);
});
