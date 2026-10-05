# 渐开线齿廓采样与节圆齿厚核验后端

离线几何分析服务：直齿轮**单齿双侧渐开线工作齿廓**的采样、节圆齿厚核验、指定半径截面查询与齿位旋转。仅 API 与 CLI，TypeScript + Node.js + SQLite（`node:sqlite`，零外部运行时依赖），Windows 本地运行，不需要 Docker / WSL / CAD / 在线服务。

## 几何范围（重要）

- 只生成**一个齿**的左右工作齿廓（基圆 → 齿顶圆）及其绕轴线的旋转副本（齿位 0 基编号）。
- 基础曲线：`x = rb(cos t + t sin t)`，`y = rb(sin t - t cos t)`，半径 `r(t) = rb·√(1+t²)`，参数 `t ∈ [0, t_tip]`。
- 节圆校准：基础曲线极角为 `inv(α) = t − atan(t)`。将右侧曲线整体旋转 `−(inv(α_p) + π/(2z))`，使节圆右点落在 `−π/(2z)`；左侧为其关于齿中心线（+x 轴）的镜像。节圆角齿厚恰为 `π/z`，弧齿厚 `π·rp/z`。**不是**简单镜像未校准的基础曲线。
- **不建模**：齿根过渡圆角与 `r < rb` 区域（标记为未建模，不擅自填充）、载荷、啮合强度、刀具切削、制造公差。所得曲线**不可直接用于加工**。
- 齿顶处若两侧交叉（弧齿厚 ≤ 0），判定**超出本模型有效范围**，创建被拒绝（错误码 `TIP_THICKNESS_NON_POSITIVE`），不拼自交轮廓。
- 采样折线只是曲线的**离散表示**；指定半径的齿厚由解析截面直接计算，不取最近采样点，与采样密度无关。

## 约定

- 长度单位统一（默认 `mm`，同一参数集内一致）；角度内部与输出一律为**弧度**。
- 齿中心线为 +x 轴，左侧在正角方向，逆时针为正；齿位从 0 编号，范围 `[0, z-1]`。
- 输入校验：`ra > rp > rb > 0`、齿数为 ≥3 整数、所有数值有限、采样点数 ∈ [2, 10000]。

## 命令

```powershell
npm install        # 仅开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 运行全部测试（node --test，直接跑 TS）
npm start          # 启动 API（dist/server.js，默认自动选择空闲端口）
npm run demo       # 演示：齿厚表 + 校准 + 旋转关系 + 半径误差 + 导出 CSV/JSON
```

CLI（`node src/cli.ts <命令>` 或构建后 `node dist/cli.js`）：

```
serve [--port N]                 启动 API（缺省端口 0 = 系统自动分配空闲端口；也可用环境变量 PORT）
create --rb R --rp R --ra R --z N [--samples N]
list
points --id N [--tooth K]        左右点表（含 t、r、极角、弧齿厚、基圆/节圆/齿顶标记）
thickness --id N --r R           指定半径截面：两侧交点 + 弧齿厚（解析）
calibrate --id N                 节圆校准过程报告
compare --a ID --b ID            尺寸比较（含同比放大识别）
export --id N [--tooth K] [--format csv|json]
demo
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/profiles` | 创建参数版本并生成轮廓，body `{rb,rp,ra,z,samples?}` |
| GET | `/profiles` | 版本列表 |
| GET | `/profiles/:id` | 参数与约定 |
| GET | `/profiles/:id/points?tooth=K` | 左右采样点（可旋转到齿位 K） |
| GET | `/profiles/:id/thickness?r=R` | 指定半径截面（解析） |
| GET | `/profiles/:id/calibration` | 节圆校准过程 |
| GET | `/profiles/:id/compare?other=ID` | 尺寸比较 |
| GET | `/profiles/:id/export?format=csv\|json&tooth=K` | 导出坐标 |

错误响应：`{"error":{"code","message"}}`，HTTP 422（参数/范围）或 404。错误码：`NON_FINITE_VALUE`、`NON_POSITIVE_VALUE`、`INVALID_RADIUS_RELATION`、`NON_INTEGER_TEETH`、`TOO_FEW_TEETH`、`TOO_MANY_POINTS`、`TOO_FEW_POINTS`、`RADIUS_OUT_OF_RANGE`、`TOOTH_OUT_OF_RANGE`、`TIP_THICKNESS_NON_POSITIVE`、`NOT_FOUND`、`BAD_REQUEST`。

## 存储与版本

- SQLite 存于项目内 `data/gear.db`（可用环境变量 `GEAR_DB` 覆盖），保存原参数、角度/坐标约定、采样配置、算法版本、轮廓点与核验报告。
- 相同尺寸重复创建产生递增 `version`；修改尺寸即新参数键的版本 1。
- 发布前核对端点（基圆/齿顶）与节圆齿厚残差；任一步失败事务回滚，**不覆盖旧结果**；重启后可按原参数 id 重新查询任意半径截面。

## 测试覆盖

`npm test`（17 项）：基圆 t=0、节圆点精确插入且左右角差恰为 π/z、镜像与半径关系独立核验、相邻齿位旋转与整周回归、非法半径/非整数齿数/非有限值/过大点数、过大齿顶交叉拒绝、截面查询与采样密度无关、同比放大（坐标与弧齿厚同比、角度不变）、失败回滚、重启读取、HTTP 错误码与 CSV 导出。

## 已知限制

- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 仅单齿工作段；无齿根、无变位/修形、无三维。采样折线为离散表示，精密截面请用 `thickness` 解析接口。
