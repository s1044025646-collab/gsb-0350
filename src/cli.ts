import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { GearStore } from './db.js';
import { GearError } from './errors.js';
import {
  generateProfile,
  sectionAtRadius,
  rotateToTooth,
  GearParams
} from './geometry.js';

const DATA_DIR = process.env.GEAR_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'gear.sqlite');

function fmt(v: number, d = 6): string {
  return Number(v.toFixed(d)).toString();
}

function printPointTable(title: string, pts: Array<{ t: number; r: number; x: number; y: number; theta: number }>) {
  console.log(`\n${title}`);
  console.log('  t        r         x          y         theta(rad)');
  for (const p of pts) {
    console.log(
      `  ${fmt(p.t).padEnd(8)} ${fmt(p.r).padEnd(9)} ${fmt(p.x).padEnd(10)} ${fmt(p.y).padEnd(10)} ${fmt(p.theta)}`
    );
  }
}

function printThicknessTable(p: GearParams, radii: number[]) {
  console.log('\n半径截面齿厚表');
  console.log('  r         t         角齿厚(rad)   弧齿厚        状态');
  for (const r of radii) {
    const s = sectionAtRadius(p, r);
    console.log(
      `  ${fmt(r).padEnd(9)} ${fmt(s.t).padEnd(9)} ${fmt(s.toothThicknessAngle).padEnd(13)} ${fmt(s.arcThickness).padEnd(11)} ${s.valid ? '有效' : '超出模型范围(交叉)'}`
    );
  }
}

function radiusErrorReport(p: GearParams) {
  // 独立核验：采样点半径与 rb*sqrt(1+t²) 的关系
  const profile = generateProfile(p, { pointsPerSide: 32 });
  let maxErr = 0;
  for (const pt of [...profile.left, ...profile.right]) {
    const expected = p.rb * Math.sqrt(1 + pt.t * pt.t);
    maxErr = Math.max(maxErr, Math.abs(pt.r - expected));
  }
  console.log('\n半径关系核验报告');
  console.log(`  最大 |r - rb*sqrt(1+t^2)| = ${maxErr.toExponential(3)}`);
  console.log(`  节圆左右角差 = ${fmt(profile.calibration.angleDiffP, 12)}，目标 π/z = ${fmt(profile.calibration.targetAngle, 12)}`);
  console.log(`  节圆弧齿厚 = ${fmt(profile.calibration.arcThicknessP)}`);
}

