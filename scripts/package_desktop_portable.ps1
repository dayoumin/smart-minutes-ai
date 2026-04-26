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
$ResourceBackendDir = Join-Path $TauriDir "resources\backend"

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
Copy-Item -Recurse -Force $ResourceBackendDir (Join-Path $PortableDir "backend")

Write-Host "Created portable desktop package:"
Write-Host $PortableDir
