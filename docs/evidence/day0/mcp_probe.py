import json, sys, urllib.request, ssl, os
URL = json.load(open(sys.argv[1]))["mcpServers"]["supabase"]["url"]
ctx = ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
sid = None; n = 0
def rpc(method, params=None, notify=False):
    global sid, n
    body = {"jsonrpc": "2.0", "method": method}
    if params is not None: body["params"] = params
    if not notify: n += 1; body["id"] = n
    h = {"User-Agent": "topstock-mcp-probe/1.0", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if sid: h["Mcp-Session-Id"] = sid
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers=h, method="POST")
    try:
        r = urllib.request.urlopen(req, context=ctx, timeout=60)
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:300]}
    sid = r.headers.get("Mcp-Session-Id") or sid
    raw = r.read().decode()
    if notify or not raw.strip(): return None
    if raw.lstrip().startswith("{"): return json.loads(raw)
    for line in raw.splitlines():
        if line.startswith("data:"): return json.loads(line[5:])
def text(res):
    if "error" in res: return "ERROR: " + json.dumps(res["error"])[:400]
    r = res["result"]; t = " ".join(c.get("text", "") for c in r.get("content", []))
    return ("isError=True: " if r.get("isError") else "") + t
print("URL:", URL)
init = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "topstock-probe", "version": "1"}})
if "http_error" in init: print(init); sys.exit(1)
print("server:", init["result"]["serverInfo"])
rpc("notifications/initialized", notify=True)
names = sorted(t["name"] for t in rpc("tools/list")["result"]["tools"])
print("tools (%d):" % len(names), ", ".join(names))
for bad in ["list_projects", "list_organizations", "create_project", "get_organization", "apply_migration", "deploy_edge_function", "create_branch"]:
    print("  absent %-20s %s" % (bad, bad not in names))
print("(a) list_tables:", text(rpc("tools/call", {"name": "list_tables", "arguments": {"schemas": ["public"]}}))[:400])
print("    get_project_url:", text(rpc("tools/call", {"name": "get_project_url", "arguments": {}}))[:200])
print("    select:", text(rpc("tools/call", {"name": "execute_sql", "arguments": {"query": "select current_database(), current_setting('transaction_read_only') as ro"}}))[:400])
print("(c) write:", text(rpc("tools/call", {"name": "execute_sql", "arguments": {"query": "create table public.mcp_readonly_probe (id int)"}}))[:400])
print("    after:", text(rpc("tools/call", {"name": "execute_sql", "arguments": {"query": "select to_regclass('public.mcp_readonly_probe') as probe_table"}}))[:600])
