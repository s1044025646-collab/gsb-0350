import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { openDb, DATA_DIR } from "./db.ts";
import { flanksAtRadius, tAtRadius } from "./geometry.ts";
import {
  compareProfiles, createProfile, getCalibration, listProfiles,
  profilePoints, thicknessAt, toCsv,
} from "./service.ts";
import { start } from "./server.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function numArg(name: string, def?: number): number {
  const v = arg(name);
  if (v === undefined) {
    if (def !== undefined) return def;
    throw new Error(`缺少参数 --${name}`);
  }
  return Number(v);
}

function table(headers: string[], rows: string[][]): string {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(w[i])).join("  ");
  return [line(headers), line(w.map((x) => "-".repeat(x))), ...rows.map(line)].join("\n");
}

const fmt = (x: number, d = 6) => x.toFixed(d);

async function main() {
  const cmd = process.argv[2];
  const db = openDb();

  switch (cmd) {
    case "serve": {
      const p = arg("port");
      await start(p ? Number(p) : undefined);
      break;
    }
    case "create": {
      const rec = createProfile(
        db,
        { rb: numArg("rb"), rp: numArg("rp"), ra: numArg("ra"), z: numArg("z") },
        numArg("samples", 200)
      );
      console.log(`已创建参数版本 id=${rec.id} version=${rec.version} (${rec.algoVersion})`);
      break;
    }
    case "list":
      console.log(table(
        ["id", "ver", "rb", "rp", "ra", "z", "samples", "created"],
        listProfiles(db).map((r) => [
          String(r.id), String(r.version), String(r.params.rb), String(r.params.rp),
          String(r.params.ra), String(r.params.z), String(r.samples), r.createdAt,
        ])
      ));
      break;
    case "points": {
      const pts = profilePoints(db, numArg("id"), numArg("tooth", 0));
      const rows = pts.rows.map((r) => [
        fmt(r.t, 4), fmt(r.r, 4),
        fmt(r.left.x), fmt(r.left.y), fmt(r.right.x), fmt(r.right.y),
        fmt(r.arcThickness),
        r.flags.base ? "基圆" : r.flags.pitch ? "节圆" : r.flags.tip ? "齿顶" : "",
      ]);
      console.log(`齿位 tooth=${pts.tooth}`);
      console.log(table(["t", "r", "left_x", "left_y", "right_x", "right_y", "arc_thk", "标记"], rows));
      break;
    }
    case "thickness": {
      const out = thicknessAt(db, numArg("id"), numArg("r"));
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "calibrate":
      console.log(JSON.stringify(getCalibration(db, numArg("id")), null, 2));
      break;
    case "compare":
      console.log(JSON.stringify(compareProfiles(db, numArg("a"), numArg("b")), null, 2));
      break;
    case "export": {
      const id = numArg("id");
      const format = arg("format") ?? "csv";
      const pts = profilePoints(db, id, numArg("tooth", 0));
      const dir = path.join(DATA_DIR, "export");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `profile_${id}_tooth${pts.tooth}.${format}`);
      writeFileSync(file, format === "csv" ? toCsv(pts) : JSON.stringify(pts, null, 2));
      console.log(`已导出 ${file}`);
      break;
    }
    case "demo": {
      // 普通正参数：z=20, 节圆 50mm, 压力角 20° -> 基圆 rb=rp*cos20°, 齿顶 ra=rp+模数(=2rp/z=5)
      const z = 20;
      const rp = 50;
      const rb = rp * Math.cos((20 * Math.PI) / 180);
      const ra = rp + (2 * rp) / z;
      const rec = createProfile(db, { rb, rp, ra, z }, 41);
      console.log(`演示参数: rb=${fmt(rb, 4)} rp=${rp} ra=${ra} z=${z}  (id=${rec.id})`);
      console.log(`角度约定: ${rec.angleConvention}; 单位: ${rec.units}`);
      console.log("");
      console.log("== 齿厚表（基圆 -> 齿顶，解析截面直接计算）==");
      const rows: string[][] = [];
      for (let i = 0; i <= 10; i++) {
        const r = rb + ((ra - rb) * i) / 10;
        const pr = flanksAtRadius(rec.params, r);
        rows.push([fmt(r, 4), fmt(tAtRadius(rb, r), 4), fmt(pr.arcThickness), fmt(pr.left.theta - pr.right.theta, 8)]);
      }
      console.log(table(["半径r", "参数t", "弧齿厚", "角齿厚rad"], rows));
      console.log("");
      console.log("== 节圆校准 ==");
      const cal = getCalibration(db, rec.id);
      console.log(`节圆角齿厚 = ${cal.pitchAngularThickness}  目标 pi/z = ${Math.PI / z}`);
      console.log(`节圆弧齿厚 = ${cal.actualPitchArcThickness}  目标 = ${cal.targetPitchArcThickness}  残差 = ${cal.pitchResidual}`);
      console.log("");
      console.log("== 相邻齿位旋转关系（tooth=1 与 tooth=0 节圆左点极角差）==");
      const p0 = profilePoints(db, rec.id, 0).rows.find((r) => r.flags.pitch)!;
      const p1 = profilePoints(db, rec.id, 1).rows.find((r) => r.flags.pitch)!;
      console.log(`差值 = ${p1.left.theta - p0.left.theta}  2pi/z = ${(2 * Math.PI) / z}`);
      console.log("");
      console.log("== 半径误差报告（采样点半径 vs 理论 r(t)=rb*sqrt(1+t^2)）==");
      const pts = profilePoints(db, rec.id, 0);
      let maxErr = 0;
      for (const row of pts.rows) {
        const rl = Math.hypot(row.left.x, row.left.y);
        const rr = Math.hypot(row.right.x, row.right.y);
        maxErr = Math.max(maxErr, Math.abs(rl - row.r), Math.abs(rr - row.r));
      }
      console.log(`采样点 ${pts.rows.length} 行，最大半径偏差 = ${maxErr.toExponential(3)} ${rec.units}`);
      console.log("注意：采样折线仅为曲线的离散表示，截面齿厚请使用 thickness 命令的解析结果。");
      const dir = path.join(DATA_DIR, "export");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `demo_profile_${rec.id}.csv`), toCsv(pts));
      writeFileSync(path.join(dir, `demo_profile_${rec.id}.json`), JSON.stringify(pts, null, 2));
      console.log(`已导出 CSV/JSON 到 ${dir}`);
      break;
    }
    default:
      console.log([
        "用法: node src/cli.ts <命令>",
        "  serve [--port N]                 启动 API（默认自动选择空闲端口）",
        "  create --rb --rp --ra --z [--samples N]",
        "  list",
        "  points --id N [--tooth K]        左右点表",
        "  thickness --id N --r R           指定半径截面（解析）",
        "  calibrate --id N                 节圆校准过程",
        "  compare --a ID --b ID            尺寸比较",
        "  export --id N [--tooth K] [--format csv|json]",
        "  demo                             演示：齿厚表/旋转关系/半径误差/导出",
      ].join("\n"));
  }
  db.close();
}

main().catch((e) => {
  console.error(e.code ? `[${e.code}] ${e.message}` : e);
  process.exit(1);
});
