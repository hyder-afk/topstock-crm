// Local-only stand-in for the Supabase API gateway: /auth/v1/* -> Supabase Auth on :9999. Everything else 404.
import http from "node:http";
http.createServer((req, res) => {
  if (!req.url.startsWith("/auth/v1/")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
  const path = req.url.slice("/auth/v1".length);
  const up = http.request({ host: "127.0.0.1", port: 9999, path, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(54321, "127.0.0.1");
