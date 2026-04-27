param(
    [switch]$IncludeModels = $true
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BackendDir = Join-Path $RepoRoot "backend"
$ResourceBackendDir = Join-Path $RepoRoot "desktop-app\src-tauri\resources\backend"

New-Item -ItemType Directory -Force -Path $ResourceBackendDir | Out-Null

Copy-Item -Force (Join-Path $BackendDir "config.json") (Join-Path $ResourceBackendDir "config.json")

$BackendSourceFiles = @(
    "main.py",
    "model_manager.py",
    "ollama_utils.py"
)
foreach ($FileName in $BackendSourceFiles) {
    Copy-Item -Force (Join-Path $BackendDir $FileName) (Join-Path $ResourceBackendDir $FileName)
}

$PipelineSource = Join-Path $BackendDir "pipeline"
$PipelineTarget = Join-Path $ResourceBackendDir "pipeline"
if (Test-Path $PipelineTarget) {
    Remove-Item -Recurse -Force $PipelineTarget
}
Copy-Item -Recurse -Force $PipelineSource $PipelineTarget

$FfmpegSource = Join-Path $BackendDir "ffmpeg.exe"
if (Test-Path $FfmpegSource) {
    Copy-Item -Force $FfmpegSource (Join-Path $ResourceBackendDir "ffmpeg.exe")
}
else {
    Write-Warning "ffmpeg.exe was not found at $FfmpegSource. MP4/video input will require ffmpeg on PATH."
}

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
