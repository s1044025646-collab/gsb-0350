// 渐开线直齿轮单齿双侧工作齿廓几何核心。
// 约定：长度单位统一由调用方给定（如 mm），角度内部一律为弧度。
// 齿中心线为 +x 轴（极角 0），左侧齿廓在正角方向，右侧在负角方向。
// 基础渐开线：x=rb(cos t + t sin t), y=rb(sin t - t cos t)，半径 r(t)=rb*sqrt(1+t^2)。

export const ALGO_VERSION = "involute-single-tooth/1.0.0";
export const UNITS = "mm";
export const ANGLE_CONVENTION =
  "angles=radians; toothCenterline=+x; leftFlank=+angle; rightFlank=-angle; rotation=CCW-positive; toothIndex=0-based";

export interface GearParams {
  rb: number; // 基圆半径
  rp: number; // 节圆半径
  ra: number; // 齿顶圆半径
  z: number;  // 齿数
}

export interface Point {
  x: number;
  y: number;
  r: number;      // 半径
  theta: number;  // 极角（弧度）
  t: number;      // 渐开线参数
}

export interface FlankPair {
  left: Point;
  right: Point;
  arcThickness: number; // 该半径圆上的弧齿厚
}

export type ErrorCode =
  | "NON_FINITE_VALUE"
  | "NON_POSITIVE_VALUE"
  | "INVALID_RADIUS_RELATION"
  | "NON_INTEGER_TEETH"
  | "TOO_FEW_TEETH"
  | "TOO_MANY_POINTS"
  | "TOO_FEW_POINTS"
  | "RADIUS_OUT_OF_RANGE"
  | "TOOTH_OUT_OF_RANGE"
  | "TIP_THICKNESS_NON_POSITIVE"
  | "NOT_FOUND"
  | "BAD_REQUEST";

export class GearError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const MAX_SAMPLES = 10000;
export const MIN_SAMPLES = 2;

export function validateParams(p: GearParams): void {
  const vals: Array<[string, number]> = [
    ["rb", p.rb],
    ["rp", p.rp],
    ["ra", p.ra],
    ["z", p.z],
  ];
  for (const [name, v] of vals) {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new GearError("NON_FINITE_VALUE", `${name} 必须为有限数值，收到 ${v}`);
    if (v <= 0)
      throw new GearError("NON_POSITIVE_VALUE", `${name} 必须为正值，收到 ${v}`);
  }
  if (!Number.isInteger(p.z))
    throw new GearError("NON_INTEGER_TEETH", `齿数必须为整数，收到 ${p.z}`);
  if (p.z < 3)
    throw new GearError("TOO_FEW_TEETH", `齿数至少为 3，收到 ${p.z}`);
  if (!(p.ra > p.rp && p.rp > p.rb))
    throw new GearError(
      "INVALID_RADIUS_RELATION",
      `必须满足 ra > rp > rb > 0，收到 rb=${p.rb}, rp=${p.rp}, ra=${p.ra}`
    );
}

export function validateSampleCount(n: number): void {
  if (!Number.isInteger(n) || n < MIN_SAMPLES)
    throw new GearError("TOO_FEW_POINTS", `采样点数必须为 >= ${MIN_SAMPLES} 的整数，收到 ${n}`);
  if (n > MAX_SAMPLES)
    throw new GearError("TOO_MANY_POINTS", `采样点数超过上限 ${MAX_SAMPLES}，收到 ${n}`);
}

/** 半径 r 对应的渐开线参数 t（r 必须在 [rb, +inf)） */
export function tAtRadius(rb: number, r: number): number {
  const q = (r / rb) ** 2 - 1;
  return Math.sqrt(Math.max(0, q));
}

/** 渐开线函数 inv(alpha) = t - atan(t)，即基础曲线在参数 t 处的极角 */
export function invAlpha(t: number): number {
  return t - Math.atan(t);
}

/** 基础渐开线直角坐标（未做节圆角度校准） */
export function basePoint(rb: number, t: number): { x: number; y: number } {
  return {
    x: rb * (Math.cos(t) + t * Math.sin(t)),
    y: rb * (Math.sin(t) - t * Math.cos(t)),
  };
}

/** 节圆处半角齿厚（弧度）：pi/(2z) */
export function halfToothAngleAtPitch(p: GearParams): number {
  return Math.PI / (2 * p.z);
}

/**
 * 半径 r 处右侧齿廓极角（负值）。
 * 校准：节圆上右侧点极角 = -pi/(2z)，即把基础曲线整体旋转
 * -(invAlpha(tP) + pi/(2z))，而非简单镜像。
 */
export function rightFlankAngle(p: GearParams, r: number): number {
  const tP = tAtRadius(p.rb, p.rp);
  const t = tAtRadius(p.rb, r);
  return invAlpha(t) - invAlpha(tP) - halfToothAngleAtPitch(p);
}

/** 半径 r 处左右两侧交点与该圆上的弧齿厚（解析解，非采样近似） */
export function flanksAtRadius(p: GearParams, r: number): FlankPair {
  if (!Number.isFinite(r)) throw new GearError("NON_FINITE_VALUE", `半径必须为有限数值，收到 ${r}`);
  if (r < p.rb || r > p.ra)
    throw new GearError(
      "RADIUS_OUT_OF_RANGE",
      `半径 ${r} 超出工作范围 [rb=${p.rb}, ra=${p.ra}]（齿根区域未建模）`
    );
  const t = tAtRadius(p.rb, r);
  const thetaR = rightFlankAngle(p, r);
  const thetaL = -thetaR;
  const arc = r * (thetaL - thetaR);
  const mk = (theta: number): Point => ({
    x: r * Math.cos(theta),
    y: r * Math.sin(theta),
    r,
    theta,
    t,
  });
  return { left: mk(thetaL), right: mk(thetaR), arcThickness: arc };
}

