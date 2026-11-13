# Codex MCP support — basic version

This directory adds a separate stdio MCP host to DSH × Blender. The original DSH entry, dependencies, tools, addon, and configuration remain unchanged. Based on upstream commit `6c5614712972a5cbca52b13d4df9193d76e76b0d`. [中文说明](README.zh-CN.md).

## Install

Use Node.js 24.9+ and an existing Blender installation. From the repository root:

```sh
npm ci --legacy-peer-deps
node scripts/build.mjs runtime
npm ci --prefix codex
codex mcp add codex-blender -- node /absolute/path/to/dsh-blender-codex/codex/launch.mjs
```

On this NAS, use `codex/bin/blender-nas` as `DSH_BLENDER_EXE`. It wraps the existing workbench Blender and limits compute threads to two. The launcher supplies this local default if present. Set `DSH_BLENDER_EXE` to your executable elsewhere.

MCP starts without starting Blender. The Gateway starts on the first tool call, using a separate Codex port (39878); the original DSH default (39877) is unchanged. Blender background jobs run only while needed. MCP shutdown stops the Gateway it owns. Files saved to disk survive shutdown; unfinished jobs do not. Do not close the connection while a job must continue running.

## Basic workflow

1. `blender_session(action="status")` checks the Gateway; no GUI is expected on a headless NAS.
2. `blender_run(action="submit", kind="headless", script="...", outdir="/absolute/output")` submits Python. Use `bpy.ops.wm.save_as_mainfile(filepath=...)` to save a `.blend` and Blender export operators for STL/GLB. Always save explicit artifacts.
3. `blender_run(action="wait", id="...")` waits for a bounded period. If still running, use the same ID again; a wait timeout does not mean job failure. `collect` retrieves logs/artifacts; `cancel` stops owned work.
4. `blender_inspect(blend_file="/absolute/model.blend")` reads a saved scene using a short background job.
5. `blender_see(image_path="/absolute/preview.png")` returns the actual PNG as an MCP image. This is an offline preview, not a live viewport screenshot.

Each headless job starts a fresh scene. Load the saved `.blend` explicitly before editing it in another job; in-memory state does not persist between jobs. Scene unit settings alone do not guarantee STL scale; verify exported dimensions.

The GUI `blender_py`, live `blender_see`, and session attach/claim interfaces require a running Blender GUI with the upstream bundled addon connected to the Codex Gateway. The basic NAS workflow does not start a GUI or install/replace addons. Missing GUI is reported as unavailable, not as a successful GUI installation.

## Configuration

- `CODEX_BLENDER_GATEWAY_URL`: Codex Gateway address. Keep the endpoint local.
- `DSH_BLENDER_EXE`: existing Blender executable or wrapper.
- `CODEX_BLENDER_AUTOSTART=0`: connect to an externally managed Gateway; never stop it on exit.
- `DSH_BLENDER_WORKDIR`: Gateway artifacts directory; the launcher uses local Codex state by default.

The original DSH modeling skill and 228-op tool surface remain in the upstream host. This basic MCP host exposes five tools; it does not claim to expose every upstream operation to Codex.

## Validation

```sh
npm test --prefix codex
node codex/test/smoke.mjs
```

Verified on this NAS with Blender 4.5.9 LTS and Node 24.22.1: 13 unit/lifecycle checks and the real MCP smoke test passed, including independently measured 20 × 30 × 10 mm STL, PNG image return, Python failure, cancellation, and cleanup of a running Blender process on disconnect. GUI features have only been checked against the upstream contract, not tested live.

The smoke test uses scratch output under `codex/validation/`. It must verify MCP discovery, a real Blender job, saved artifacts, scene inspection, image content, and a deliberately failing script before installation is reported as working. Read the recorded validation report for the tested environment.

## Attribution

The DSH host/runtime is BSD-3-Clause (repository `LICENSE`). The bundled Blender extension has separate GPL-3.0-or-later and upstream MIT notices (`extension/LICENSE`, `extension/NOTICE`). New files in `codex/` are BSD-3-Clause. This adaptation uses no DeepSeek API key. AI-assisted implementation and review: OpenAI Codex.
