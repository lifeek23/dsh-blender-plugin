# Codex MCP 基础版

本目录仅新增独立的 Codex stdio MCP 入口。原有 DSH 入口、依赖、工具、Blender addon 和配置保持不变。基于上游提交 `6c5614712972a5cbca52b13d4df9193d76e76b0d`。[English](README.md)。

## 安装

需要 Node.js 24.9+ 和已安装的 Blender。在仓库根目录运行：

```sh
npm ci --legacy-peer-deps
node scripts/build.mjs runtime
npm ci --prefix codex
codex mcp add codex-blender -- node /仓库绝对路径/codex/launch.mjs
```

这台 NAS 使用已有的 workbench Blender，由 `codex/bin/blender-nas` 限制最多两个计算线程。启动器会在此本地路径存在时使用它；其他机器通过 `DSH_BLENDER_EXE` 指定 Blender。

MCP 启动时不打开 Blender。首次工具调用才启动 Gateway，Codex 默认使用独立端口 39878，原有 DSH 默认端口 39877 不变。Blender 后台任务按需运行。MCP 退出时清理自己启动的 Gateway；已保存文件保留，未完成任务不保证继续执行，因此需要任务继续时不要断开连接。

## 基础使用流程

1. `blender_session(action="status")`：检查 Gateway。NAS 后台模式下没有 GUI 属于预期。
2. `blender_run(action="submit", kind="headless", script="...", outdir="/绝对输出目录")`：提交建模脚本。用 `bpy.ops.wm.save_as_mainfile(filepath=...)` 保存 `.blend`，用 Blender 导出算子输出 STL/GLB，明确保存所需产物。
3. `blender_run(action="wait", id="...")`：短时等待；仍在运行时继续使用同一个 ID 查询。等待超时不等于任务失败。`collect` 收集日志和产物；`cancel` 取消自己提交的任务。
4. `blender_inspect(blend_file="/绝对路径/model.blend")`：用短期后台任务读取已保存场景。
5. `blender_see(image_path="/绝对路径/preview.png")`：将真实 PNG 作为 MCP 图片回传。这是离线预览，不是实时视口截图。

每次后台任务都是新场景，内存状态不跨任务保留。下一次编辑要先显式打开已保存的 `.blend`。Blender 场景单位设置不保证 STL 导出尺寸，交付前仍需测量。

GUI 模式的 `blender_py`、实时截图和 attach/claim 接口，需要 Blender 图形会话及原项目 bundled addon 连接到 Codex Gateway。NAS 基础流程不会自动启动 GUI 或安装、替换 addon；没有 GUI 时会如实返回不可用。

## 配置

- `CODEX_BLENDER_GATEWAY_URL`：Codex Gateway 地址，保持本地使用。
- `DSH_BLENDER_EXE`：已有 Blender 程序或包装脚本。
- `CODEX_BLENDER_AUTOSTART=0`：连接外部管理的 Gateway，退出时不停止它。
- `DSH_BLENDER_WORKDIR`：Gateway 产物目录；启动器默认使用本地 Codex 状态目录。

原 DSH 建模技能和 228 个结构化操作仍由原宿主提供。此次基础 MCP 提供五个工具，不宣称已经向 Codex 开放所有原有算子。

## 验证与许可

```sh
npm test --prefix codex
node codex/test/smoke.mjs
```

本 NAS 已使用 Blender 4.5.9 LTS、Node 24.22.1 验证：13 项单元及生命周期检查通过，真实 MCP 测试验证了 20 × 30 × 10 mm STL 独立测量、PNG 图片回传、脚本异常、取消及断开连接后的运行进程清理。GUI 功能仅核对了上游接口，尚未实际验证。

真实测试产物位于 `codex/validation/`，需验证工具发现、实际 Blender 作业、文件保存、场景读取、图片回传和故意出错的脚本后才能报告安装成功。实际环境以验证记录为准。

原 DSH host/runtime 为 BSD-3-Clause；bundled Blender 扩展的 GPL-3.0-or-later 与上游 MIT 声明分别见仓库 `LICENSE`、`extension/LICENSE`、`extension/NOTICE`。新增 `codex/` 文件使用 BSD-3-Clause。适配器不需要 DeepSeek API key。AI 辅助开发与审查：OpenAI Codex。
