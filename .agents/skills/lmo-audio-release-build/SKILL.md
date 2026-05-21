---
name: lmo-audio-release-build
description: Build and verify this repository's Windows portable desktop release. Use in smart-minutes-ai when the user asks to build, package, release, make an executable, prepare a general-user build, verify a portable build, or check whether ordinary users can run the app.
---

# LMO Audio Release Build

Use this skill only inside `D:\Projects\smart-minutes-ai`. Stay Windows-native.

## Default Meaning

Treat an unqualified request such as "build", "release build", "portable build", or "make it runnable for normal users" as a user-ready portable desktop release.

Do not use `corepack pnpm --dir desktop-app build` for that request. It only creates Vite web assets and does not update the executable, sidecar, models, or `releases\lmo_audio`.

## Required Workflow

1. Read `AGENTS.md` and `docs\tauri-desktop-release-checklist.md`.
2. Run `git -c core.excludesFile= status --short --branch --untracked-files=all` and note whether the manifest will be dirty.
3. Build from the repository root:

```powershell
corepack pnpm build
```

4. If the root package script is unavailable, use the direct fallback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_user_release.ps1
```

5. Treat only `releases\lmo_audio` as the user-ready output. Treat `desktop-app\dist`, `desktop-app\src-tauri\target`, and `desktop-app\src-tauri\target\release\portable\lmo_audio` as intermediate outputs.
6. If verification did not already run, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify_portable.ps1 -PortableDir releases\lmo_audio
```

7. Inspect `releases\lmo_audio\release-manifest.json` and report:
   - `commit`
   - `dirty`
   - frontend asset names
   - whether the manifest commit matches `git rev-parse HEAD`

## Failure Handling

- If `backend\.venv-desktop\Scripts\python.exe` is missing or broken, stop and report the venv recovery command from the checklist.
- If model markers are missing, stop and report the missing model folder or marker files.
- If Windows process inspection fails with access denied, prefer the script fallback or `Get-Process` when executable path is enough. Rerun with escalation only when command-line inspection is required. Do not switch to WSL.
- Treat a dirty manifest as a local test build unless the user explicitly accepts it. For a normal user-ready release, commit the release-script/docs changes first, rebuild without `-AllowDirty`, and verify that `manifest clean` passes.
- Do not leave dev servers running for release builds.

## Final Response

State whether the release is ready for a normal user PC, give the path `releases\lmo_audio`, and mention residual risk such as a dirty manifest or a clean-room zip test that was not performed.
