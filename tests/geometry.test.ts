import { test } from 'node:test';
import assert from 'node:assert';
import {
  generateProfile,
  sectionAtRadius,
  calibrate,
  rotateToTooth,
  tAtRadius,
  validateParams,
  GearParams
} from '../src/geometry.js';
import { GearError } from '../src/errors.js';

const P: GearParams = { rb: 90, rp: 100, ra: 110, z: 20 };

test('基圆处参数 t=0 且半径等于 rb', () => {
  const s = sectionAtRadius(P, P.rb);
  const c = calibrate(P);
  assert.ok(Math.abs(s.t) < 1e-12);
  assert.ok(Math.abs(s.r - P.rb) < 1e-9);
  // 两侧基圆点在 t=0 重合于基圆点，按齿厚对称分布在齿中心线两侧 ±βp
  assert.ok(Math.abs(s.left.theta - c.betaP) < 1e-12);
  assert.ok(Math.abs(s.right.theta + c.betaP) < 1e-12);
  assert.ok(Math.abs(Math.hypot(s.left.x, s.left.y) - P.rb) < 1e-9);
  assert.ok(Math.abs(Math.hypot(s.right.x, s.right.y) - P.rb) < 1e-9);
});

test('节圆处左右角差恰为 π/z，弧齿厚为 π rp/z', () => {
  const s = sectionAtRadius(P, P.rp);
  assert.ok(Math.abs(s.toothThicknessAngle - Math.PI / P.z) < 1e-12);
  assert.ok(Math.abs(s.arcThickness - (Math.PI * P.rp) / P.z) < 1e-9);
});

test('节圆点被精确插入采样集', () => {
  const prof = generateProfile(P, { pointsPerSide: 17 });
  assert.ok(prof.left.some((p) => Math.abs(p.r - P.rp) < 1e-9 * P.rp));
  assert.ok(prof.right.some((p) => Math.abs(p.r - P.rp) < 1e-9 * P.rp));
});

test('左右齿廓关于齿中心线镜像对称', () => {
  const prof = generateProfile(P, { pointsPerSide: 33 });
  assert.equal(prof.left.length, prof.right.length);
  for (let i = 0; i < prof.left.length; i++) {
    const l = prof.left[i];
    const r = prof.right[i];
    assert.ok(Math.abs(l.x - r.x) < 1e-8);
    assert.ok(Math.abs(l.y + r.y) < 1e-8);
    assert.ok(Math.abs(l.theta + r.theta) < 1e-10);
  }
});

test('采样点半径满足 r=rb sqrt(1+t^2)（独立半径关系核验）', () => {
  const prof = generateProfile(P, { pointsPerSide: 50 });
  for (const p of [...prof.left, ...prof.right]) {
    const expected = P.rb * Math.sqrt(1 + p.t * p.t);
    assert.ok(Math.abs(p.r - expected) < 1e-9 * P.ra);
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - p.r) < 1e-8 * P.ra);
  }
});

test('齿厚从基圆到齿顶单调减小且均为正', () => {
  const rs = [90, 95, 100, 105, 110];
  const th = rs.map((r) => sectionAtRadius(P, r).toothThicknessAngle);
  for (let i = 1; i < th.length; i++) assert.ok(th[i] < th[i - 1]);
  assert.ok(th.every((v) => v > 0));
});

test('不同采样密度下直接截面查询结果一致（不以最近点代替）', () => {
  const p1 = generateProfile(P, { pointsPerSide: 8 });
  const p2 = generateProfile(P, { pointsPerSide: 200 });
  for (const r of [92.345, 100, 107.7]) {
    const a = sectionAtRadius(p1.params, r, p1.calibration);
    const b = sectionAtRadius(p2.params, r, p2.calibration);
    assert.ok(Math.abs(a.toothThicknessAngle - b.toothThicknessAngle) < 1e-12);
    assert.ok(Math.abs(a.left.x - b.left.x) < 1e-8);
  }
});

