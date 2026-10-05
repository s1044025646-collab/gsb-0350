import { GearError, ErrorCodes } from './errors.js';

export const ALGORITHM_VERSION = 'inv-1.0.0';

export interface GearParams {
  rb: number; // 基圆半径
  rp: number; // 节圆半径
  ra: number; // 齿顶圆半径
  z: number; // 齿数
}

export interface SamplePoint {
  t: number; // 渐开线参数
  r: number; // 所在圆半径
  x: number;
  y: number;
  theta: number; // 极角（弧度，齿槽/齿中心线约定下）
}

export interface FlankPoint extends SamplePoint {
  side: 'left' | 'right';
}

export interface SectionResult {
  r: number;
  t: number;
  left: { x: number; y: number; theta: number };
  right: { x: number; y: number; theta: number };
  toothThicknessAngle: number; // 弧度
  arcThickness: number; // 弧长 = r * 角齿厚
  valid: boolean;
}

export interface CalibrationInfo {
  invAlphaP: number; // 节圆处渐开角 inv(alpha_p) = tan(alpha_p) - alpha_p
  alphaPRad: number; // 节圆压力角（弧度）
  halfToothAngleP: number; // π/(2z)
  betaP: number; // 校准角：半齿厚角 + 渐开角
  thetaLeftP: number;
  thetaRightP: number;
  angleDiffP: number; // 左右极角差，应恰为 π/z
  targetAngle: number; // π/z
  arcThicknessP: number; // π*rp/z
}

export interface ProfileResult {
  params: GearParams;
  left: FlankPoint[];
  right: FlankPoint[];
  calibration: CalibrationInfo;
  tip: SectionResult;
  validToTip: boolean;
  convention: Convention;
}

export interface Convention {
  lengthUnit: '同一长度单位（输入单位即输出单位）';
  angleUnit: '弧度';
  polarZero: '齿中心线（+x 轴方向）';
  positiveRotation: '逆时针为正';
  leftSide: '极角为正的一侧（逆时针侧）';
  rightSide: '极角为负的一侧（顺时针侧）';
  toothIndexRotation: '第 k 个齿绕原点逆时针旋转 2πk/z';
  rootRegion: '未建模：基圆以内的齿根/过渡圆角不属于本模型';
  polylineNote: '采样点折线仅为连续渐开线曲线的离散表示，不是曲线本身';
}

export const CONVENTION: Convention = {
  lengthUnit: '同一长度单位（输入单位即输出单位）',
  angleUnit: '弧度',
  polarZero: '齿中心线（+x 轴方向）',
  positiveRotation: '逆时针为正',
  leftSide: '极角为正的一侧（逆时针侧）',
  rightSide: '极角为负的一侧（顺时针侧）',
  toothIndexRotation: '第 k 个齿绕原点逆时针旋转 2πk/z',
  rootRegion: '未建模：基圆以内的齿根/过渡圆角不属于本模型',
  polylineNote: '采样点折线仅为连续渐开线曲线的离散表示，不是曲线本身'
};

const MAX_POINTS = 10000;

export function validateParams(p: Partial<GearParams>): GearParams {
  const { rb, rp, ra, z } = p as GearParams;
  for (const [name, v] of [
    ['rb', rb],
    ['rp', rp],
    ['ra', ra]
  ] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new GearError(ErrorCodes.NON_FINITE, `${name} 必须为有限数值`);
    }
    if (v <= 0) {
      throw new GearError(ErrorCodes.NON_POSITIVE, `${name} 必须为正值`);
    }
  }
  if (typeof z !== 'number' || !Number.isFinite(z) || !Number.isInteger(z)) {
    throw new GearError(ErrorCodes.INVALID_TEETH, '齿数 z 必须为整数');
  }
  if (z <= 0) {
    throw new GearError(ErrorCodes.INVALID_TEETH, '齿数 z 必须为正整数');
  }
  if (!(rb < rp) || !(rp < ra)) {
    throw new GearError(
      ErrorCodes.INVALID_RADIUS_ORDER,
      '必须满足 0 < rb(基圆) < rp(节圆) < ra(齿顶圆)'
    );
  }
  return { rb, rp, ra, z };
}

export function validatePointCount(n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 2) {
    throw new GearError(ErrorCodes.INVALID_POINT_COUNT, '采样点数必须为不小于 2 的整数');
  }
  if (n > MAX_POINTS) {
    throw new GearError(ErrorCodes.INVALID_POINT_COUNT, `单侧采样点数不得超过 ${MAX_POINTS}`);
  }
  return n;
}

export function validateToothIndex(k: number, z: number): number {
  if (typeof k !== 'number' || !Number.isFinite(k) || !Number.isInteger(k)) {
    throw new GearError(ErrorCodes.INVALID_TOOTH_INDEX, '齿位编号必须为整数');
  }
  if (k < 0 || k >= z) {
    throw new GearError(ErrorCodes.INVALID_TOOTH_INDEX, `齿位编号必须在 [0, ${z - 1}] 内（从零编号）`);
  }
  return k;
}

// r = rb * sqrt(1 + t^2) => t = sqrt((r/rb)^2 - 1)
export function tAtRadius(r: number, rb: number): number {
  const q = r / rb;
  return Math.sqrt(q * q - 1);
}

// 基础渐开线点（未做角度校准），其极角为 inv(t)=atan(t)-t...
// 按给定公式：x=rb(cos t + t sin t), y=rb(sin t - t cos t)
// 该点极角恒为 atan2(y,x) = t - atan(t)（当 t>0 时为正）。
function basePoint(rb: number, t: number): { x: number; y: number; theta: number } {
  const x = rb * (Math.cos(t) + t * Math.sin(t));
  const y = rb * (Math.sin(t) - t * Math.cos(t));
  return { x, y, theta: Math.atan2(y, x) };
}

