param(
    [string]$Python = "backend\.venv-desktop\Scripts\python.exe",
    [string]$OutputPath = "releases\web-local-engine-installer-poc\build-input\barorok-installer-preflight.exe"
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BackendDir = Join-Path $RepoRoot "backend"
$ExpectedOutput = [System.IO.Path]::GetFullPath(
    (Join-Path $RepoRoot "releases\web-local-engine-installer-poc\build-input\barorok-installer-preflight.exe")
)
$ResolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    [System.IO.Path]::GetFullPath($OutputPath)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $OutputPath))
}
if (-not $ResolvedOutput.Equals($ExpectedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must be the dedicated installer helper path."
}

$PythonCommand = if ([System.IO.Path]::IsPathRooted($Python)) {
    [System.IO.Path]::GetFullPath($Python)
}
elseif ($Python -match '[\\/]') {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Python))
}
else {
    $Python
}
& $PythonCommand -c "import PyInstaller"
if ($LASTEXITCODE -ne 0) {
    throw "Python with PyInstaller is required before replacing installer helper output."
}

$WorkRoot = Join-Path $RepoRoot "build\web-local-engine-installer-preflight-helper"
$DistRoot = [System.IO.Path]::GetDirectoryName($ResolvedOutput)
if (Test-Path -LiteralPath $WorkRoot) {
    $resolvedWork = (Resolve-Path -LiteralPath $WorkRoot).Path
    $expectedWork = [System.IO.Path]::GetFullPath($WorkRoot)
    if (-not $resolvedWork.Equals($expectedWork, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace an unexpected helper work directory."
    }
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force
}
if (Test-Path -LiteralPath $ResolvedOutput) {
    Remove-Item -LiteralPath $ResolvedOutput -Force
}
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
New-Item -ItemType Directory -Path $DistRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $WorkRoot "spec") -Force | Out-Null

& $PythonCommand -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --noconsole `
    --name "barorok-installer-preflight" `
    --paths $BackendDir `
    --distpath $DistRoot `
    --workpath (Join-Path $WorkRoot "work") `
    --specpath (Join-Path $WorkRoot "spec") `
    (Join-Path $BackendDir "web_local_engine_installer_preflight.py")
if ($LASTEXITCODE -ne 0) {
    throw "Installer preflight helper build failed."
}
if (-not (Test-Path -LiteralPath $ResolvedOutput -PathType Leaf)) {
    throw "Installer preflight helper output is missing."
}

Write-Host "Installer preflight helper created: $ResolvedOutput"
