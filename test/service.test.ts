import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.ts";
import {
  compareProfiles, createProfile, getCalibration, listProfiles,
  profilePoints, thicknessAt, toCsv,
} from "../src/service.ts";
import { createServer } from "../src/server.ts";

const P = { rb: 50 * Math.cos(Math.PI / 9), rp: 50, ra: 55, z: 20 };

function freshDb() {
  const f = path.join(tmpdir(), `gear_test_${process.pid}_${Math.random().toString(36).slice(2)}.db`);
  return { db: openDb(f), file: f };
}

test("创建版本、查询截面、校准报告、CSV 导出", () => {
  const { db } = freshDb();
  const rec = createProfile(db, P, 60);
  assert.equal(rec.version, 1);
  const t = thicknessAt(db, rec.id, P.rp);
  assert.ok(Math.abs(t.arcThickness - (Math.PI * P.rp) / P.z) < 1e-9);
  const cal = getCalibration(db, rec.id);
  assert.ok(Math.abs(cal.pitchAngularThickness - Math.PI / P.z) < 1e-12);
  const pts = profilePoints(db, rec.id, 2);
  assert.ok(pts.rows.some((r) => r.flags.pitch));
  const csv = toCsv(pts);
  assert.ok(csv.startsWith("side,tooth,"));
  db.close();
});

test("相同尺寸产生新版本；失败创建回滚不覆盖旧结果", () => {
  const { db } = freshDb();
  const a = createProfile(db, P, 50);
  const b = createProfile(db, P, 80);
  assert.equal(b.version, 2);
  const before = listProfiles(db).length;
  // 齿顶过大导致交叉 -> 创建失败
  assert.throws(() => createProfile(db, { ...P, ra: P.rb * 1.9 }), /超出本模型有效范围/);
  // 非法参数 -> 失败
  assert.throws(() => createProfile(db, { rb: 1, rp: 0.5, ra: 2, z: 20 }), /ra > rp > rb/);
  assert.throws(() => createProfile(db, P, 99999), /上限/);
  const after = listProfiles(db);
  assert.equal(after.length, before);
  assert.equal(after[after.length - 1].id, b.id);
  // 旧结果仍可按原参数查询
  const t = thicknessAt(db, a.id, 52);
  assert.ok(t.arcThickness > 0);
  db.close();
});

test("不同采样密度下直接截面查询一致", () => {
  const { db } = freshDb();
  const coarse = createProfile(db, P, 10);
  const fine = createProfile(db, P, 500);
  const t1 = thicknessAt(db, coarse.id, 52.3);
  const t2 = thicknessAt(db, fine.id, 52.3);
  assert.equal(t1.arcThickness, t2.arcThickness);
  assert.deepEqual(t1.left, t2.left);
  db.close();
});

test("重启后可按原参数重新查询半径截面", () => {
  const { db, file } = freshDb();
  const rec = createProfile(db, P, 100);
  const before = thicknessAt(db, rec.id, 53);
  db.close();
  const db2 = openDb(file);
  const after = thicknessAt(db2, rec.id, 53);
  assert.deepEqual(after, before);
  db2.close();
  rmSync(file, { force: true });
});

test("尺寸比较：统一放大识别", () => {
  const { db } = freshDb();
  const a = createProfile(db, P, 50);
  const b = createProfile(db, { rb: P.rb * 2, rp: P.rp * 2, ra: P.ra * 2, z: P.z }, 50);
  const cmp = compareProfiles(db, a.id, b.id);
  assert.equal(cmp.uniformlyScaled, true);
  assert.ok(Math.abs(cmp.pitchArcThicknessRatio - 2) < 1e-12);
  db.close();
});

test("HTTP API：创建/查询/错误码/CSV 导出", async () => {
  const f = path.join(tmpdir(), `gear_api_${process.pid}_${Math.random().toString(36).slice(2)}.db`);
  const { server, db } = createServer(f);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const created = await fetch(`${base}/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...P, samples: 40 }),
  });
  assert.equal(created.status, 201);
  const rec = (await created.json()) as any;

  const th = await fetch(`${base}/profiles/${rec.id}/thickness?r=52`);
  assert.equal(th.status, 200);
  const thJson = (await th.json()) as any;
  assert.ok(thJson.arcThickness > 0);

  const bad = await fetch(`${base}/profiles/${rec.id}/thickness?r=10`);
  assert.equal(bad.status, 422);
  assert.equal(((await bad.json()) as any).error.code, "RADIUS_OUT_OF_RANGE");

  const badCreate = await fetch(`${base}/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rb: 50, rp: 40, ra: 60, z: 20 }),
  });
  assert.equal(badCreate.status, 422);
  assert.equal(((await badCreate.json()) as any).error.code, "INVALID_RADIUS_RELATION");

  const badTooth = await fetch(`${base}/profiles/${rec.id}/points?tooth=20`);
  assert.equal(badTooth.status, 422);
  assert.equal(((await badTooth.json()) as any).error.code, "TOOTH_OUT_OF_RANGE");

  const csv = await fetch(`${base}/profiles/${rec.id}/export?format=csv&tooth=1`);
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /side,tooth/);

  const notFound = await fetch(`${base}/profiles/999`);
  assert.equal(notFound.status, 404);

  server.close();
  db.close();
  rmSync(f, { force: true });
});