/** 齿顶处弧齿厚；<=0 表示两侧已交叉，超出本模型有效范围 */
export function tipArcThickness(p: GearParams): number {
  return flanksAtRadiusAllowTip(p, p.ra);
}

function flanksAtRadiusAllowTip(p: GearParams, r: number): number {
  const thetaR = rightFlankAngle(p, r);
  return r * (-2 * thetaR);
}

/** 校验齿顶齿厚为正，否则判定超出模型有效范围 */
export function assertValidTip(p: GearParams): void {
  const s = tipArcThickness(p);
  if (!(s > 0))
    throw new GearError(
      "TIP_THICKNESS_NON_POSITIVE",
      `齿顶圆处弧齿厚为 ${s}（<=0），两侧齿廓在到达齿顶前已交叉，超出本模型有效范围；请减小 ra`
    );
}

export interface SampleRow {
  t: number;
  r: number;
  left: Point;
  right: Point;
  arcThickness: number;
  atBase: boolean;
  atPitch: boolean;
  atTip: boolean;
}

/**
 * 生成单齿双侧采样点。普通采样点按参数 t 在 [0, tTip] 上均匀分布，
 * 并精确插入节圆对应点（t = tP）。
 */
export function sampleFlanks(p: GearParams, samples: number): SampleRow[] {
  validateSampleCount(samples);
  const tTip = tAtRadius(p.rb, p.ra);
  const tP = tAtRadius(p.rb, p.rp);
  const ts = new Set<number>();
  for (let i = 0; i < samples; i++) ts.add((tTip * i) / (samples - 1));
  ts.add(tP); // 节圆点精确插入
  const sorted = [...ts].sort((a, b) => a - b);
  const eps = 1e-12 * Math.max(1, tTip);
  return sorted.map((t) => {
    const r = p.rb * Math.sqrt(1 + t * t);
    const pair = flanksAtRadius(p, Math.min(r, p.ra));
    return {
      t,
      r: pair.left.r,
      left: pair.left,
      right: pair.right,
      arcThickness: pair.arcThickness,
      atBase: Math.abs(t) <= eps,
      atPitch: Math.abs(t - tP) <= eps,
      atTip: Math.abs(t - tTip) <= eps,
    };
  });
}

/** 旋转到第 k 齿（0 基），即所有极角加 2*pi*k/z */
export function rotatePoint(pt: Point, p: GearParams, tooth: number): Point {
  validateTooth(p, tooth);
  const d = (2 * Math.PI * tooth) / p.z;
  return {
    x: pt.x * Math.cos(d) - pt.y * Math.sin(d),
    y: pt.x * Math.sin(d) + pt.y * Math.cos(d),
    r: pt.r,
    theta: pt.theta + d,
    t: pt.t,
  };
}

export function validateTooth(p: GearParams, tooth: number): void {
  if (!Number.isInteger(tooth) || tooth < 0 || tooth >= p.z)
    throw new GearError("TOOTH_OUT_OF_RANGE", `齿位必须为 [0, ${p.z - 1}] 的整数，收到 ${tooth}`);
}

export interface CalibrationReport {
  algoVersion: string;
  tPitch: number;
  invAlphaPitch: number;
  halfToothAnglePitch: number; // pi/(2z)
  rotationApplied: number;     // 施加在基础曲线上的旋转角（弧度）
  targetPitchArcThickness: number; // pi*rp/z
  actualPitchArcThickness: number;
  pitchResidual: number;
  tipArcThickness: number;
  basePoint: { x: number; y: number; r: number };
  pitchLeftTheta: number;
  pitchRightTheta: number;
  pitchAngularThickness: number; // 应恰为 pi/z
  notes: string[];
}

/** 节圆校准过程报告 */
export function calibrationReport(p: GearParams): CalibrationReport {
  const tP = tAtRadius(p.rb, p.rp);
  const inv = invAlpha(tP);
  const half = halfToothAngleAtPitch(p);
  const pitch = flanksAtRadius(p, p.rp);
  const base = flanksAtRadius(p, p.rb);
  const target = (Math.PI * p.rp) / p.z;
  return {
    algoVersion: ALGO_VERSION,
    tPitch: tP,
    invAlphaPitch: inv,
    halfToothAnglePitch: half,
    rotationApplied: -(inv + half),
    targetPitchArcThickness: target,
    actualPitchArcThickness: pitch.arcThickness,
    pitchResidual: pitch.arcThickness - target,
    tipArcThickness: tipArcThickness(p),
    basePoint: { x: base.right.x, y: base.right.y, r: p.rb },
    pitchLeftTheta: pitch.left.theta,
    pitchRightTheta: pitch.right.theta,
    pitchAngularThickness: pitch.left.theta - pitch.right.theta,
    notes: [
      "基础渐开线极角为 inv(alpha)=t-atan(t)；将右侧曲线整体旋转 -(invAlpha(tP)+pi/(2z)) 使节圆右点落在 -pi/(2z)",
      "左侧为右侧关于齿中心线(+x 轴)的镜像；节圆角齿厚恰为 pi/z，对应弧长 pi*rp/z",
      "采样折线仅为曲线的离散表示；指定半径的齿厚由解析截面直接计算，不取最近采样点",
      "齿根过渡区域（r < rb）未建模，不做圆角填充",
    ],
  };
}
