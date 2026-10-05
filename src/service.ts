import { DatabaseSync } from "node:sqlite";
import {
  ALGO_VERSION, ANGLE_CONVENTION, UNITS, GearError,
  assertValidTip, calibrationReport, flanksAtRadius, rotatePoint, sampleFlanks,
  validateParams, validateSampleCount, validateTooth,
} from "./geometry.ts";
import type { GearParams, SampleRow } from "./geometry.ts";

export interface ProfileRecord {
  id: number;
  version: number;
  params: GearParams;
  samples: number;
  algoVersion: string;
  units: string;
  angleConvention: string;
  status: string;
  createdAt: string;
}

function paramsKey(p: GearParams): string {
  return [p.rb, p.rp, p.ra, p.z].join("|");
}

function rowToRecord(row: any): ProfileRecord {
  return {
    id: row.id,
    version: row.version,
    params: { rb: row.rb, rp: row.rp, ra: row.ra, z: row.z },
    samples: row.samples,
    algoVersion: row.algo_version,
    units: row.units,
    angleConvention: row.angle_convention,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * 创建参数版本并生成轮廓。先完整校验与生成，再单事务写入；
 * 任一步失败回滚，不覆盖旧结果。相同尺寸产生新的 version。
 */
export function createProfile(db: DatabaseSync, p: GearParams, samples = 200): ProfileRecord {
  validateParams(p);
  validateSampleCount(samples);
  assertValidTip(p); // 齿顶交叉判定：超出有效范围则拒绝
  const rows = sampleFlanks(p, samples);
  const report = calibrationReport(p);
  // 发布前核对：节圆齿厚与端点
  const pitchRow = rows.find((r) => r.atPitch);
  if (!pitchRow || Math.abs(report.pitchResidual) > 1e-9 * p.rp)
    throw new GearError("BAD_REQUEST", "节圆齿厚核验失败，结果未发布");
  if (!(rows[0].atBase && rows[rows.length - 1].atTip))
    throw new GearError("BAD_REQUEST", "端点（基圆/齿顶圆）核验失败，结果未发布");

  const key = paramsKey(p);
  db.exec("BEGIN");
  try {
    const prev = db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM profiles WHERE params_key = ?")
      .get(key) as any;
    const version = prev.v + 1;
    const info = db
      .prepare(
        `INSERT INTO profiles
         (version, params_key, rb, rp, ra, z, samples, algo_version, units, angle_convention, status, points_json, report_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)`
      )
      .run(
        version, key, p.rb, p.rp, p.ra, p.z, samples,
        ALGO_VERSION, UNITS, ANGLE_CONVENTION,
        JSON.stringify(rows), JSON.stringify(report), new Date().toISOString()
      );
    db.exec("COMMIT");
    return getProfile(db, Number(info.lastInsertRowid));
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getProfile(db: DatabaseSync, id: number): ProfileRecord {
  const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as any;
  if (!row) throw new GearError("NOT_FOUND", `参数版本 id=${id} 不存在`);
  return rowToRecord(row);
}

export function listProfiles(db: DatabaseSync): ProfileRecord[] {
  const rows = db.prepare("SELECT * FROM profiles ORDER BY id").all() as any[];
  return rows.map(rowToRecord);
}

function loadParams(db: DatabaseSync, id: number): GearParams {
  return getProfile(db, id).params;
}

/** 指定半径截面：解析求两侧交点与弧齿厚（不依赖采样密度） */
export function thicknessAt(db: DatabaseSync, id: number, r: number) {
  const p = loadParams(db, id);
  const pair = flanksAtRadius(p, r);
  return {
    profileId: id,
    radius: r,
    left: pair.left,
    right: pair.right,
    arcThickness: pair.arcThickness,
    angularThickness: pair.left.theta - pair.right.theta,
    units: UNITS,
    angleUnit: "rad",
  };
}

/** 左右点表（可旋转到指定齿位） */
export function profilePoints(db: DatabaseSync, id: number, tooth = 0) {
  const rec = getProfile(db, id);
  validateTooth(rec.params, tooth);
  const rows = JSON.parse(
    (db.prepare("SELECT points_json FROM profiles WHERE id = ?").get(id) as any).points_json
  ) as SampleRow[];
  const rot = (pt: any) => (tooth === 0 ? pt : rotatePoint(pt, rec.params, tooth));
  return {
    profile: rec,
    tooth,
    rows: rows.map((r) => ({
      t: r.t,
      r: r.r,
      left: rot(r.left),
      right: rot(r.right),
      arcThickness: r.arcThickness,
      flags: { base: r.atBase, pitch: r.atPitch, tip: r.atTip },
    })),
  };
}

export function getCalibration(db: DatabaseSync, id: number) {
  getProfile(db, id);
  return JSON.parse(
    (db.prepare("SELECT report_json FROM profiles WHERE id = ?").get(id) as any).report_json
  );
}

/** 比较两个参数版本的尺寸与节圆齿厚 */
export function compareProfiles(db: DatabaseSync, aId: number, bId: number) {
  const a = getProfile(db, aId);
  const b = getProfile(db, bId);
  const ta = flanksAtRadius(a.params, a.params.rp).arcThickness;
  const tb = flanksAtRadius(b.params, b.params.rp).arcThickness;
  const scale = b.params.rp / a.params.rp;
  return {
    a: aId,
    b: bId,
    dims: {
      rb: [a.params.rb, b.params.rb],
      rp: [a.params.rp, b.params.rp],
      ra: [a.params.ra, b.params.ra],
      z: [a.params.z, b.params.z],
    },
    scaleRB: b.params.rb / a.params.rb,
    scaleRP: scale,
    scaleRA: b.params.ra / a.params.ra,
    pitchArcThickness: [ta, tb],
    pitchArcThicknessRatio: tb / ta,
    uniformlyScaled:
      Math.abs(b.params.rb / a.params.rb - scale) < 1e-12 &&
      Math.abs(b.params.ra / a.params.ra - scale) < 1e-12 &&
      a.params.z === b.params.z,
  };
}

export function toCsv(points: ReturnType<typeof profilePoints>): string {
  const lines = ["side,tooth,t,r,theta_rad,x,y,arc_thickness,flag"];
  for (const row of points.rows) {
    const flag = row.flags.base ? "base" : row.flags.pitch ? "pitch" : row.flags.tip ? "tip" : "";
    for (const side of ["left", "right"] as const) {
      const pt = row[side];
      lines.push(
        [side, points.tooth, row.t, row.r, pt.theta, pt.x, pt.y, row.arcThickness, flag].join(",")
      );
    }
  }
  return lines.join("\n") + "\n";
}
