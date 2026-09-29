# 地下机房断电 · 离线作业手册

纯前端（TypeScript + React + Vite）的**离线优先**作业手册，**无后端、无任何在线服务**。
维护员在有网时完整下载并校验某一手册版本后，断网仍可打开页面、查阅**正确的断电步骤**、
进行**离线故障演练**。

## 核心保证

- 应用内置**多个手册版本**（`1.0.0` / `2.0.0` / `3.0.0`）。每个版本的清单含：
  - 版本号、发布时间、标题；
  - 同源资源 URL 与各自的 **SHA-256**（`manifest.json` 含**有序步骤**，`faults.json` 含故障条目）；
  - 步骤数量。
- **两种安装入口**（同一原子状态机）：
  - **完整安装**：每项资源一律重新下载并校验；
  - **按内容摘要复用安装**：新清单中 **SHA-256 与当前有效版本完全一致**的资源，把旧版
    **已核验字节复制**到新版本专属暂存区（**只复制、不共享引用**；即便对应下载地址已变，
    按摘要也能命中）；变化的资源仍正常联网获取。完全无变化的版本可**全程断网**完成安装。
- **原子安装与切换**：一个版本的所有资源必须**全部就位、逐项 SHA-256 通过，并对暂存区与
  整份清单复核**（条目集合、摘要、manifest 内嵌版本与 faults 结构）后，才写入新的
  “当前代际”。在此之前页面始终展示此前的完整版本。
- **同一安装代次裁决**：每次安装生成唯一 `generation`，编码进暂存缓存名、版本元数据与
  进度界面；下载请求携带代次标记。旧代次的**迟到下载**即使在重载后才完成，提交前发现
  自己的 pending 已失效，只会清理自身暂存缓存，**绝不能激活过期候选**。
- **半包永不上线**：取消、断网、校验失败、存储配额异常（含写入前容量预检），或
  “安装中途关闭后重开”，都会**清理未激活的暂存缓存**，继续展示旧版；从未成功安装时
  显示**“无可用离线包”**。
- **旧版回收只在持久激活之后**：IDB 代际指针先落盘，随后才回收旧缓存；新版本缓存
  **自包含**，激活后不再引用旧版缓存，因此旧版清理不会造成离线缺件。
- **中断新版安装后离线刷新，仍打开旧版**；只有**完整安装/复用并激活**后，页面才只显示新版步骤。
- **离线演练**：搜索**当前版**故障条目 → **依序勾选**动作 → 得到**与版本绑定的通过结论**；
  切换版本会**终止未完成演练**。
- 离线读取由 **Service Worker + Cache Storage** 负责；
  **IndexedDB 只保存当前代际与安装状态**一条记录，不存手册正文。
- 浏览器缺少 Service Worker / Cache Storage / IndexedDB / Web Crypto 等能力时，页面显示
  **`UNSUPPORTED`**，不降级、不提供占位实现。

## 目录结构

```
public/manuals/v1|v2|v3/     内置版本的同源资源（有序步骤 + 故障条目；v3/faults.json 与 v2 逐字相同）
scripts/generate-catalog.mjs 扫描资源并计算 SHA-256，生成 src/manuals/catalog.json
src/core/                    纯逻辑（无 DOM 依赖）
  installer.ts               安装状态协调器（代次裁决、按摘要复用、下载→逐项+整单复核→原子提交；失败/中断清理）
  drill.ts                   演练：搜索、依序勾选、版本绑定结论、切版终止
  idb.ts                     IndexedDB 仅存“当前代际 + 安装状态（含代次/模式）”
src/service-worker/          SW：手册只从当前激活代际缓存读取，应用壳预缓存
src/platform/                浏览器端口（Cache/fetch/WebCrypto/配额估算）、能力检测、SW 注册
src/components/              React UI（完整安装 + 按摘要复用安装、分项进度、步骤、离线演练）
src/test/fault-injection.ts  仅用于端到端的 SW 故障注入（abort/tamper/hang/delay，无规则时完全透传）
plugins/sw-build.ts          构建期用 esbuild 编译 SW 并注入应用壳预缓存清单
e2e/                         Playwright：断网复用、单项变更、中断/离线重载、离线演练、首次失败、校验失败、UNSUPPORTED
```

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173（开发模式 SW 网络优先，支持 HMR）
```

## 构建与测试

```bash
npm run build      # 生成目录 + tsc 类型检查 + Vite 生产构建（含 SW 与预缓存清单）
npm run preview    # 本地静态预览（默认 http://localhost:4173）

