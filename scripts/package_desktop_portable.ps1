param(
    [string]$Configuration = "release"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TauriDir = Join-Path $RepoRoot "desktop-app\src-tauri"
$ReleaseDir = Join-Path $TauriDir "target\$Configuration"
$PortableDir = Join-Path $ReleaseDir "portable\Smart Minutes AI"
$AppExe = Join-Path $ReleaseDir "smart-minutes-ai.exe"
$SidecarExe = Join-Path $TauriDir "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
$SidecarDepsDir = Join-Path $TauriDir "binaries\_internal"
$ResourceBackendDir = Join-Path $TauriDir "resources\backend"
$ModelSourceRoot = Join-Path $RepoRoot "backend\models"

if (-not (Test-Path $AppExe)) {
    throw "App executable does not exist. Run `corepack pnpm run desktop:build` or `cargo build --release` first: $AppExe"
}
if (-not (Test-Path $SidecarExe)) {
    throw "Backend sidecar does not exist. Run scripts/package_backend_sidecar.ps1 first: $SidecarExe"
}
if (-not (Test-Path $ResourceBackendDir)) {
    throw "Prepared backend resources do not exist. Run scripts/prepare_tauri_resources.ps1 first: $ResourceBackendDir"
}

if (Test-Path $PortableDir) {
    Remove-Item -Recurse -Force $PortableDir
}

New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PortableDir "binaries") | Out-Null

Copy-Item -Force $AppExe (Join-Path $PortableDir "Smart Minutes AI.exe")
Copy-Item -Force $SidecarExe (Join-Path $PortableDir "binaries\meeting-backend-x86_64-pc-windows-msvc.exe")
if (Test-Path $SidecarDepsDir) {
    Copy-Item -Recurse -Force $SidecarDepsDir (Join-Path $PortableDir "binaries\_internal")
}
Copy-Item -Recurse -Force $ResourceBackendDir (Join-Path $PortableDir "backend")

$PortableModelsDir = Join-Path $PortableDir "models"
New-Item -ItemType Directory -Force -Path $PortableModelsDir | Out-Null

$ModelReadme = @"
Smart Minutes AI model folder

Put the default Cohere speech model files directly in this folder.
Pyannote diarization files can also live directly here.

Examples:
- models\config.json
- models\model.safetensors
- models\preprocessor_config.json
- models\tokenizer_config.json
- models\config.yaml
- models\embedding\pytorch_model.bin
- models\segmentation\pytorch_model.bin
- models\plda\plda.npz

Optional alternate model folders:
- models\faster-whisper-large-v3
- models\qwen-asr

Older layouts are still recognized, but the simplest layout is to keep
the default model files directly under this models folder.
"@
Set-Content -Path (Join-Path $PortableModelsDir "README.txt") -Value $ModelReadme -Encoding UTF8

$PyannoteSource = Join-Path $ModelSourceRoot "diarization\speaker-diarization-community-1"
if (Test-Path $PyannoteSource) {
    robocopy $PyannoteSource $PortableModelsDir /E /XD .git .cache /XF *.lock | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while copying Pyannote model with exit code $LASTEXITCODE"
    }
}
else {
    Write-Warning "Pyannote model was not found at $PyannoteSource. Place it directly in the portable models folder before distribution if diarization is required."
}

Write-Host "Created portable desktop package:"
Write-Host $PortableDir
