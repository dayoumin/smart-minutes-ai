param(
    [string]$DeployDir = "releases\lmo_audio",
    [string]$Configuration = "release",
    [string]$Python = "backend\.venv-desktop\Scripts\python.exe",
    [switch]$SkipSidecarBuild,
    [switch]$SkipTauriBuild,
    [switch]$ClearWebViewCache,
    [switch]$AllowDirty
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

function Normalize-FullPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-IsPathWithin([string]$Path, [string]$Root) {
    $fullPath = Normalize-FullPath $Path
    $rootPath = Normalize-FullPath $Root
    return $fullPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-PythonCommand([string]$PythonCommand) {
    if ($PythonCommand -match '[\\/]') {
        $resolvedPython = Resolve-InRepoPath $PythonCommand
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

function Assert-SafeDeployPath([string]$Path) {
    $resolvedPath = if (Test-Path -LiteralPath $Path) {
        Normalize-FullPath (Resolve-Path -LiteralPath $Path).Path
    }
    else {
        Normalize-FullPath $Path
    }
    $repoRootPath = (Resolve-Path -LiteralPath $RepoRoot).Path
    $expectedDeployPath = Normalize-FullPath (Join-Path (Join-Path $repoRootPath "releases") $PortableFolderName)

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

    try {
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                ($_.ExecutablePath -and (Test-IsPathWithin $_.ExecutablePath $portableFullPath)) -or
                ($_.Name -like "msedgewebview2*" -and $_.CommandLine -match "com\.nifs\.smart-minutes-ai|com\.lmo\.audio|Smart Minutes AI|lmo_audio")
            } |
            ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
        return
    }
    catch {
        Write-Warning "Could not inspect Win32_Process command lines. Falling back to executable-path process cleanup only. $($_.Exception.Message)"
    }

    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Path -and (Test-IsPathWithin $_.Path $portableFullPath)
        } |
        Stop-Process -Force -ErrorAction SilentlyContinue
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

    try {
        $hashCommand = Get-Command Get-FileHash -ErrorAction Stop
        return (& $hashCommand -LiteralPath $Path -Algorithm SHA256).Hash
    }
    catch {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace "-", "").ToUpperInvariant()
            }
            finally {
                $sha.Dispose()
            }
        }
        finally {
            $stream.Dispose()
        }
    }
}

