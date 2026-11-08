# Builds the diagnostic-only engine failure report program. Only installers built with
# build_web_local_engine_installer_poc.ps1 -DiagnosticLogs include it; remove this
# script together with backend\installer_engine_failure_report.py when the temporary
# diagnostic installer mode is retired.
param(
    [string]$Python = "backend\.venv-desktop\Scripts\python.exe",
    [string]$OutputPath = "releases\web-local-engine-installer-diagnostic\build-input\barorok-installer-diagnostic-report.exe"
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BackendDir = Join-Path $RepoRoot "backend"
$ExpectedOutput = [System.IO.Path]::GetFullPath(
    (Join-Path $RepoRoot "releases\web-local-engine-installer-diagnostic\build-input\barorok-installer-diagnostic-report.exe")
)
$ResolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    [System.IO.Path]::GetFullPath($OutputPath)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $OutputPath))
}
if (-not $ResolvedOutput.Equals($ExpectedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must be the dedicated diagnostic report path."
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
    throw "Python with PyInstaller is required before building the diagnostic report program."
}

$WorkRoot = Join-Path $RepoRoot "build\installer-diagnostic-report"
$DistRoot = [System.IO.Path]::GetDirectoryName($ResolvedOutput)
if (Test-Path -LiteralPath $WorkRoot) {
    $resolvedWork = (Resolve-Path -LiteralPath $WorkRoot).Path
    $expectedWork = [System.IO.Path]::GetFullPath($WorkRoot)
    if (-not $resolvedWork.Equals($expectedWork, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace an unexpected diagnostic report work directory."
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
    --name "barorok-installer-diagnostic-report" `
    --paths $BackendDir `
    --distpath $DistRoot `
    --workpath (Join-Path $WorkRoot "work") `
    --specpath (Join-Path $WorkRoot "spec") `
    (Join-Path $BackendDir "installer_engine_failure_report.py")
if ($LASTEXITCODE -ne 0) {
    throw "Diagnostic report program build failed."
}
if (-not (Test-Path -LiteralPath $ResolvedOutput -PathType Leaf)) {
    throw "Diagnostic report program output is missing."
}

Write-Host "Diagnostic report program created: $ResolvedOutput"
