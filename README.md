# 渐开线齿廓采样与节圆齿厚核验后端

Windows 本地可运行的**直齿轮单齿双侧渐开线**离线几何分析服务。只提供 **HTTP API 与 CLI**，无网页、无 CAD、无图形依赖。

- 语言/运行时：TypeScript + Node.js（要求 Node `>= 22.5`，使用内置 `node:sqlite`，**无需任何原生编译**）
- 存储：项目内 `data/gear.sqlite`（SQLite）
- 不依赖 Docker、WSL、付费服务或任何在线 API

## 几何范围与限制（务必先读）

本服务**只**做以下事情：

- 由圆的渐开线生成**一个齿**的左、右两条**工作齿廓**，并给出其旋转副本（第 `k` 个齿）。
- 以**齿中心线为对称轴**放置两侧曲线，校准到**节圆处角齿厚恰为 `π/z`**、对应弧齿厚 `π·rp/z`。
- 在给定有效半径处**直接解析求解**两侧交点与该圆上的弧齿厚（不是找最近采样点）。
- 核对端点（基圆/齿顶圆）、镜像对称与节圆齿厚。

本服务**明确不做**，输出也不宣称：

- 不设计齿根过渡圆角；**基圆以内齿根区域标记为“未建模”**，查询会报 `RADIUS_OUT_OF_RANGE`。
- 不计算载荷、接触/弯曲强度、刀具切削过程、真实制造公差。
- **不宣称所得曲线可直接用于加工**，也不声明符合任何齿轮标准齿形。
- 采样点连成的**折线只是连续渐开线曲线的离散表示，不是曲线本身**。
- 当齿顶附近两侧齿廓交叉或齿厚非正时，结果标记为**超出本模型有效范围**（`valid=false` / `validToTip=false`），不会把自交轮廓拼成“合法”齿形。

## 几何与约定

基础渐开线（参数 `t ≥ 0`）：

```
x = rb·(cos t + t sin t)
y = rb·(sin t − t cos t)
半径 r = rb·sqrt(1 + t²)
```

- 参数范围：基圆 `t=0` 到齿顶圆 `t_a = sqrt((ra/rb)² − 1)`；节圆参数 `t_p = sqrt((rp/rb)² − 1)`。
- 节圆压力角 `αp = atan(t_p)`，渐开角 `inv(αp) = tan αp − αp`。
- 右工作廓 = 基础渐开线顺时针旋转 `βp`；左工作廓 = 基础渐开线关于齿中心线镜像后逆时针旋转 `βp`。
- 校准角 `βp = π/(2z) + inv(αp)`，因此节圆上左右极角为 `±π/(2z)`，角差恰为 `π/z`。**不能只镜像基础曲线而漏掉这一节圆角度修正。**

统一约定（随结果一并返回）：

- 角度一律使用**弧度**，逆时针为正；坐标长度使用**同一长度单位**（输入单位即输出单位）。
- 极角零点为齿中心线（`+x` 轴）；左侧极角为正，右侧为负。
- 第 `k` 个齿（**从零编号**，范围 `0..z−1`）绕原点逆时针旋转 `2πk/z`。

## 输入校验与错误码

必须满足 `0 < rb < rp < ra`，齿数 `z` 为正整数；所有数值必须有限。
单侧采样点数默认 64、最小 2、上限 10000。齿位超出 `[0,z−1]` 会被拒绝。

| 错误码 | 含义 |
| --- | --- |
| `NON_FINITE_NUMBER` | 存在 `NaN` / `Infinity` 或非数值 |
| `NON_POSITIVE_VALUE` | 半径非正 |
| `INVALID_RADIUS_ORDER` | 不满足 `rb < rp < ra` |
| `INVALID_TEETH_COUNT` | 齿数非正或非整数 |
| `INVALID_POINT_COUNT` | 采样点数非法或超过上限 |
| `INVALID_TOOTH_INDEX` | 齿位编号越界 |
| `RADIUS_OUT_OF_RANGE` | 查询半径超出 `[rb, ra]`（基圆以内未建模） |
| `CROSSED_OUT_OF_RANGE` | 齿顶交叉/齿厚非正，超出模型有效范围 |
| `RESOURCE_NOT_FOUND` | 版本或资源不存在 |
| `PERSISTENCE` | 数据库错误（已回滚） |
| `BAD_REQUEST` | 其它错误请求（如非法 JSON） |

## 构建、测试、启动、演示

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 运行 node:test 全部用例
npm start          # 启动 API（默认选择系统空闲端口，启动时打印 JSON）
npm run demo       # CLI 完整演示：点表、齿厚表、半径误差报告、旋转、导出
```

可选：

```powershell
$env:PORT="8080"   # 指定端口；被占用时自动回退到空闲端口
$env:GEAR_DATA_DIR="E:\some\dir"   # 自定义数据目录（默认 ./data）
npm start
```

## CLI

```powershell
npm run cli -- demo
npm run cli -- create 90 100 110 20 32          # rb rp ra z [单侧点数]
npm run cli -- list
npm run cli -- section 1 105                    # 直接解析求半径截面
npm run cli -- tooth 1 3                        # 旋转到第 3 个齿
npm run cli -- calibration 1                    # 查看节圆校准过程
npm run cli -- report 1                         # 查看核验报告
npm run cli -- export 1 csv data\prof.csv       # 或 json
npm run cli -- compare 90 100 110 20  45 50 55 20
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/versions` | 创建参数版本并生成、核验、持久化（修改尺寸即新版本） |
| `GET` | `/versions` | 列出全部版本 |
| `GET` | `/versions/:id` | 版本与完整轮廓 |
| `GET` | `/versions/:id/section?r=105` | 任意半径截面（直接解析求解） |
| `GET` | `/versions/:id/tooth/:k` | 旋转到第 `k` 个齿 |
| `GET` | `/versions/:id/calibration` | 节圆校准过程 |
| `GET` | `/versions/:id/report` | 发布前核验报告 |
| `GET` | `/versions/:id/export?format=json\|csv` | 导出坐标 |
| `POST` | `/compare` | 比较两组尺寸 |

创建版本请求体示例：

```json
{ "rb": 90, "rp": 100, "ra": 110, "z": 20, "pointsPerSide": 32 }
```

```powershell
$body = @{ rb=90; rp=100; ra=110; z=20; pointsPerSide=32 } | ConvertTo-Json
Invoke-RestMethod -Method Post "http://127.0.0.1:<port>/versions" -Body $body -ContentType "application/json"
```

## 持久化与发布语义

SQLite 保存：原始参数、角度与坐标约定、采样配置、算法版本（`inv-1.0.0`）、两侧轮廓点、节圆校准与核验报告。

- **发布前核对**端点半径、镜像对称与节圆角差（须恰为 `π/z`），并检查齿顶是否交叉；任一失败则**整笔事务回滚，不覆盖旧结果**。
- 重启后可用原参数按版本重新查询任意半径截面（截面由参数实时解析计算，采样密度不影响截面结果）。

## 几何不变量（测试覆盖）

- 基圆处 `t=0`；节圆点被精确插入采样集；末端在齿顶圆。
- 节圆左右角差恰为 `π/z`，弧齿厚 `π·rp/z`。
- 采样点满足 `r = rb·sqrt(1+t²)`，左右关于齿中心线镜像。
- 尺寸统一放大 `k` 倍：坐标与弧齿厚同比放大、角度不变。
- 不同采样密度下截面查询一致；齿位 `0→1` 极角增量恰为 `2π/z`。
- 非法半径关系、非整数齿数、非有限数值、过大点数、齿顶交叉、越界齿位均被拒绝或标记。
