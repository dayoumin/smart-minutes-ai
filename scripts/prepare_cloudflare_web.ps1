param(
    [string]$InstallerUrl = "",
    [string]$UpdateUrl = "",
    [switch]$TestRelease
)

$ErrorActionPreference = "Stop"
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$OutputDir = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot ".tmp\cloudflare-web\dist"))
$OutputParent = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot ".tmp\cloudflare-web"))
if ([System.IO.Path]::GetDirectoryName($OutputDir) -ne $OutputParent) {
    throw "Refusing to replace assets outside the dedicated Cloudflare output directory."
}
# Vite empties this directory. Refuse links anywhere along the generated path.
foreach ($path in @((Join-Path $RepoRoot ".tmp"), $OutputParent, $OutputDir)) {
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to build through a reparse point: $path"
    }
}

foreach ($value in @($InstallerUrl, $UpdateUrl)) {
    if ([string]::IsNullOrWhiteSpace($value)) { continue }
    $uri = $null
    if (-not [System.Uri]::TryCreate($value, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https" -or $uri.UserInfo) {
        throw "Installer and update URLs must be absolute HTTPS URLs without credentials."
    }
}

$variables = @{
    VITE_API_BASE_URL = "http://127.0.0.1:17863"
    VITE_LOCAL_ENGINE_CONNECTION_UI = "true"
    VITE_ANALYSIS_MODE = "real"
    VITE_LOCAL_ENGINE_TEST_RELEASE = $(if ($TestRelease) { "true" } else { "false" })
    # Empty environment values are removed by Windows/.NET. A blank sentinel
    # overrides Vite .env files while the frontend treats it as unavailable.
    VITE_LOCAL_ENGINE_INSTALLER_URL = $(if ($InstallerUrl.Trim()) { $InstallerUrl.Trim() } else { " " })
    VITE_LOCAL_ENGINE_UPDATE_URL = $(if ($UpdateUrl.Trim()) { $UpdateUrl.Trim() } else { " " })
    VITE_ENABLE_ASR_BENCHMARK = "false"
}
$previous = @{}
foreach ($key in $variables.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $variables[$key], "Process")
}
Push-Location $RepoRoot
try {
    & corepack pnpm --dir desktop-app exec vite build --mode production --outDir $OutputDir --emptyOutDir
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare web build failed: $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath (Join-Path $OutputDir "index.html") -PathType Leaf)) {
        throw "The web build did not produce index.html."
    }
    Write-Host "Cloudflare web assets: $OutputDir"
    Write-Host "This command prepares files only; it does not publish or upload an installer."
}
finally {
    Pop-Location
    foreach ($key in $variables.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
}
