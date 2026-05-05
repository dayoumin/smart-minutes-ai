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
$BuildDistDir = Join-Path $BackendDir "dist-sidecar"
$BuildOutputDir = Join-Path $BuildDistDir "meeting-backend-$TargetTriple"

function Get-PeSubsystem {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    $optionalHeaderOffset = $peOffset + 24
    return [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset + 68)
}

New-Item -ItemType Directory -Force -Path $TauriBinDir | Out-Null
if (Test-Path $BuildDistDir) {
    Remove-Item -LiteralPath $BuildDistDir -Recurse -Force
}
if (Test-Path (Join-Path $TauriBinDir "_internal")) {
    Remove-Item -LiteralPath (Join-Path $TauriBinDir "_internal") -Recurse -Force
}
if (Test-Path $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Force
}

Push-Location $BackendDir
try {
    & $Python -m PyInstaller `
        --clean `
        --onedir `
        --noconsole `
        --name "meeting-backend-$TargetTriple" `
        --contents-directory "_internal" `
        --collect-submodules "pyannote.audio" `
        --collect-data "pyannote.audio" `
        --distpath $BuildDistDir `
        --workpath (Join-Path $BackendDir "build") `
        --specpath (Join-Path $BackendDir "build") `
        "desktop_server.py"
}
finally {
    Pop-Location
}

if (-not (Test-Path $BuildOutputDir)) {
    throw "Sidecar build failed: $BuildOutputDir was not created."
}

Copy-Item -Force (Join-Path $BuildOutputDir $OutputName) $OutputPath
Copy-Item -Recurse -Force (Join-Path $BuildOutputDir "_internal") (Join-Path $TauriBinDir "_internal")

if (-not (Test-Path $OutputPath)) {
    throw "Sidecar build failed: $OutputPath was not created."
}
if (-not (Test-Path (Join-Path $TauriBinDir "_internal"))) {
    throw "Sidecar build failed: _internal dependencies were not copied."
}
if ((Get-PeSubsystem $OutputPath) -ne 2) {
    throw "Sidecar must be Windows GUI subsystem. Rebuild with PyInstaller --noconsole: $OutputPath"
}

Write-Host "Created sidecar: $OutputPath"
