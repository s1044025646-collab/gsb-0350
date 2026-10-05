import http from "node:http";
import { openDb } from "./db.ts";
import { GearError } from "./geometry.ts";
import {
  compareProfiles, createProfile, getCalibration, getProfile, listProfiles,
  profilePoints, thicknessAt, toCsv,
} from "./service.ts";

function send(res: http.ServerResponse, status: number, body: unknown, csv = false) {
  const data = csv ? String(body) : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": csv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
  });
  res.end(data);
}

function err(res: http.ServerResponse, e: unknown) {
  if (e instanceof GearError) {
    const status = e.code === "NOT_FOUND" ? 404 : 422;
    send(res, status, { error: { code: e.code, message: e.message } });
  } else {
    send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let buf = "";
  for await (const chunk of req) buf += chunk;
  if (!buf) return {};
  try {
    return JSON.parse(buf);
  } catch {
    throw new GearError("BAD_REQUEST", "请求体必须是 JSON");
  }
}

export function createServer(dbPath?: string) {
  const db = openDb(dbPath);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const num = (v: string | null, name: string) => {
        if (v === null) throw new GearError("BAD_REQUEST", `缺少参数 ${name}`);
        const n = Number(v);
        if (!Number.isFinite(n)) throw new GearError("NON_FINITE_VALUE", `${name} 非有限数值`);
        return n;
      };

      if (req.method === "GET" && url.pathname === "/health")
        return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/profiles") {
        const b = await readBody(req);
        const rec = createProfile(
          db,
          { rb: b.rb, rp: b.rp, ra: b.ra, z: b.z },
          b.samples ?? 200
        );
        return send(res, 201, rec);
      }
      if (req.method === "GET" && url.pathname === "/profiles")
        return send(res, 200, listProfiles(db));

      if (parts[0] === "profiles" && parts.length >= 2) {
        const id = num(parts[1], "id");
        if (req.method === "GET" && parts.length === 2) return send(res, 200, getProfile(db, id));
        if (req.method === "GET" && parts[2] === "points") {
          const tooth = url.searchParams.get("tooth");
          return send(res, 200, profilePoints(db, id, tooth === null ? 0 : num(tooth, "tooth")));
        }
        if (req.method === "GET" && parts[2] === "thickness")
          return send(res, 200, thicknessAt(db, id, num(url.searchParams.get("r"), "r")));
        if (req.method === "GET" && parts[2] === "calibration")
          return send(res, 200, getCalibration(db, id));
        if (req.method === "GET" && parts[2] === "compare")
          return send(res, 200, compareProfiles(db, id, num(url.searchParams.get("other"), "other")));
        if (req.method === "GET" && parts[2] === "export") {
          const tooth = url.searchParams.get("tooth");
          const pts = profilePoints(db, id, tooth === null ? 0 : num(tooth, "tooth"));
          const fmt = url.searchParams.get("format") ?? "json";
          if (fmt === "csv") return send(res, 200, toCsv(pts), true);
          if (fmt === "json") return send(res, 200, pts);
          throw new GearError("BAD_REQUEST", `不支持的导出格式 ${fmt}（支持 csv|json）`);
        }
      }
      throw new GearError("NOT_FOUND", `未知路由 ${req.method} ${url.pathname}`);
    } catch (e) {
      err(res, e);
    }
  });
  return { server, db };
}

export async function start(port?: number, dbPath?: string) {
  const { server } = createServer(dbPath);
  // 默认 0：由系统分配空闲端口
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const listenPort = port ?? envPort ?? 0;
  await new Promise<void>((resolve) => server.listen(listenPort, resolve));
  const addr = server.address() as any;
  console.log(`gear-involute API 已启动: http://127.0.0.1:${addr.port}`);
  return server;
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}` || process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const idx = process.argv.indexOf("--port");
  const port = idx >= 0 ? Number(process.argv[idx + 1]) : undefined;
  start(port);
}
