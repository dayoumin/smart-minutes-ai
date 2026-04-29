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

Put speech and diarization model folders directly here.

Examples:
- models\cohere-transcribe-03-2026
- models\faster-whisper-large-v3
- models\qwen-asr
- models\speaker-diarization-community-1

Do not add an extra nested models folder inside a model folder.
"@
Set-Content -Path (Join-Path $PortableModelsDir "README.txt") -Value $ModelReadme -Encoding UTF8

$PyannoteSource = Join-Path $ModelSourceRoot "diarization\speaker-diarization-community-1"
if (Test-Path $PyannoteSource) {
    $PyannoteTarget = Join-Path $PortableModelsDir "speaker-diarization-community-1"
    if (Test-Path $PyannoteTarget) {
        Remove-Item -LiteralPath $PyannoteTarget -Recurse -Force
    }
    robocopy $PyannoteSource $PyannoteTarget /E /XD .git .cache /XF *.lock | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while copying Pyannote model with exit code $LASTEXITCODE"
    }
}
else {
    Write-Warning "Pyannote model was not found at $PyannoteSource. Place it in models\speaker-diarization-community-1 before distribution if diarization is required."
}

Write-Host "Created portable desktop package:"
Write-Host $PortableDir