npm run test       # Vitest：代次裁决/按摘要复用（断网复用、单项变更、损坏、配额、取消、重载、迟到下载、整单复核）
                    #          以及取消/断网/校验/配额/中断重开/同版重装/升级回收
npm run e2e        # Playwright：断网复用、单项变更、中断安装与离线重载、离线演练、首次失败、UNSUPPORTED
npm run verify     # 类型检查 + 单测 + 构建 + Playwright，一键全量验收
```

> 受限环境（无 root 安装浏览器系统库）运行 Playwright 时，可把本地库目录通过
> `PW_LD_LIBRARY_PATH`（等价 `LD_LIBRARY_PATH`）注入；配置会透传给浏览器进程。

> Service Worker 需要安全上下文：`https` 或 `localhost`。生产请用 `https` 或经 `localhost`
> 访问；非安全上下文会显示 `UNSUPPORTED`。

## Docker Compose

以 Nginx 纯静态托管，宿主端口可用 **`WEB_PORT`** 覆盖（默认 `8080`）：

```bash
docker compose up -d --build web          # http://localhost:8080
WEB_PORT=9000 docker compose up -d web    # http://localhost:9000
```

一次性**验收服务**（类型检查 → 单测 → 构建 → Playwright，跑完即退出，退出码即结论）：

```bash
docker compose up --build verify
```

`verify` 通过内网 `http://web` 访问已健康检查通过的 `web` 容器，不占用宿主端口。

## 清除缓存的方法

本应用的离线数据分三处，用途不同；排查问题或重置时按下表清理。

### 1. 浏览器 DevTools（推荐）

1. 打开页面 → F12 → **Application** 面板。
2. **Storage** → 点击 **Clear site data**（会同时清掉下面三类）。
3. 或分别清理：
   - **Service Workers** → 对本站点 **Unregister**；
   - **Cache Storage** → 删除 `shell:*`（应用壳）与所有 `manual:*`（手册代际/暂存）；
   - **IndexedDB** → 删除 `manual-kiosk-db`（仅含当前代际与安装状态）。
4. **硬刷新**：Windows/Linux `Ctrl+Shift+R`，macOS `Cmd+Shift+R`。

### 2. 命令行（无头 / 自动化环境）

在站点页面上下文执行：

```js
(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.unregister()));     // 注销 SW
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));  // 清空 Cache Storage
  indexedDB.deleteDatabase('manual-kiosk-db');           // 删除代际状态
  location.reload();
})();
```

### 3. Docker 场景

```bash
docker compose down -v        # 停止并移除卷；镜像侧无状态，重建即获得全新产物
docker compose up -d --build web
```

> 缓存命名约定：`shell:<sw-version>` 为应用壳；`manual:stage:<version>:<generation>`
> 为某次安装（唯一代次）的暂存缓存。**手册请求只会命中 IndexedDB 当前指针所指的那一个缓存**，
> 任何暂存/半包缓存对外都不可见，因此清缓存或异常中断都不会让半包顶替旧手册。
> 复用安装只是把旧激活缓存中**摘要一致的字节逐份复制**到新暂存缓存，不建立任何跨代引用。

## 安装状态机（速查）

```
idle ──install(full|reuse)──▶ installing（代次 generation；复用项先复制、变化项再下载）
                                   │
                                   ├─ 每项 SHA-256 + 暂存区/整份清单复核全部通过
                                   ▼
                              activated（新代际指针落盘 → 之后才回收旧缓存）
                       │
                       ├─ 取消 / abort ─────▶ failed(canceled) ─┐
                       ├─ 断网 / 非 2xx ───▶ failed(network)  ─┤ 清理本次暂存缓存
                       ├─ SHA-256/清单不符 ▶ failed(checksum) ─┤ 已激活版本不受影响
                       └─ 容量预检/写入异常 ▶ failed(quota)    ─┘
（安装中途进程被杀 → IDB 留下带代次的 pending → 下次启动 init() 清理半包并恢复旧版；
 旧代次迟到下载在提交前发现 pending 代次不符 → 只清理自己的暂存缓存，永不激活）
```
