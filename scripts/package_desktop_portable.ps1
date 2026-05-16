param(
    [string]$Configuration = "release"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TauriDir = Join-Path $RepoRoot "desktop-app\src-tauri"
$ReleaseDir = Join-Path $TauriDir "target\$Configuration"
$PortableFolderName = "lmo_audio"
$PortableAppExeName = "lmo_audio.exe"
$PortableDir = Join-Path $ReleaseDir "portable\$PortableFolderName"
$AppExe = Join-Path $ReleaseDir "smart-minutes-ai.exe"
$SidecarExe = Join-Path $TauriDir "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
$SidecarDepsDir = Join-Path $TauriDir "binaries\_internal"
$ResourceBackendDir = Join-Path $TauriDir "resources\backend"
$ModelSourceRoot = Join-Path $RepoRoot "models"
$ModelLayoutFile = Join-Path $PSScriptRoot "portable_model_layout.json"
$ModelLayout = Get-Content -LiteralPath $ModelLayoutFile -Raw | ConvertFrom-Json

function Get-PeSubsystem {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    $optionalHeaderOffset = $peOffset + 24
    return [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset + 68)
}

if (-not (Test-Path $AppExe)) {
    throw "App executable does not exist. Run `corepack pnpm run desktop:build` or `cargo build --release` first: $AppExe"
}
if (-not (Test-Path $SidecarExe)) {
    throw "Backend sidecar does not exist. Run scripts/package_backend_sidecar.ps1 first: $SidecarExe"
}
if (-not (Test-Path $SidecarDepsDir)) {
    throw "Backend sidecar dependencies do not exist. Run scripts/package_backend_sidecar.ps1 first: $SidecarDepsDir"
}
if (-not (Test-Path $ResourceBackendDir)) {
    throw "Prepared backend resources do not exist. Run scripts/prepare_tauri_resources.ps1 first: $ResourceBackendDir"
}
if ((Get-PeSubsystem $AppExe) -ne 2) {
    throw "App executable must be Windows GUI subsystem: $AppExe"
}
if ((Get-PeSubsystem $SidecarExe) -ne 2) {
    throw "Backend sidecar must be Windows GUI subsystem: $SidecarExe"
}

if (Test-Path $PortableDir) {
    Remove-Item -Recurse -Force $PortableDir
}

New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PortableDir "binaries") | Out-Null

Copy-Item -Force $AppExe (Join-Path $PortableDir $PortableAppExeName)
Copy-Item -Force $SidecarExe (Join-Path $PortableDir "binaries\meeting-backend-x86_64-pc-windows-msvc.exe")
Copy-Item -Recurse -Force $SidecarDepsDir (Join-Path $PortableDir "binaries\_internal")
Copy-Item -Recurse -Force $ResourceBackendDir (Join-Path $PortableDir "backend")

$PortableModelsDir = Join-Path $PortableDir "models"
New-Item -ItemType Directory -Force -Path $PortableModelsDir | Out-Null

$ModelReadme = @"
LMO Smart Meeting System model folder

Keep each model in its own folder under models.

Examples:
$(@($ModelLayout.models) | ForEach-Object { "- models\$($_.portableDir)" } | Out-String)

faster-whisper-large-v3 is the default speech recognition model.
Additional STT candidates are not used by this portable app.
"@
Set-Content -Path (Join-Path $PortableModelsDir "README.txt") -Value $ModelReadme -Encoding UTF8

function Test-RequiredMarkers {
    param(
        [string]$Root,
        [string[]]$Markers,
        [string]$Label
    )

    $missing = @()
    foreach ($marker in $Markers) {
        $path = Join-Path $Root $marker
        if (-not (Test-Path -LiteralPath $path)) {
            $missing += $marker
        }
    }
    if ($missing.Count -gt 0) {
        throw "$Label model is incomplete at $Root. Missing: $($missing -join ', ')"
    }
}

function Copy-ModelDirectory {
    param(
        [string]$Source,
        [string]$Destination,
        [string]$Label,
        [string[]]$RequiredMarkers
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        $modelName = Split-Path -Leaf $Source
        throw @"
$Label model was not found at $Source

Portable builds read model sources from the project-root models folder:
  models\$modelName

For a rebuild, put or link the model folder there before running release_portable.ps1.
The final app will copy it to:
  releases\lmo_audio\models\$modelName

Do not use the old root lmo_audio folder as the release target.
"@
    }

    Test-RequiredMarkers $Source $RequiredMarkers $Label

    robocopy $Source $Destination /E /XD .git .cache /XF *.lock /NFL /NDL /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while copying model with exit code $LASTEXITCODE`: $Source"
    }

    Test-RequiredMarkers $Destination $RequiredMarkers $Label
}

foreach ($model in @($ModelLayout.models)) {
    $source = Join-Path $ModelSourceRoot ([string]$model.source)
    $destination = Join-Path $PortableModelsDir ([string]$model.portableDir)
    Copy-ModelDirectory $source $destination ([string]$model.label) @($model.requiredMarkers)
}

$TopLevelReadme = @"
LMO Smart Meeting System - Portable Quick Start

1. Run
   - Run lmo_audio.exe in this folder.
   - Do not move only the exe file. Move the whole lmo_audio folder together.

2. What to use
   - Use this whole lmo_audio folder for company PC testing and delivery.
   - Ignore Tauri target files such as smart-minutes-ai.exe and installer setup exe files.
   - The NSIS installer is not the release target because it does not carry the model folders used by this portable package.

3. Model folders
   - Speech recognition model: models\faster-whisper-large-v3
   - Speaker diarization model: models\speaker-diarization-community-1
   - Do not rename model folders or files.

4. Folder guide
   - lmo_audio.exe: app executable
   - models: speech recognition and speaker diarization models
   - backend: local analysis server files
   - binaries: local analysis server executable and dependencies
   - release-manifest.json: release verification manifest

5. If something is wrong
   - Open app settings and check model status first.
   - After copying models again, refresh model status.
"@
[System.IO.File]::WriteAllText(
    (Join-Path $PortableDir "START_HERE.txt"),
    $TopLevelReadme,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Created portable desktop package:"
Write-Host $PortableDir
