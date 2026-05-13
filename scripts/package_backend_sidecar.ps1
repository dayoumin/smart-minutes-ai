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

function Resolve-PythonCommand([string]$PythonCommand) {
    if ($PythonCommand -match '[\\/]') {
        $resolvedPython = if ([System.IO.Path]::IsPathRooted($PythonCommand)) {
            [System.IO.Path]::GetFullPath($PythonCommand)
        }
        else {
            [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $PythonCommand))
        }
        if (-not (Test-Path -LiteralPath $resolvedPython)) {
            throw "Python runtime not found: $resolvedPython"
        }
        return $resolvedPython
    }

    return $PythonCommand
}

function Get-VenvBasePython([string]$PythonCommand) {
    if (-not ($PythonCommand -like "*\Scripts\python.exe")) {
        return $null
    }

    $venvDir = Split-Path -Parent (Split-Path -Parent $PythonCommand)
    $cfgPath = Join-Path $venvDir "pyvenv.cfg"
    if (-not (Test-Path -LiteralPath $cfgPath)) {
        return $null
    }

    foreach ($line in Get-Content -LiteralPath $cfgPath) {
        if ($line -match '^\s*executable\s*=\s*(.+?)\s*$') {
            return $matches[1].Trim()
        }
        if ($line -match '^\s*home\s*=\s*(.+?)\s*$') {
            return (Join-Path $matches[1].Trim() "python.exe")
        }
    }

    return $null
}

function Assert-PythonRuntime([string]$PythonCommand) {
    $basePython = Get-VenvBasePython $PythonCommand
    if ($basePython -and -not (Test-Path -LiteralPath $basePython)) {
        throw "Python venv is broken because its base runtime is missing: $basePython`nRecreate the build env first: scripts\ensure_backend_build_env.ps1 -Python <python.exe> -RecreateBroken"
    }

    $probeOutput = $null
    try {
        $probeOutput = & $PythonCommand -c "import sys; print(sys.executable)"
    }
    catch {
        throw "Python runtime is not usable: $PythonCommand. $($_.Exception.Message)`nIf this is a repo venv, recreate it first: scripts\ensure_backend_build_env.ps1 -Python <python.exe> -RecreateBroken"
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Python runtime probe failed: $PythonCommand"
    }

    Write-Host "Using Python runtime: $probeOutput"
}

function Assert-PythonBuildRequirements([string]$PythonCommand) {
    $probeScript = @"
import importlib.util
import sys

required = ["PyInstaller", "fastapi", "faster_whisper", "torch"]
missing = [name for name in required if importlib.util.find_spec(name) is None]
if missing:
    print("Missing backend build requirements: " + ", ".join(missing))
    sys.exit(42)
print("Backend build requirements OK")
"@

    $probeOutput = $probeScript | & $PythonCommand -
    if ($LASTEXITCODE -ne 0) {
        throw "$probeOutput`nBackend build Python is incomplete. Run scripts\ensure_backend_build_env.ps1 -Python <python.exe> -RecreateBroken and let requirements installation finish."
    }

    Write-Host $probeOutput
}

function Get-PeSubsystem {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    $optionalHeaderOffset = $peOffset + 24
    return [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset + 68)
}

$PythonCommand = Resolve-PythonCommand $Python
Assert-PythonRuntime $PythonCommand
Assert-PythonBuildRequirements $PythonCommand

New-Item -ItemType Directory -Force -Path $TauriBinDir | Out-Null
if (Test-Path $BuildDistDir) {
    Remove-Item -LiteralPath $BuildDistDir -Recurse -Force
}
if (Test-Path (Join-Path $TauriBinDir "_internal")) {
    $internalDir = Resolve-Path -LiteralPath (Join-Path $TauriBinDir "_internal")
    $tauriBinFullPath = (Resolve-Path -LiteralPath $TauriBinDir).Path
    if (-not $internalDir.Path.StartsWith($tauriBinFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove unsafe sidecar dependency path: $($internalDir.Path)"
    }
    Remove-Item -LiteralPath $internalDir.Path -Recurse -Force
    if (Test-Path -LiteralPath $internalDir.Path) {
        throw "Failed to remove stale sidecar dependency directory: $($internalDir.Path)"
    }
}
if (Test-Path $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Force
}

Push-Location $BackendDir
try {
    & $PythonCommand -m PyInstaller `
        --clean `
        --onedir `
        --noconsole `
        --name "meeting-backend-$TargetTriple" `
        --contents-directory "_internal" `
        --collect-submodules "pyannote.audio" `
        --collect-data "pyannote.audio" `
        --collect-submodules "faster_whisper" `
        --collect-data "faster_whisper" `
        --collect-submodules "av" `
        --collect-binaries "av" `
        --collect-data "av" `
        --collect-submodules "ctranslate2" `
        --collect-binaries "ctranslate2" `
        --collect-data "ctranslate2" `
        --collect-submodules "tokenizers" `
        --collect-binaries "tokenizers" `
        --collect-data "tokenizers" `
        --collect-submodules "lxml" `
        --collect-binaries "lxml" `
        --collect-data "lxml" `
        --hidden-import "unicodedata" `
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
$lxmlEtree = Get-ChildItem -LiteralPath (Join-Path $TauriBinDir "_internal\lxml") -Filter "etree*.pyd" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $lxmlEtree) {
    throw "Sidecar build failed: lxml.etree was not bundled into _internal\lxml."
}
$unicodeData = Get-ChildItem -LiteralPath (Join-Path $TauriBinDir "_internal") -Filter "unicodedata*.pyd" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $unicodeData) {
    throw "Sidecar build failed: unicodedata was not bundled into _internal."
}
if ((Get-PeSubsystem $OutputPath) -ne 2) {
    throw "Sidecar must be Windows GUI subsystem. Rebuild with PyInstaller --noconsole: $OutputPath"
}

Write-Host "Created sidecar: $OutputPath"