function Get-GitValue([string]$Command) {
    try {
        $args = @("-c", "core.excludesFile=", "-C", $RepoRoot.Path) + ($Command -split " ")
        $output = & git @args 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "git $Command failed with exit code $LASTEXITCODE"
        }
        return $output
    }
    catch {
        throw "Unable to read git metadata for release manifest. $($_.Exception.Message)"
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

function Get-PortablePayloadFiles([string]$PortableDir) {
    $portableRoot = Normalize-FullPath $PortableDir
    $files = @()
    $rootPayloadNames = @($PortableAppExeName, "START_HERE.txt")

    foreach ($name in $rootPayloadNames) {
        $path = Join-Path $PortableDir $name
        if (Test-Path -LiteralPath $path) {
            $files += [ordered]@{
                path = $name
                sha256 = Get-FileHashValue $path
                bytes = (Get-Item -LiteralPath $path).Length
            }
        }
    }

    foreach ($folder in @("binaries", "backend")) {
        $root = Join-Path $PortableDir $folder
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }
        Get-ChildItem -LiteralPath $root -File -Recurse -Force |
            Sort-Object FullName |
            ForEach-Object {
                $fullPath = Normalize-FullPath $_.FullName
                $relativePath = $fullPath.Substring($portableRoot.Length).TrimStart("\", "/")
                $relativeParts = $relativePath -split '[\\/]'
                if ($relativeParts -contains "__pycache__") {
                    return
                }
                if ($_.Name -like "*.pyc") {
                    return
                }
                $isBackendRuntimeFile = $relativeParts.Length -ge 2 -and
                    $relativeParts[0].Equals("backend", [System.StringComparison]::OrdinalIgnoreCase) -and
                    ($relativeParts[1] -in @("outputs", "temp"))
                if ($isBackendRuntimeFile) {
                    return
                }
                if ($relativePath.Equals("backend\config.json", [System.StringComparison]::OrdinalIgnoreCase)) {
                    return
                }
                $files += [ordered]@{
                    path = $relativePath
                    sha256 = Get-FileHashValue $_.FullName
                    bytes = $_.Length
                }
            }
    }

    return @($files)
}

function Write-ReleaseManifest([string]$PortableDir) {
    $appExe = Join-Path $PortableDir $PortableAppExeName
    $sidecarExe = Join-Path $PortableDir "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
    $backendMain = Join-Path $PortableDir "backend\main.py"
    $configJson = Join-Path $PortableDir "backend\config.json"
    $startHere = Join-Path $PortableDir "START_HERE.txt"
    $modelMarkers = @(
        foreach ($model in @($ModelLayout.models)) {
            foreach ($marker in @($model.requiredMarkers)) {
                (Join-Path (Join-Path ([string]$ModelLayout.canonical) ([string]$model.portableDir)) ([string]$marker)).Replace("/", "\")
            }
        }
    )
    $commit = Get-GitValue "rev-parse HEAD"
    $branch = Get-GitValue "branch --show-current"
    $status = Get-GitValue "status --short --untracked-files=all"

    $manifest = [ordered]@{
        app = "lmo_audio"
        generatedAt = (Get-Date).ToString("o")
        repoRoot = $RepoRoot.Path
        commit = $commit
        branch = $branch
        dirty = [bool]($status -join "")
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
            startHere = [ordered]@{
                path = "START_HERE.txt"
                sha256 = Get-FileHashValue $startHere
            }
        }
        portablePayloadFiles = Get-PortablePayloadFiles $PortableDir
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

function Clear-DeployResidue([string]$DestinationDir) {
    $destinationFullPath = Normalize-FullPath $DestinationDir
    $allowedRootNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @($PortableAppExeName, "release-manifest.json", "START_HERE.txt", "backend", "binaries", "models")) {
        $null = $allowedRootNames.Add($name)
    }

    foreach ($entry in Get-ChildItem -LiteralPath $DestinationDir -Force) {
        if ($allowedRootNames.Contains($entry.Name)) {
            continue
        }

        $entryFullPath = Normalize-FullPath $entry.FullName
        if (-not $entryFullPath.StartsWith($destinationFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clear unsafe deploy residue path: $entryFullPath"
        }

        Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

    foreach ($relativePath in @("backend\outputs", "backend\temp", "backend\logs", "backend\__pycache__")) {
        $path = Join-Path $DestinationDir $relativePath
        if (-not (Test-Path -LiteralPath $path)) {
            continue
        }

        $pathFullPath = Normalize-FullPath $path
        if (-not $pathFullPath.StartsWith($destinationFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clear unsafe deploy runtime path: $pathFullPath"
        }

        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Sync-PortableToDeploy([string]$SourceDir, [string]$DestinationDir) {
    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
    Clear-DeployResidue $DestinationDir

    Copy-Item -Force (Join-Path $SourceDir $PortableAppExeName) (Join-Path $DestinationDir $PortableAppExeName)
    Copy-Item -Force (Join-Path $SourceDir "release-manifest.json") (Join-Path $DestinationDir "release-manifest.json")
    Copy-Item -Force (Join-Path $SourceDir "START_HERE.txt") (Join-Path $DestinationDir "START_HERE.txt")

    robocopy (Join-Path $SourceDir "binaries") (Join-Path $DestinationDir "binaries") /MIR /R:2 /W:2 /NFL /NDL /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while syncing binaries with exit code $LASTEXITCODE"
    }

    robocopy (Join-Path $SourceDir "backend") (Join-Path $DestinationDir "backend") /MIR /XD outputs temp logs __pycache__ /XF *.pyc /NFL /NDL /NP | Out-Host
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
$PythonCommand = Resolve-PythonCommand $Python

if (-not $SkipSidecarBuild) {
    Assert-PythonRuntime $PythonCommand
    Assert-PythonBuildRequirements $PythonCommand
}

$legacyRootPortable = Join-Path $RepoRoot $PortableFolderName
if (Test-Path -LiteralPath $legacyRootPortable) {
    Write-Warning "Legacy root portable folder exists and is no longer the release target: $legacyRootPortable. Use $DeployPath instead."
}

Stop-AppProcesses $DeployPath
if ($ClearWebViewCache) {
    Clear-WebViewRenderCache
}

if (-not $SkipSidecarBuild) {
    & (Join-Path $PSScriptRoot "package_backend_sidecar.ps1") -Python $PythonCommand
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

& (Join-Path $PSScriptRoot "verify_portable.ps1") -PortableDir $DeployPath -AllowDirty:$AllowDirty

Write-Host "Portable release is ready:" -ForegroundColor Green
Write-Host $DeployPath
