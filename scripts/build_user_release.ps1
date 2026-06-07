param(
    [string]$Python = "backend\.venv-desktop\Scripts\python.exe",
    [switch]$NoClearWebViewCache,
    [switch]$SkipSidecarBuild,
    [switch]$SkipTauriBuild,
    [switch]$AllowDirty,
    [switch]$AllowMissingEmbeddedOllama
)

$ErrorActionPreference = "Stop"

$releaseScript = Join-Path $PSScriptRoot "release_portable.ps1"

& $releaseScript `
    -Python $Python `
    -ClearWebViewCache:(!$NoClearWebViewCache) `
    -SkipSidecarBuild:$SkipSidecarBuild `
    -SkipTauriBuild:$SkipTauriBuild `
    -AllowDirty:$AllowDirty `
    -AllowMissingEmbeddedOllama:$AllowMissingEmbeddedOllama
