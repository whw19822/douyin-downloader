# 抖存批量工作台 · Douyin Batch Studio

参考开源 `douyin-downloader` 架构改造的 **Web 全栈免内测码批量下载工作台**（Node.js + Express + React + Vite + Tailwind CSS）。无需任何内测码、激活码或付费授权，打开即可直接使用全部批量下载与配置能力。

## 核心能力

- **全量批量解析（免内测码）**：支持一次粘贴多条链接或整段抖音 App 分享口令，自动识别并去重博主主页、单条视频、图文、合集、音乐原声、直播间、直播回放与短链，自动拦截加密放映厅长视频（`lvdetail`）并给出明确原因。
- **并发队列与增量去重**：自定义并发线程数（1–12）、多模式抓取（`post` / `mix` / `like` / `music` / `collect`）、画质偏好（`original` / `highest` / `1080p` / `720p` 等）、发布日期区间筛选与磁盘完整性增量跳过。
- **已存档案与缺失补下**：内置检索、类型过滤、磁盘状态切换测试与一键回填队列。
- **热点发现与 YAML 导出**：支持热搜榜拉取、文件/目录命名模板实时校验与预览、Cookie / 代理配置，以及一键导出与原 CLI 引擎兼容的 `config.yml` 和 `JSONL` 任务清单。

## 本地运行

```bash
npm install
npm run dev
```

服务默认监听 `http://0.0.0.0:3000`。

## 构建与测试

```bash
npm test
npm run lint
npm run build
```

## 打包成 macOS 桌面应用（Apple Silicon arm64 · .dmg / .zip）

在 Apple Silicon（M1/M2/M3/M4）Mac 上（需要 Node.js 20+）运行以下命令，打包产物会生成在 `release/` 目录中，并内置本地服务端，下载的媒体文件会直接保存到 `~/Downloads/DouyinBatchStudio`（也可在设置中调用访达自定义目录）：

```bash
# 安装依赖
npm install

# 1. 本地预览桌面端窗口
npm run electron:preview

# 2. 打包 Apple Silicon Mac 安装包（.dmg 与 .zip）
npm run dist:mac
```

也可以将代码推送到 GitHub 后，在 Actions 中手动触发 `Build macOS App` 工作流（使用 `macos-latest` Apple Silicon 节点），自动在云端构建并下载 `.dmg` / `.zip` 安装包。

