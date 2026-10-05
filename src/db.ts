import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ALGORITHM_VERSION,
  generateProfile,
  GearParams,
  ProfileResult,
  validateParams
} from './geometry.js';
import { GearError, ErrorCodes } from './errors.js';

export interface VersionRow {
  id: number;
  rb: number;
  rp: number;
  ra: number;
  z: number;
  points_per_side: number;
  created_at: string;
}

export class GearStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rb REAL NOT NULL,
        rp REAL NOT NULL,
        ra REAL NOT NULL,
        z INTEGER NOT NULL,
        points_per_side INTEGER NOT NULL,
        convention TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS profiles (
        version_id INTEGER PRIMARY KEY,
        calibration TEXT NOT NULL,
        tip_report TEXT NOT NULL,
        valid_to_tip INTEGER NOT NULL,
        FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS points (
        version_id INTEGER NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('left','right')),
        idx INTEGER NOT NULL,
        t REAL NOT NULL,
        r REAL NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        theta REAL NOT NULL,
        PRIMARY KEY (version_id, side, idx),
        FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS verification_reports (
        version_id INTEGER PRIMARY KEY,
        report TEXT NOT NULL,
        FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
      );
    `);
  }

  listVersions(): VersionRow[] {
    return this.db.prepare('SELECT * FROM versions ORDER BY id').all() as unknown as VersionRow[];
  }

  getVersion(id: number): VersionRow {
    const row = this.db.prepare('SELECT * FROM versions WHERE id = ?').get(id) as unknown as
      | VersionRow
      | undefined;
    if (!row) throw new GearError(ErrorCodes.NOT_FOUND, `参数版本 ${id} 不存在`);
    return row;
  }

  // 修改尺寸 -> 新版本；生成成功并通过校验后才提交，失败回滚不覆盖旧结果
  createVersion(
    params: GearParams,
    pointsPerSide: number,
    opts: { allowInvalidTip?: boolean } = {}
  ): { id: number; profile: ProfileResult } {
    const p = validateParams(params);
    const profile = generateProfile(p, { pointsPerSide });

    // 发布前核对端点与节圆齿厚
    const report = verifyProfile(profile);
    if (!report.ok || (!profile.validToTip && !opts.allowInvalidTip)) {
      throw new GearError(
        ErrorCodes.CROSSED_OUT_OF_RANGE,
        `几何核验未通过，拒绝保存：${report.failures.join('；')}`
      );
    }

    const insertVersion = this.db.prepare(`
      INSERT INTO versions (rb, rp, ra, z, points_per_side, convention, algorithm_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertProfile = this.db.prepare(`
      INSERT INTO profiles (version_id, calibration, tip_report, valid_to_tip)
      VALUES (?, ?, ?, ?)
    `);
    const insertPoint = this.db.prepare(`
      INSERT INTO points (version_id, side, idx, t, r, x, y, theta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertReport = this.db.prepare(`
      INSERT INTO verification_reports (version_id, report) VALUES (?, ?)
    `);

    const tx = this.db.exec.bind(this.db);
    let id = -1;
    try {
      this.db.exec('BEGIN');
      const r = insertVersion.run(
        p.rb,
        p.rp,
        p.ra,
        p.z,
        pointsPerSide,
        JSON.stringify(profile.convention),
        ALGORITHM_VERSION
      );
      id = Number(r.lastInsertRowid);
      insertProfile.run(
        id,
        JSON.stringify(profile.calibration),
        JSON.stringify(profile.tip),
        profile.validToTip ? 1 : 0
      );
      profile.left.forEach((pt, i) =>
        insertPoint.run(id, 'left', i, pt.t, pt.r, pt.x, pt.y, pt.theta)
      );
      profile.right.forEach((pt, i) =>
        insertPoint.run(id, 'right', i, pt.t, pt.r, pt.x, pt.y, pt.theta)
      );
      insertReport.run(id, JSON.stringify(report));
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 忽略回滚错误 */
      }
      throw new GearError(ErrorCodes.PERSISTENCE, `保存失败并已回滚：${(err as Error).message}`);
    }
    void tx;
    return { id, profile };
  }

  loadProfile(id: number): ProfileResult {
    const v = this.getVersion(id);
    const profRow = this.db
      .prepare('SELECT * FROM profiles WHERE version_id = ?')
      .get(id) as { calibration: string; tip_report: string; valid_to_tip: number };
    const pts = this.db
      .prepare('SELECT * FROM points WHERE version_id = ? ORDER BY side, idx')
      .all(id) as Array<{
      side: 'left' | 'right';
      t: number;
      r: number;
      x: number;
      y: number;
      theta: number;
    }>;
    const left = pts
      .filter((q) => q.side === 'left')
      .map((q) => ({ ...q, side: 'left' as const }));
    const right = pts
      .filter((q) => q.side === 'right')
      .map((q) => ({ ...q, side: 'right' as const }));
    return {
      params: { rb: v.rb, rp: v.rp, ra: v.ra, z: v.z },
      left,
      right,
      calibration: JSON.parse(profRow.calibration),
      tip: JSON.parse(profRow.tip_report),
      validToTip: profRow.valid_to_tip === 1,
      convention: JSON.parse(
        (this.db.prepare('SELECT convention FROM versions WHERE id=?').get(id) as {
          convention: string;
        }).convention
      )
    };
  }

  getReport(id: number): unknown {
    this.getVersion(id);
    const row = this.db
      .prepare('SELECT report FROM verification_reports WHERE version_id = ?')
      .get(id) as { report: string } | undefined;
    return row ? JSON.parse(row.report) : null;
  }

  close() {
    this.db.close();
  }
}

// 发布前核验：端点半径、镜像对称性、节圆左右角差恰为 π/z
export function verifyProfile(profile: ProfileResult): {
  ok: boolean;
  failures: string[];
  checks: Record<string, unknown>;
} {
  const failures: string[] = [];
  const eps = 1e-9;
  const { params: p, left, right, calibration: cal, tip } = profile;

  const checks: Record<string, unknown> = {};

  // 1. 端点：t=0 在基圆，末端在齿顶圆
  const baseL = left[0];
  const baseR = right[0];
  const tipL = left[left.length - 1];
  const tipR = right[right.length - 1];
  checks.baseRadius = { left: baseL.r, right: baseR.r, expected: p.rb };
  checks.tipRadius = { left: tipL.r, right: tipR.r, expected: p.ra };
  if (Math.abs(baseL.r - p.rb) > eps * p.rb) failures.push('左侧基圆端点半径不等于 rb');
  if (Math.abs(baseR.r - p.rb) > eps * p.rb) failures.push('右侧基圆端点半径不等于 rb');
  if (Math.abs(tipL.r - p.ra) > eps * p.ra) failures.push('左侧齿顶端点半径不等于 ra');
  if (Math.abs(tipR.r - p.ra) > eps * p.ra) failures.push('右侧齿顶端点半径不等于 ra');
  if (Math.abs(baseL.t) > eps || Math.abs(baseR.t) > eps) failures.push('基圆处参数 t 不为 0');

  // 2. 节圆点必须精确存在
  const pitchL = left.find((q) => Math.abs(q.r - p.rp) <= eps * p.rp);
  const pitchR = right.find((q) => Math.abs(q.r - p.rp) <= eps * p.rp);
  if (!pitchL || !pitchR) {
    failures.push('节圆点未精确插入采样集');
  } else {
    const diff = pitchL.theta - pitchR.theta;
    checks.pitchAngleDiff = { actual: diff, expected: cal.targetAngle };
    if (Math.abs(diff - cal.targetAngle) > eps) {
      failures.push(`节圆左右角差 ${diff} 不等于 π/z ${cal.targetAngle}`);
    }
    // 镜像检查
    let mirrorMax = 0;
    for (let i = 0; i < left.length; i++) {
      mirrorMax = Math.max(
        mirrorMax,
        Math.abs(left[i].x - right[i].x),
        Math.abs(left[i].y + right[i].y),
        Math.abs(left[i].theta + right[i].theta)
      );
    }
    checks.mirrorMaxAbsDiff = mirrorMax;
    if (mirrorMax > 1e-9 * Math.max(1, p.ra)) failures.push('左右齿廓关于齿中心线不对称');
  }

  // 3. 齿顶交叉 / 非正齿厚
  checks.tipToothThicknessAngle = tip.toothThicknessAngle;
  if (!(tip.toothThicknessAngle > 0)) {
    failures.push('齿顶处两侧齿廓交叉或齿厚非正，超出本模型有效范围');
  }

  return { ok: failures.length === 0, failures, checks };
}
