param(
    [string]$DeployDir = "lmo_audio",
    [string]$Configuration = "release",
    [string]$Python = "python",
    [switch]$SkipSidecarBuild,
    [switch]$SkipTauriBuild,
    [switch]$ClearWebViewCache
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TauriDir = Join-Path $RepoRoot "desktop-app\src-tauri"
$ReleaseDir = Join-Path $TauriDir "target\$Configuration"
$PortableFolderName = "lmo_audio"
$PortableAppExeName = "lmo_audio.exe"
$TargetPortableDir = Join-Path $ReleaseDir "portable\$PortableFolderName"
$ModelLayoutFile = Join-Path $PSScriptRoot "portable_model_layout.json"
$ModelLayout = Get-Content -LiteralPath $ModelLayoutFile -Raw | ConvertFrom-Json

function Resolve-InRepoPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) {
        if (Test-Path -LiteralPath $Path) {
            return (Resolve-Path -LiteralPath $Path).Path
        }
        return [System.IO.Path]::GetFullPath($Path)
    }
    return (Join-Path $RepoRoot $Path)
}

function Assert-SafeDeployPath([string]$Path) {
    $resolvedPath = if (Test-Path -LiteralPath $Path) {
        (Resolve-Path -LiteralPath $Path).Path
    }
    else {
        [System.IO.Path]::GetFullPath($Path)
    }
    $repoRootPath = (Resolve-Path -LiteralPath $RepoRoot).Path
    $expectedDeployPath = [System.IO.Path]::GetFullPath((Join-Path $repoRootPath $PortableFolderName))

    if (-not $resolvedPath.Equals($expectedDeployPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe DeployDir. Portable releases must deploy to $expectedDeployPath, got $resolvedPath"
    }

    foreach ($unsafePath in @($repoRootPath, (Split-Path -Parent $repoRootPath), (Join-Path $repoRootPath "desktop-app"))) {
        $unsafeFullPath = [System.IO.Path]::GetFullPath($unsafePath)
        if ($resolvedPath.Equals($unsafeFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe DeployDir points to a project or parent directory: $resolvedPath"
        }
    }

    foreach ($child in @("backend", "binaries", "models")) {
        $childPath = Join-Path $resolvedPath $child
        $childFullPath = [System.IO.Path]::GetFullPath($childPath)
        if (-not $childFullPath.StartsWith($resolvedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe DeployDir child path escaped deployment root: $childFullPath"
        }
    }

    return $resolvedPath
}

function Stop-AppProcesses([string]$PortableRoot) {
    $portableFullPath = if (Test-Path -LiteralPath $PortableRoot) {
        (Resolve-Path -LiteralPath $PortableRoot).Path
    }
    else {
        $PortableRoot
    }

    Get-CimInstance Win32_Process |
        Where-Object {
            ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($portableFullPath, [System.StringComparison]::OrdinalIgnoreCase)) -or
            ($_.Name -like "msedgewebview2*" -and $_.CommandLine -match "com\.nifs\.smart-minutes-ai|com\.lmo\.audio|Smart Minutes AI|lmo_audio")
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

function Clear-WebViewRenderCache {
    $defaultDir = Join-Path $env:LOCALAPPDATA "com.nifs.smart-minutes-ai\EBWebView\Default"
    if (-not (Test-Path -LiteralPath $defaultDir)) {
        return
    }

    $resolvedDefault = Resolve-Path -LiteralPath $defaultDir
    $cacheDirs = @("Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Session Storage")
    foreach ($name in $cacheDirs) {
        $path = Join-Path $resolvedDefault $name
        if (-not (Test-Path -LiteralPath $path)) {
            continue
        }
        $resolved = Resolve-Path -LiteralPath $path
        if (-not $resolved.Path.StartsWith($resolvedDefault.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clear unsafe WebView cache path: $($resolved.Path)"
        }
        Remove-Item -LiteralPath $resolved.Path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-FileHashValue([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-GitValue([string]$Command) {
    try {
        $args = @("-C", $RepoRoot.Path) + ($Command -split " ")
        return (& git @args 2>$null)
    }
    catch {
        return $null
    }
}

function Get-FrontendAssets {
    $assetsDir = Join-Path $RepoRoot "desktop-app\dist\assets"
    if (-not (Test-Path -LiteralPath $assetsDir)) {
        return @()
    }

    return @(Get-ChildItem -LiteralPath $assetsDir -File |
        Sort-Object Name |
        ForEach-Object {
            [ordered]@{
                name = $_.Name
                sha256 = Get-FileHashValue $_.FullName
                bytes = $_.Length
            }
        })
}

function Write-ReleaseManifest([string]$PortableDir) {
    $appExe = Join-Path $PortableDir $PortableAppExeName
    $sidecarExe = Join-Path $PortableDir "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
    $backendMain = Join-Path $PortableDir "backend\main.py"
    $configJson = Join-Path $PortableDir "backend\config.json"
    $modelMarkers = @(
        foreach ($model in @($ModelLayout.models)) {
            foreach ($marker in @($model.requiredMarkers)) {
                (Join-Path (Join-Path ([string]$ModelLayout.canonical) ([string]$model.portableDir)) ([string]$marker)).Replace("/", "\")
            }
        }
    )

    $manifest = [ordered]@{
        app = "lmo_audio"
        generatedAt = (Get-Date).ToString("o")
        repoRoot = $RepoRoot.Path
        commit = Get-GitValue "rev-parse HEAD"
        branch = Get-GitValue "branch --show-current"
        dirty = [bool]((Get-GitValue "status --short") -join "")
        portableDir = (Resolve-Path -LiteralPath $PortableDir).Path
        files = [ordered]@{
            appExe = [ordered]@{
                path = $PortableAppExeName
                sha256 = Get-FileHashValue $appExe
            }
            sidecarExe = [ordered]@{
                path = "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
                sha256 = Get-FileHashValue $sidecarExe
            }
            backendMain = [ordered]@{
                path = "backend\main.py"
                sha256 = Get-FileHashValue $backendMain
            }
            backendConfig = [ordered]@{
                path = "backend\config.json"
                sha256 = Get-FileHashValue $configJson
            }
        }
        frontendAssets = Get-FrontendAssets
        modelLayout = $ModelLayout
        modelMarkers = @($modelMarkers | ForEach-Object {
            $path = Join-Path $PortableDir $_
            $exists = Test-Path -LiteralPath $path
            [ordered]@{
                path = $_
                exists = $exists
                bytes = if ($exists) { (Get-Item -LiteralPath $path).Length } else { $null }
            }
        })
    }

    $manifestPath = Join-Path $PortableDir "release-manifest.json"
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    return $manifestPath
}

function Sync-PortableToDeploy([string]$SourceDir, [string]$DestinationDir) {
    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null

    Copy-Item -Force (Join-Path $SourceDir $PortableAppExeName) (Join-Path $DestinationDir $PortableAppExeName)
    Copy-Item -Force (Join-Path $SourceDir "release-manifest.json") (Join-Path $DestinationDir "release-manifest.json")

    robocopy (Join-Path $SourceDir "binaries") (Join-Path $DestinationDir "binaries") /MIR /R:2 /W:2 /NFL /NDL /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while syncing binaries with exit code $LASTEXITCODE"
    }

    robocopy (Join-Path $SourceDir "backend") (Join-Path $DestinationDir "backend") /MIR /XD outputs temp __pycache__ /XF *.pyc /NFL /NDL /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while syncing backend with exit code $LASTEXITCODE"
    }

    $destinationModels = Join-Path $DestinationDir "models"
    New-Item -ItemType Directory -Force -Path $destinationModels | Out-Null
    robocopy (Join-Path $SourceDir "models") $destinationModels /MIR /XD .git .cache /XF *.lock /NFL /NDL /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while syncing models with exit code $LASTEXITCODE"
    }
}

$DeployPath = Assert-SafeDeployPath (Resolve-InRepoPath $DeployDir)

Stop-AppProcesses $DeployPath
if ($ClearWebViewCache) {
    Clear-WebViewRenderCache
}

if (-not $SkipSidecarBuild) {
    & (Join-Path $PSScriptRoot "package_backend_sidecar.ps1") -Python $Python
}

& (Join-Path $PSScriptRoot "prepare_tauri_resources.ps1") -IncludeModels:$false

if (-not $SkipTauriBuild) {
    & corepack pnpm --dir (Join-Path $RepoRoot "desktop-app") run desktop:build:exe
}

& (Join-Path $PSScriptRoot "package_desktop_portable.ps1") -Configuration $Configuration

$targetManifest = Write-ReleaseManifest $TargetPortableDir
Write-Host "Wrote target manifest: $targetManifest"

Sync-PortableToDeploy $TargetPortableDir $DeployPath
$deployManifest = Write-ReleaseManifest $DeployPath
Write-Host "Wrote deploy manifest: $deployManifest"

& (Join-Path $PSScriptRoot "verify_portable.ps1") -PortableDir $DeployPath

Write-Host "Portable release is ready:" -ForegroundColor Green
Write-Host $DeployPath
