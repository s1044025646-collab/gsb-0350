import test from "node:test";
import assert from "node:assert/strict";
import {
  GearError, assertValidTip, basePoint, calibrationReport, flanksAtRadius,
  invAlpha, rotatePoint, sampleFlanks, tAtRadius, tipArcThickness,
  validateParams, validateSampleCount,
} from "../src/geometry.ts";
import type { GearParams } from "../src/geometry.ts";

const P: GearParams = { rb: 50 * Math.cos(Math.PI / 9), rp: 50, ra: 55, z: 20 };

test("基圆处 t=0，点在 (rb,0)，半径恰为 rb", () => {
  const pt = basePoint(P.rb, 0);
  assert.equal(pt.x, P.rb);
  assert.equal(pt.y, 0);
  assert.equal(tAtRadius(P.rb, P.rb), 0);
  const pair = flanksAtRadius(P, P.rb);
  assert.ok(Math.abs(pair.left.r - P.rb) < 1e-12);
});

test("半径关系：r(t)=rb*sqrt(1+t^2)，采样点模长一致", () => {
  const rows = sampleFlanks(P, 50);
  for (const row of rows) {
    assert.ok(Math.abs(row.r - P.rb * Math.sqrt(1 + row.t ** 2)) < 1e-9);
    assert.ok(Math.abs(Math.hypot(row.left.x, row.left.y) - row.r) < 1e-9);
    assert.ok(Math.abs(Math.hypot(row.right.x, row.right.y) - row.r) < 1e-9);
  }
});

test("镜像检查：左侧为右侧关于齿中心线(+x)的镜像", () => {
  const pair = flanksAtRadius(P, 52);
  assert.ok(Math.abs(pair.left.x - pair.right.x) < 1e-12);
  assert.ok(Math.abs(pair.left.y + pair.right.y) < 1e-12);
  assert.ok(Math.abs(pair.left.theta + pair.right.theta) < 1e-12);
});

test("节圆点精确插入，左右角差恰为 pi/z", () => {
  const rows = sampleFlanks(P, 37);
  const pitch = rows.find((r) => r.atPitch);
  assert.ok(pitch, "采样中必须包含节圆点");
  assert.ok(Math.abs(pitch.r - P.rp) < 1e-9);
  const dTheta = pitch.left.theta - pitch.right.theta;
  assert.ok(Math.abs(dTheta - Math.PI / P.z) < 1e-12);
  const arcTarget = (Math.PI * P.rp) / P.z;
  assert.ok(Math.abs(pitch.arcThickness - arcTarget) < 1e-9);
});

test("校准报告：旋转角与节圆齿厚残差", () => {
  const cal = calibrationReport(P);
  const tP = tAtRadius(P.rb, P.rp);
  assert.ok(Math.abs(cal.rotationApplied + (invAlpha(tP) + Math.PI / (2 * P.z))) < 1e-15);
  assert.ok(Math.abs(cal.pitchResidual) < 1e-9);
  assert.ok(Math.abs(cal.pitchAngularThickness - Math.PI / P.z) < 1e-12);
});

test("相邻齿位旋转 2pi/z，连续旋转 z 次回到原点，齿位越界被拒绝", () => {
  const pt = flanksAtRadius(P, P.rp).left;
  const p1 = rotatePoint(pt, P, 1);
  assert.ok(Math.abs(p1.theta - pt.theta - (2 * Math.PI) / P.z) < 1e-12);
  let cur = pt;
  for (let k = 0; k < P.z; k++) cur = rotatePoint(cur, P, 1);
  assert.ok(Math.abs(cur.x - pt.x) < 1e-6);
  assert.ok(Math.abs(cur.y - pt.y) < 1e-6);
  assert.throws(() => rotatePoint(pt, P, P.z), GearError);
  assert.throws(() => rotatePoint(pt, P, -1), GearError);
  assert.throws(() => rotatePoint(pt, P, 1.5), GearError);
});

test("非法半径关系、非整数齿数、非有限数值被拒绝", () => {
  assert.throws(() => validateParams({ rb: 50, rp: 40, ra: 60, z: 20 }), GearError);
  assert.throws(() => validateParams({ rb: 40, rp: 50, ra: 50, z: 20 }), GearError);
  assert.throws(() => validateParams({ rb: 40, rp: 50, ra: 60, z: 20.5 }), /整数/);
  assert.throws(() => validateParams({ rb: NaN, rp: 50, ra: 60, z: 20 }), /有限/);
  assert.throws(() => validateParams({ rb: -1, rp: 50, ra: 60, z: 20 }), /正值/);
});

test("过大齿顶导致交叉：齿顶弧齿厚非正，判定超出有效范围", () => {
  const bad: GearParams = { ...P, ra: P.rb * 1.9 };
  validateParams(bad); // 半径关系本身合法
  assert.ok(tipArcThickness(bad) <= 0);
  assert.throws(() => assertValidTip(bad), /超出本模型有效范围/);
});

test("指定半径截面：解析解，越界半径被拒绝", () => {
  const a = flanksAtRadius(P, 52.5);
  assert.ok(Math.abs(a.arcThickness - 52.5 * (a.left.theta - a.right.theta)) < 1e-9);
  assert.throws(() => flanksAtRadius(P, P.rb - 1), /超出工作范围/);
  assert.throws(() => flanksAtRadius(P, P.ra + 1), /超出工作范围/);
  assert.throws(() => flanksAtRadius(P, NaN), GearError);
});

test("尺寸统一放大：坐标与弧齿厚同比放大，角度不变", () => {
  const k = 2.5;
  const Q: GearParams = { rb: P.rb * k, rp: P.rp * k, ra: P.ra * k, z: P.z };
  for (const f of [0.2, 0.5, 0.8, 1]) {
    const r = P.rb + (P.ra - P.rb) * f;
    const a = flanksAtRadius(P, r);
    const b = flanksAtRadius(Q, r * k);
    assert.ok(Math.abs(b.arcThickness - a.arcThickness * k) < 1e-8);
    assert.ok(Math.abs(b.left.theta - a.left.theta) < 1e-12);
    assert.ok(Math.abs(b.left.x - a.left.x * k) < 1e-8);
    assert.ok(Math.abs(b.left.y - a.left.y * k) < 1e-8);
  }
});

test("采样点数限制", () => {
  assert.throws(() => validateSampleCount(1), GearError);
  assert.throws(() => validateSampleCount(10001), /上限/);
  assert.throws(() => validateSampleCount(3.5), GearError);
});
