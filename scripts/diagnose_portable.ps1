param(
    [string]$PortableDir = "releases\lmo_audio",
    [int]$FirstPort = 17863,
    [int]$LastPort = 17980
)

$ErrorActionPreference = "Continue"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ModelLayoutFile = Join-Path $PSScriptRoot "portable_model_layout.json"
$ModelLayout = Get-Content -LiteralPath $ModelLayoutFile -Raw | ConvertFrom-Json

function Normalize-FullPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Resolve-InRepoPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) {
        if (Test-Path -LiteralPath $Path) {
            return Normalize-FullPath (Resolve-Path -LiteralPath $Path).Path
        }
        return Normalize-FullPath $Path
    }
    return Normalize-FullPath (Join-Path $RepoRoot $Path)
}

function Get-HashIfExists([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Test-ManifestDrift([string]$PortableRoot, [string]$ManifestPath) {
    $results = @()
    if (-not (Test-Path -LiteralPath $ManifestPath)) {
        return @([pscustomobject]@{ Item = "release-manifest.json"; Result = "FAIL"; Detail = "missing" })
    }

    try {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    }
    catch {
        return @([pscustomobject]@{ Item = "release-manifest.json"; Result = "FAIL"; Detail = "parse failed" })
    }

    foreach ($entry in $manifest.files.PSObject.Properties) {
        $relativePath = [string]$entry.Value.path
        $expectedHash = [string]$entry.Value.sha256
        $fullPath = Join-Path $PortableRoot $relativePath
        $actualHash = Get-HashIfExists $fullPath
        $ok = $actualHash -and (!$expectedHash -or $actualHash -eq $expectedHash)
        $results += [pscustomobject]@{
            Item = $relativePath
            Result = if ($ok) { "PASS" } else { "FAIL" }
            Detail = if ($actualHash) { $actualHash } else { "missing" }
        }
    }

    foreach ($marker in @($manifest.modelMarkers)) {
        if (-not $marker -or -not $marker.path) {
            continue
        }
        $relativePath = [string]$marker.path
        $fullPath = Join-Path $PortableRoot $relativePath
        $exists = Test-Path -LiteralPath $fullPath
        $ok = [bool]$marker.exists -eq $exists
        if ($ok -and $exists -and $null -ne $marker.bytes) {
            $ok = [int64](Get-Item -LiteralPath $fullPath).Length -eq [int64]$marker.bytes
        }
        $results += [pscustomobject]@{
            Item = $relativePath
            Result = if ($ok) { "PASS" } else { "FAIL" }
            Detail = if ($exists) { "present" } else { "missing" }
        }
    }

    return $results
}

function Write-Section([string]$Title) {
    Write-Host ""
    Write-Host "== $Title ==" -ForegroundColor Cyan
}

$portablePath = Resolve-InRepoPath $PortableDir
$legacyRootPortable = Join-Path $RepoRoot "lmo_audio"
$appExe = Join-Path $portablePath "lmo_audio.exe"
$sidecarExe = Join-Path $portablePath "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
$manifestFile = Join-Path $portablePath "release-manifest.json"
$modelsDir = Join-Path $portablePath "models"
$webViewDefault = Join-Path $env:LOCALAPPDATA "com.nifs.smart-minutes-ai\EBWebView\Default"

Write-Section "Portable Folder"
Write-Host "Portable: $portablePath"
if (Test-Path -LiteralPath $legacyRootPortable) {
    Write-Warning "Legacy root portable folder exists and is no longer the release target: $legacyRootPortable. Default diagnostics use $portablePath."
}
Write-Host "App exe:  $(Test-Path -LiteralPath $appExe)  $appExe"
Write-Host "Sidecar:  $(Test-Path -LiteralPath $sidecarExe)  $sidecarExe"
Write-Host "Models:   $(Test-Path -LiteralPath $modelsDir)  $modelsDir"

Write-Section "Hashes"
[pscustomobject]@{
    AppExe = Get-HashIfExists $appExe
    SidecarExe = Get-HashIfExists $sidecarExe
    BackendMain = Get-HashIfExists (Join-Path $portablePath "backend\main.py")
    BackendConfig = Get-HashIfExists (Join-Path $portablePath "backend\config.json")
} | Format-List

Write-Section "Release Manifest"
if (Test-Path -LiteralPath $manifestFile) {
    Get-Content -LiteralPath $manifestFile -TotalCount 80
    Write-Section "Manifest Drift Check"
    Test-ManifestDrift $portablePath $manifestFile | Format-Table -AutoSize
}
else {
    Write-Host "No release-manifest.json found."
}

Write-Section "Processes"
$processes = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -like "lmo_audio*" -or
        $_.Name -like "Smart Minutes AI*" -or
        $_.Name -like "smart-minutes-ai*" -or
        $_.Name -like "meeting-backend*" -or
        ($_.Name -like "msedgewebview2*" -and $_.CommandLine -match "com\.nifs\.smart-minutes-ai|com\.lmo\.audio|Smart Minutes AI|lmo_audio")
    } |
    Select-Object ProcessId, Name, ExecutablePath, CommandLine

if ($processes) {
    $processes | Format-Table -AutoSize
}
else {
    Write-Host "No lmo_audio related process is running."
}

Write-Section "Listening Ports"
$connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") -and $_.LocalPort -ge $FirstPort -and $_.LocalPort -le $LastPort } |
    Sort-Object LocalPort |
    Select-Object LocalAddress, LocalPort, OwningProcess

if ($connections) {
    $connections | Format-Table -AutoSize
}
else {
    Write-Host "No local analysis port is listening in $FirstPort-$LastPort."
}

Write-Section "API Probe"
foreach ($connection in @($connections)) {
    $baseUrl = "http://127.0.0.1:$($connection.LocalPort)"
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 3
        Write-Host "$baseUrl/api/health => $($health | ConvertTo-Json -Compress)"
        $models = Invoke-RestMethod -Uri "$baseUrl/api/models/status" -TimeoutSec 5
        Write-Host "$baseUrl/api/models/status => ready=$($models.ready)"
    }
    catch {
        Write-Host "$baseUrl probe failed: $($_.Exception.Message)"
    }
}

Write-Section "Model Markers"
foreach ($model in @($ModelLayout.models)) {
    $modelDir = Join-Path $modelsDir ([string]$model.portableDir)
    Write-Host "$($model.label) : $(Test-Path -LiteralPath $modelDir)  $modelDir"
    foreach ($marker in @($model.requiredMarkers)) {
        $path = Join-Path $modelDir ([string]$marker)
        Write-Host "  $marker : $(Test-Path -LiteralPath $path)"
    }
}

Write-Section "WebView Cache"
Write-Host "Path: $webViewDefault"
if (Test-Path -LiteralPath $webViewDefault) {
    Get-ChildItem -LiteralPath $webViewDefault -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @("Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Session Storage", "IndexedDB") } |
        Select-Object Name, LastWriteTime |
        Format-Table -AutoSize
}
else {
    Write-Host "No WebView profile folder found."
}
