param(
    [string]$Python = "python",
    [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BackendDir = Join-Path $RepoRoot "backend"
$TauriBinDir = Join-Path $RepoRoot "desktop-app\src-tauri\binaries"
$OutputName = "meeting-backend-$TargetTriple.exe"
$OutputPath = Join-Path $TauriBinDir $OutputName

New-Item -ItemType Directory -Force -Path $TauriBinDir | Out-Null

Push-Location $BackendDir
try {
    & $Python -m PyInstaller `
        --clean `
        --onefile `
        --noconsole `
        --name "meeting-backend-$TargetTriple" `
        --collect-submodules "pyannote.audio" `
        --collect-data "pyannote.audio" `
        --distpath $TauriBinDir `
        --workpath (Join-Path $BackendDir "build") `
        --specpath (Join-Path $BackendDir "build") `
        "desktop_server.py"
}
finally {
    Pop-Location
}

if (-not (Test-Path $OutputPath)) {
    throw "Sidecar build failed: $OutputPath was not created."
}

Write-Host "Created sidecar: $OutputPath"