function rotateXY(x: number, y: number, a: number): { x: number; y: number } {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: c * x - s * y, y: s * x + c * y };
}

// 节圆校准
export function calibrate(p: GearParams): CalibrationInfo {
  const { rb, rp, z } = p;
  const tp = tAtRadius(rp, rb);
  const alphaP = Math.atan(tp); // 节圆压力角
  const invAlphaP = Math.tan(alphaP) - alphaP;
  const halfToothAngleP = Math.PI / (2 * z);
  const betaP = halfToothAngleP + invAlphaP;

  const thetaLeftP = betaP - invAlphaP; // = halfToothAngleP
  const thetaRightP = -(betaP - invAlphaP);
  const angleDiffP = thetaLeftP - thetaRightP;
  const targetAngle = Math.PI / z;
  return {
    invAlphaP,
    alphaPRad: alphaP,
    halfToothAngleP,
    betaP,
    thetaLeftP,
    thetaRightP,
    angleDiffP,
    targetAngle,
    arcThicknessP: (Math.PI * rp) / z
  };
}

// 已校准的单侧点。left：极角 = betaP - inv(t)；right：取负。
function flankPoint(
  p: GearParams,
  t: number,
  side: 'left' | 'right',
  betaP: number
): FlankPoint {
  const r = p.rb * Math.sqrt(1 + t * t);
  const base = basePoint(p.rb, t);
  const invT = t - Math.atan(t); // 基础渐开线极角（正）
  let theta: number;
  let xy: { x: number; y: number };
  if (side === 'left') {
    // 镜像基础曲线（关于 +x 轴），再逆时针旋转 betaP
    theta = betaP - invT;
    xy = rotateXY(base.x, -base.y, betaP);
  } else {
    // 直接使用基础曲线，顺时针旋转 betaP
    theta = invT - betaP;
    xy = rotateXY(base.x, base.y, -betaP);
  }
  return { t, r, x: xy.x, y: xy.y, theta, side };
}

// 构造参数 t 的有序列表：t=0（基圆）、节圆点精确插入、均匀普通采样、t_a（齿顶）
function buildTGrid(p: GearParams, pointsPerSide: number): number[] {
  const t0 = 0;
  const ta = tAtRadius(p.ra, p.rb);
  const tp = tAtRadius(p.rp, p.rb);
  const grid: number[] = [];
  for (let i = 0; i < pointsPerSide; i++) {
    grid.push(t0 + (ta - t0) * (i / (pointsPerSide - 1)));
  }
  // 精确插入 t=0 与 tp（去重，容差相对尺度）
  const insert = (v: number) => {
    if (!grid.some((g) => Math.abs(g - v) <= 1e-12 * Math.max(1, ta))) grid.push(v);
  };
  insert(0);
  insert(tp);
  insert(ta);
  grid.sort((a, b) => a - b);
  return grid;
}

// 精确半径截面：直接解析求解，不使用最近采样点
export function sectionAtRadius(p: GearParams, r: number, calibration?: CalibrationInfo): SectionResult {
  if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) {
    throw new GearError(ErrorCodes.NON_FINITE, '半径必须为正的有限数值');
  }
  if (r < p.rb - 1e-12 * p.rb) {
    throw new GearError(
      ErrorCodes.RADIUS_OUT_OF_RANGE,
      `半径 ${r} 小于基圆 ${p.rb}；基圆以内齿根区域未建模`
    );
  }
  if (r > p.ra + 1e-12 * p.ra) {
    throw new GearError(ErrorCodes.RADIUS_OUT_OF_RANGE, `半径 ${r} 大于齿顶圆 ${p.ra}`);
  }
  const cal = calibration ?? calibrate(p);
  const rc = Math.max(r, p.rb);
  const t = tAtRadius(rc, p.rb);
  const left = flankPoint(p, t, 'left', cal.betaP);
  const right = flankPoint(p, t, 'right', cal.betaP);
  const toothThicknessAngle = left.theta - right.theta;
  const valid = toothThicknessAngle > 0;
  return {
    r: rc,
    t,
    left: { x: left.x, y: left.y, theta: left.theta },
    right: { x: right.x, y: right.y, theta: right.theta },
    toothThicknessAngle,
    arcThickness: rc * toothThicknessAngle,
    valid
  };
}

export interface GenerateOptions {
  pointsPerSide?: number;
}

export function generateProfile(p: GearParams, opts: GenerateOptions = {}): ProfileResult {
  const params = validateParams(p);
  const n = validatePointCount(opts.pointsPerSide ?? 64);
  const cal = calibrate(params);
  const grid = buildTGrid(params, n);
  const left = grid.map((t) => flankPoint(params, t, 'left', cal.betaP));
  const right = grid.map((t) => flankPoint(params, t, 'right', cal.betaP));
  const tip = sectionAtRadius(params, params.ra, cal);
  const validToTip = tip.valid;
  return { params, left, right, calibration: cal, tip, validToTip, convention: CONVENTION };
}

// 旋转到指定齿位（第 k 个齿逆时针旋转 2πk/z）
export function rotateToTooth<T extends { x: number; y: number; theta: number }>(
  points: T[],
  k: number,
  z: number
): (T & { toothIndex: number; rotationAngle: number })[] {
  validateToothIndex(k, z);
  const a = (2 * Math.PI * k) / z;
  return points.map((pt) => {
    const xy = rotateXY(pt.x, pt.y, a);
    return { ...pt, x: xy.x, y: xy.y, theta: pt.theta + a, toothIndex: k, rotationAngle: a };
  });
}