function demo() {
  // 普通正参数：rb=90, rp=100, ra=110, z=20
  const params: GearParams = { rb: 90, rp: 100, ra: 110, z: 20 };
  console.log('=== 渐开线单齿双侧轮廓演示 ===');
  console.log('参数:', params, '（角度单位：弧度；长度单位统一）');

  const store = new GearStore(DB_PATH);
  const { id, profile } = store.createVersion(params, 32);
  console.log(`已创建参数版本 id=${id}`);

  printPointTable('左侧工作齿廓（前 8 点）', profile.left.slice(0, 8));
  printPointTable('右侧工作齿廓（前 8 点）', profile.right.slice(0, 8));

  printThicknessTable(params, [90, 95, 100, 105, 110]);
  radiusErrorReport(params);

  // 相邻齿位旋转关系
  const t0l = rotateToTooth(profile.left, 0, params.z)[10];
  const t1l = rotateToTooth(profile.left, 1, params.z)[10];
  const delta = ((t1l.theta - t0l.theta + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const normalized = ((delta + 2 * Math.PI) % (2 * Math.PI)) + (delta < -Math.PI ? 2 * Math.PI : 0);
  console.log('\n相邻齿位旋转关系');
  console.log(`  同一采样点从齿位 0 -> 1 的极角增量 ≈ ${fmt(normalized, 10)}（应 ≈ 2π/z = ${fmt((2 * Math.PI) / params.z, 10)}）`);

  // 导出示例
  const out = join(DATA_DIR, 'demo-profile.json');
  writeFileSync(out, JSON.stringify({ id, profile }, null, 2), 'utf8');
  console.log(`\n已导出 JSON: ${out}`);
  const csv = [
    'side,t,r,x,y,theta',
    ...profile.left.map((q) => ['left', q.t, q.r, q.x, q.y, q.theta].join(',')),
    ...profile.right.map((q) => ['right', q.t, q.r, q.x, q.y, q.theta].join(','))
  ].join('\n');
  const csvPath = join(DATA_DIR, 'demo-profile.csv');
  writeFileSync(csvPath, csv, 'utf8');
  console.log(`已导出 CSV: ${csvPath}`);
  store.close();
}

function usage() {
  console.log(`用法:
  npm run cli -- demo                          运行完整演示
  npm run cli -- create <rb> <rp> <ra> <z> [n] 创建参数版本并生成轮廓
  npm run cli -- list                          列出所有参数版本
  npm run cli -- section <id> <r>              查询指定半径截面（直接解析求解）
  npm run cli -- tooth <id> <k>                旋转到第 k 个齿（从零编号）
  npm run cli -- calibration <id>              查看节圆校准过程
  npm run cli -- report <id>                   查看核验报告
  npm run cli -- export <id> <json|csv> <file> 导出坐标
  npm run cli -- compare <rb1> <rp1> <ra1> <z1> <rb2> <rp2> <ra2> <z2>  比较尺寸`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'demo':
        return demo();
      case 'create': {
        const [rb, rp, ra, z, n] = rest.map(Number);
        const store = new GearStore(DB_PATH);
        const { id } = store.createVersion({ rb, rp, ra, z }, n ?? 64);
        console.log(JSON.stringify({ id }));
        store.close();
        return;
      }
      case 'list': {
        const store = new GearStore(DB_PATH);
        console.table(store.listVersions());
        store.close();
        return;
      }
      case 'section': {
        const [id, r] = [Number(rest[0]), Number(rest[1])];
        const store = new GearStore(DB_PATH);
        const profile = store.loadProfile(id);
        console.log(JSON.stringify(sectionAtRadius(profile.params, r, profile.calibration), null, 2));
        store.close();
        return;
      }
      case 'tooth': {
        const [id, k] = [Number(rest[0]), Number(rest[1])];
        const store = new GearStore(DB_PATH);
        const profile = store.loadProfile(id);
        console.log(
          JSON.stringify(
            {
              left: rotateToTooth(profile.left, k, profile.params.z),
              right: rotateToTooth(profile.right, k, profile.params.z)
            },
            null,
            2
          )
        );
        store.close();
        return;
      }
      case 'calibration': {
        const store = new GearStore(DB_PATH);
        console.log(JSON.stringify(store.loadProfile(Number(rest[0])).calibration, null, 2));
        store.close();
        return;
      }
      case 'report': {
        const store = new GearStore(DB_PATH);
        console.log(JSON.stringify(store.getReport(Number(rest[0])), null, 2));
        store.close();
        return;
      }
      case 'export': {
        const [id, format, file] = [Number(rest[0]), rest[1], rest[2]];
        const store = new GearStore(DB_PATH);
        const profile = store.loadProfile(id);
        if (format === 'csv') {
          const csv = [
            'side,t,r,x,y,theta',
            ...profile.left.map((q) => ['left', q.t, q.r, q.x, q.y, q.theta].join(',')),
            ...profile.right.map((q) => ['right', q.t, q.r, q.x, q.y, q.theta].join(','))
          ].join('\n');
          writeFileSync(file, csv, 'utf8');
        } else {
          writeFileSync(file, JSON.stringify(profile, null, 2), 'utf8');
        }
        console.log(`已导出到 ${file}`);
        store.close();
        return;
      }
      case 'compare': {
        const nums = rest.map(Number);
        const a = nums.slice(0, 4);
        const b = nums.slice(4, 8);
        if (a.length < 4 || b.length < 4) throw new GearError('BAD_REQUEST', 'compare 需要 8 个数值参数');
        const pairs: Array<[string, number, number]> = [
          ['rb', a[0], b[0]],
          ['rp', a[1], b[1]],
          ['ra', a[2], b[2]],
          ['z', a[3], b[3]]
        ];
        for (const [name, av, bv] of pairs) {
          console.log(`${name}: ${av} -> ${bv}，Δ=${bv - av}`);
        }
        return;
      }
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof GearError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
    } else {
      console.error('错误:', (err as Error).message);
    }
    process.exitCode = 1;
  }
}

main();
