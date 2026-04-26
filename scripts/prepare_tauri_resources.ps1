param(
    [switch]$IncludeModels = $true
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BackendDir = Join-Path $RepoRoot "backend"
$ResourceBackendDir = Join-Path $RepoRoot "desktop-app\src-tauri\resources\backend"

New-Item -ItemType Directory -Force -Path $ResourceBackendDir | Out-Null

Copy-Item -Force (Join-Path $BackendDir "config.json") (Join-Path $ResourceBackendDir "config.json")

$TemplateSource = Join-Path $BackendDir "templates"
$TemplateTarget = Join-Path $ResourceBackendDir "templates"
if (Test-Path $TemplateSource) {
    if (Test-Path $TemplateTarget) {
        Remove-Item -Recurse -Force $TemplateTarget
    }
    Copy-Item -Recurse -Force $TemplateSource $TemplateTarget
}

if ($IncludeModels) {
    $ModelSource = Join-Path $BackendDir "models"
    $ModelTarget = Join-Path $ResourceBackendDir "models"
    if (-not (Test-Path $ModelSource)) {
        throw "Model source directory does not exist: $ModelSource"
    }

    if (Test-Path $ModelTarget) {
        Remove-Item -Recurse -Force $ModelTarget
    }

    robocopy $ModelSource $ModelTarget /E /XD .git .cache /XF *.lock | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }
}

Write-Host "Prepared Tauri backend resources: $ResourceBackendDir"
