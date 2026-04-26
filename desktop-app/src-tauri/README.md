# Desktop Packaging

This directory contains the Tauri v2 desktop shell.

## Runtime Shape

- Vite builds the React UI into `desktop-app/dist`.
- Tauri opens that UI in a desktop window.
- A FastAPI backend is expected to run as a sidecar binary named `meeting-backend`.
- Models are not tracked in Git. The release machine prepares a clean copy under `desktop-app/src-tauri/resources/backend` before packaging.

## Backend Sidecar

Tauri requires sidecar binaries to include the Rust target triple suffix. On this Windows development machine the suffix is:

```powershell
x86_64-pc-windows-msvc
```

The expected sidecar path before `tauri build` is:

```text
desktop-app/src-tauri/binaries/meeting-backend-x86_64-pc-windows-msvc.exe
```

The sidecar receives:

```text
MEETING_AI_BACKEND_DIR=<tauri resource dir>/backend
ANALYSIS_MODE=real
```

The backend uses `MEETING_AI_BACKEND_DIR` to find `config.json`, `models`, `outputs`, and temporary folders in the packaged app.

## Preparing Resources

Run this from the repository root before a release build:

```powershell
.\scripts\prepare_tauri_resources.ps1
```

This copies `backend/config.json`, `backend/templates`, and `backend/models` into `desktop-app/src-tauri/resources/backend`. It excludes Hugging Face `.git` and `.cache` folders so the packaged app contains only runtime model payloads.

## Model Policy

Do not commit model files to GitHub. For distributable desktop builds, place licensed model files under `backend/models` on the build machine, prepare Tauri resources, then package. If the models are bundled, end users do not need an HF token at runtime.

## Installer Size Note

The Cohere model includes a multi-GB `model.safetensors` file. Windows MSI and NSIS bundling can fail on that file size. For model-included distribution, use a portable folder package:

```powershell
.\scripts\package_backend_sidecar.ps1 -Python "C:\Path\To\python.exe"
.\scripts\prepare_tauri_resources.ps1
cd desktop-app
corepack pnpm run desktop:build:exe
cd ..
.\scripts\package_desktop_portable.ps1
```

`desktop:build:exe` uses `tauri build --no-bundle`, which avoids MSI/NSIS limits while still producing `src-tauri/target/release/smart-minutes-ai.exe`.