test('旋转整周（k=z-1 再回到 k=0 语义）与齿位范围', () => {
  const prof = generateProfile(P, { pointsPerSide: 16 });
  const last = rotateToTooth(prof.left, P.z - 1, P.z);
  const first = prof.left;
  // 齿位 z-1 相对齿位 0 旋转 2π(z-1)/z
  const expected = (2 * Math.PI * (P.z - 1)) / P.z;
  assert.ok(Math.abs(last[5].theta - (first[5].theta + expected)) < 1e-10);
  assert.throws(() => rotateToTooth(prof.left, P.z, P.z), GearError);
  assert.throws(() => rotateToTooth(prof.left, -1, P.z), GearError);
});

test('旋转整周 2π 后坐标还原（k=z 等效 k=0 角度上）', () => {
  const prof = generateProfile(P, { pointsPerSide: 16 });
  const p0 = prof.left[7];
  const full = rotateToTooth(prof.left, 0, P.z)[7];
  assert.ok(Math.abs(full.x - p0.x) < 1e-10);
  assert.ok(Math.abs(full.y - p0.y) < 1e-10);
});

test('尺寸统一放大：坐标与弧齿厚同比放大，角度不变', () => {
  const k = 2.5;
  const big: GearParams = { rb: P.rb * k, rp: P.rp * k, ra: P.ra * k, z: P.z };
  for (const frac of [0, 0.5, 1]) {
    const r1 = P.rb + frac * (P.ra - P.rb);
    const r2 = big.rb + frac * (big.ra - big.rb);
    const a = sectionAtRadius(P, r1);
    const b = sectionAtRadius(big, r2);
    assert.ok(Math.abs(a.toothThicknessAngle - b.toothThicknessAngle) < 1e-12);
    assert.ok(Math.abs(b.arcThickness - k * a.arcThickness) < 1e-7);
    assert.ok(Math.abs(b.left.x - k * a.left.x) < 1e-7);
    assert.ok(Math.abs(b.left.y - k * a.left.y) < 1e-7);
  }
});

test('过大齿顶导致交叉时标记超出范围', () => {
  // z 很小、ra 极大时 inv(t_a) 超过半齿厚角，齿厚变负
  const bad: GearParams = { rb: 10, rp: 10.1, ra: 100000, z: 3 };
  const prof = generateProfile(bad, { pointsPerSide: 16 });
  assert.ok(!prof.validToTip);
  assert.ok(prof.tip.toothThicknessAngle <= 0);
  const s = sectionAtRadius(bad, bad.ra, prof.calibration);
  assert.ok(!s.valid);
});

test('非法半径关系、非整数齿数、非有限数值被拒绝', () => {
  assert.throws(() => validateParams({ rb: 100, rp: 100, ra: 110, z: 20 }), GearError);
  assert.throws(() => validateParams({ rb: 110, rp: 100, ra: 120, z: 20 }), GearError);
  assert.throws(() => validateParams({ rb: -1, rp: 100, ra: 110, z: 20 }), GearError);
  assert.throws(() => validateParams({ rb: 90, rp: 100, ra: 110, z: 20.5 }), GearError);
  assert.throws(
    () => validateParams({ rb: Number.NaN, rp: 100, ra: 110, z: 20 }),
    GearError
  );
  assert.throws(
    () => validateParams({ rb: 90, rp: 100, ra: Infinity, z: 20 }),
    GearError
  );
});

test('半径越界查询报错', () => {
  assert.throws(() => sectionAtRadius(P, P.rb - 1), GearError);
  assert.throws(() => sectionAtRadius(P, P.ra + 1), GearError);
});

test('过大点数被拒绝', () => {
  assert.throws(() => generateProfile(P, { pointsPerSide: 999999 }), GearError);
});

test('校准信息自洽', () => {
  const c = calibrate(P);
  assert.ok(Math.abs(c.angleDiffP - c.targetAngle) < 1e-12);
  assert.ok(Math.abs(c.invAlphaP - (Math.tan(c.alphaPRad) - c.alphaPRad)) < 1e-12);
  assert.ok(Math.abs(tAtRadius(P.rp, P.rb) - Math.tan(c.alphaPRad)) < 1e-10);
});
