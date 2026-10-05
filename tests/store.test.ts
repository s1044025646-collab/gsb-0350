import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GearStore } from '../src/db.js';
import { sectionAtRadius } from '../src/geometry.js';
import { GearError } from '../src/errors.js';

const dir = join(tmpdir(), `gear-test-${process.pid}`);
const dbPath = join(dir, 'gear.sqlite');
const P = { rb: 90, rp: 100, ra: 110, z: 20 };

test('创建版本后可重新打开并按原参数查询半径截面（重启读取）', () => {
  rmSync(dir, { recursive: true, force: true });
  let store = new GearStore(dbPath);
  const { id } = store.createVersion(P, 24);
  const beforeCount = store.listVersions().length;
  store.close();

  store = new GearStore(dbPath);
  const loaded = store.loadProfile(id);
  assert.ok(loaded.left.length >= 24); // 精确插入基圆/节圆/齿顶端点后可能多于均匀点数
  const s = sectionAtRadius(loaded.params, 103, loaded.calibration);
  assert.ok(s.valid);
  assert.ok(Math.abs(s.r - 103) < 1e-9);
  assert.equal(store.listVersions().length, beforeCount);
  store.close();
});

test('几何核验失败时回滚，不覆盖旧结果', () => {
  const store = new GearStore(dbPath);
  const before = store.listVersions().length;
  const bad = { rb: 10, rp: 10.1, ra: 100000, z: 3 };
  assert.throws(() => store.createVersion(bad, 16), GearError);
  assert.equal(store.listVersions().length, before);
  store.close();
});

test('修改尺寸产生新版本', () => {
  const store = new GearStore(dbPath);
  const before = store.listVersions().length;
  const { id } = store.createVersion({ rb: 45, rp: 50, ra: 55, z: 20 }, 16);
  assert.equal(store.listVersions().length, before + 1);
  const prof = store.loadProfile(id);
  assert.equal(prof.params.rp, 50);
  store.close();
});

test('核验报告包含节圆角差检查', () => {
  const store = new GearStore(dbPath);
  const { id } = store.createVersion({ rb: 30, rp: 33, ra: 35, z: 25 }, 16);
  const report = store.getReport(id) as { ok: boolean; checks: { pitchAngleDiff: { actual: number; expected: number } } };
  assert.ok(report.ok);
  assert.ok(
    Math.abs(report.checks.pitchAngleDiff.actual - report.checks.pitchAngleDiff.expected) < 1e-9
  );
  store.close();
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上临时目录偶发占用可忽略 */
  }
});
void before;
