import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { GearStore } from './db.js';
import { GearError, ErrorCodes } from './errors.js';
import {
  sectionAtRadius,
  rotateToTooth,
  validateToothIndex,
  GearParams
} from './geometry.js';

const DATA_DIR = process.env.GEAR_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'gear.sqlite');

const store = new GearStore(DB_PATH);

function statusFor(code: string): number {
  switch (code) {
    case ErrorCodes.NOT_FOUND:
      return 404;
    case ErrorCodes.PERSISTENCE:
      return 500;
    default:
      return 400;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

interface RouteCtx {
  store: GearStore;
  body: unknown;
  query: URLSearchParams;
  params: string[];
}

type Handler = (ctx: RouteCtx) => { status?: number; body: unknown };

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new GearError(ErrorCodes.BAD_REQUEST, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const routes: Array<{ method: string; pattern: RegExp; keys: number; handler: Handler }> = [];
function route(method: string, path: string, handler: Handler) {
  // 支持 /:id 形式
  const keys: number[] = [];
  const rx = new RegExp(
    '^' +
      path
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(0);
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$'
  );
  routes.push({ method, pattern: rx, keys: keys.length, handler });
}

route('GET', '/health', () => ({ body: { ok: true } }));
route('GET', '/versions', ({ store: s }) => ({ body: s.listVersions() }));
route('POST', '/versions', ({ store: s, body }) => {
  const b = body as GearParams & { pointsPerSide?: number };
  const { id, profile } = s.createVersion(
    { rb: b.rb, rp: b.rp, ra: b.ra, z: b.z },
    b.pointsPerSide ?? 64
  );
  return { status: 201, body: { id, profile } };
});
route('GET', '/versions/:id', ({ store: s, params }) => ({
  body: { version: s.getVersion(Number(params[0])), profile: s.loadProfile(Number(params[0])) }
}));
route('GET', '/versions/:id/section', ({ store: s, params, query }) => {
  const id = Number(params[0]);
  const profile = s.loadProfile(id);
  const r = Number(query.get('r'));
  return { body: sectionAtRadius(profile.params, r, profile.calibration) };
});
route('GET', '/versions/:id/tooth/:k', ({ store: s, params }) => {
  const id = Number(params[0]);
  const k = Number(params[1]);
  const profile = s.loadProfile(id);
  validateToothIndex(k, profile.params.z);
  return {
    body: {
      toothIndex: k,
      rotationAngle: (2 * Math.PI * k) / profile.params.z,
      left: rotateToTooth(profile.left, k, profile.params.z),
      right: rotateToTooth(profile.right, k, profile.params.z)
    }
  };
});
route('GET', '/versions/:id/calibration', ({ store: s, params }) => {
  const id = Number(params[0]);
  return { body: { calibration: s.loadProfile(id).calibration } };
});
route('GET', '/versions/:id/report', ({ store: s, params }) => ({
  body: s.getReport(Number(params[0]))
}));
route('GET', '/versions/:id/export', ({ store: s, params, query }) => {
  const id = Number(params[0]);
  const profile = s.loadProfile(id);
  const format = (query.get('format') ?? 'json').toLowerCase();
  const rows = [
    ...profile.left.map((p) => ({ ...p, side: 'left' as const })),
    ...profile.right.map((p) => ({ ...p, side: 'right' as const }))
  ];
  if (format === 'csv') {
    const header = 'side,t,r,x,y,theta';
    const csv = [
      header,
      ...rows.map((r0) => [r0.side, r0.t, r0.r, r0.x, r0.y, r0.theta].join(','))
    ].join('\n');
    return { body: { format: 'csv', content: csv } };
  }
  return { body: { format: 'json', profile } };
});
route('POST', '/compare', ({ body }) => {
  const b = body as { a: GearParams; b: GearParams };
  const keys = ['rb', 'rp', 'ra', 'z'] as const;
  const diffs = keys.map((key) => ({
    param: key,
    a: b.a[key],
    b: b.b[key],
    delta: (b.b[key] as number) - (b.a[key] as number)
  }));
  return { body: { diffs } };
});

const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const result = r.handler({
        store,
        body,
        query: url.searchParams,
        params: m.slice(1)
      });
      json(res, result.status ?? 200, result.body);
      return;
    }
    json(res, 404, { error: { code: ErrorCodes.NOT_FOUND, message: '未找到对应路由' } });
  } catch (err) {
    if (err instanceof GearError) {
      json(res, statusFor(err.code), { error: { code: err.code, message: err.message } });
    } else {
      json(res, 500, {
        error: { code: 'INTERNAL', message: (err as Error).message }
      });
    }
  }
});

const requestedPort = Number(process.env.PORT ?? process.argv[2] ?? 0);
const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 0;

function reportListening(actualPort: number, requested: number) {
  console.log(
    JSON.stringify({
      status: 'listening',
      url: `http://127.0.0.1:${actualPort}`,
      port: actualPort,
      requestedPort: requested,
      fellBackToFreePort: requested > 0 && actualPort !== requested,
      dataDir: DATA_DIR
    })
  );
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && port > 0) {
    // 指定端口被占用：回退到系统分配的空闲端口
    server.listen(0, '127.0.0.1');
  } else {
    console.error(JSON.stringify({ status: 'error', message: err.message }));
    process.exitCode = 1;
  }
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  reportListening(actualPort, port);
});
