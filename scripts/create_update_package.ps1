param(
    [string]$PortableDir = "releases\lmo_audio",
    [string]$OutputRoot = "releases\updates",
    [string]$PackageName = "",
    [switch]$AllowDirty,
    [switch]$AllowStale,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ModelLayoutFile = Join-Path $PSScriptRoot "portable_model_layout.json"

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

function Assert-SafePortablePath([string]$Path) {
    $resolvedPath = Normalize-FullPath $Path
    if (-not (Split-Path -Leaf $resolvedPath).Equals("lmo_audio", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "PortableDir must point to the lmo_audio folder itself: $resolvedPath"
    }
    foreach ($child in @("backend", "binaries", "models")) {
        $childPath = Normalize-FullPath (Join-Path $resolvedPath $child)
        if (-not $childPath.StartsWith($resolvedPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "PortableDir child path escaped portable root: $childPath"
        }
    }
    return $resolvedPath
}

function Assert-SafeOutputPath([string]$Path) {
    $resolvedPath = Normalize-FullPath $Path
    $repoRootPath = Normalize-FullPath $RepoRoot.Path
    $expectedRoot = Normalize-FullPath (Join-Path $repoRootPath "releases\updates")
    if (-not ($resolvedPath.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedPath.StartsWith($expectedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "OutputRoot must stay under $expectedRoot, got $resolvedPath"
    }
    return $resolvedPath
}

function Assert-SafePackageRoot([string]$OutputRootPath, [string]$PackageRootPath) {
    $outputFullPath = Normalize-FullPath $OutputRootPath
    $packageFullPath = Normalize-FullPath $PackageRootPath
    if (-not $packageFullPath.StartsWith($outputFullPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Package root must stay inside $outputFullPath, got $packageFullPath"
    }
    if ($packageFullPath.Equals($outputFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Package root must be a child folder, not the updates root itself: $packageFullPath"
    }
    return $packageFullPath
}

function Get-FileHashValue([string]$Path) {
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

function Get-GitValue([string[]]$Arguments) {
    $output = & git -c core.excludesFile= @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read git metadata for update package: git $($Arguments -join ' ')"
    }
    return ($output -join "`n").Trim()
}

function Copy-PortableTree([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Source folder missing: $Source"
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $sourceRoot = Normalize-FullPath $Source

    Get-ChildItem -LiteralPath $Source -Recurse -Force | ForEach-Object {
        $fullPath = Normalize-FullPath $_.FullName
        $relativePath = $fullPath.Substring($sourceRoot.Length).TrimStart("\", "/")
        $relativeParts = $relativePath -split '[\\/]'

        if ($_.PSIsContainer) {
            if ($relativeParts -contains "__pycache__") {
                return
            }
            if ($relativeParts.Length -ge 1 -and $relativeParts[0] -in @("outputs", "temp")) {
                return
            }
            New-Item -ItemType Directory -Path (Join-Path $Destination $relativePath) -Force | Out-Null
            return
        }

        if ($relativeParts -contains "__pycache__") {
            return
        }
        if ($_.Name -like "*.pyc") {
            return
        }
        if ($relativeParts.Length -ge 1 -and $relativeParts[0] -in @("outputs", "temp")) {
            return
        }
        if ($relativeParts.Length -eq 1 -and $_.Name.Equals("config.json", [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }

        $targetFile = Join-Path $Destination $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetFile) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $targetFile -Force
    }
}

function Get-PayloadFileEntries([string]$PackageRoot, [string]$PayloadRoot) {
    $packageFullPath = Normalize-FullPath $PackageRoot
    $files = @()
    Get-ChildItem -LiteralPath $PayloadRoot -File -Recurse -Force |
        Sort-Object FullName |
        ForEach-Object {
            $fullPath = Normalize-FullPath $_.FullName
            $relativePath = $fullPath.Substring($packageFullPath.Length).TrimStart("\", "/")
            if ($relativePath.Equals("payload\release-manifest.json", [System.StringComparison]::OrdinalIgnoreCase)) {
                return
            }
            $files += [ordered]@{
                path = $relativePath
                bytes = $_.Length
                sha256 = Get-FileHashValue $_.FullName
            }
        }
    return $files
}

$portablePath = Assert-SafePortablePath (Resolve-InRepoPath $PortableDir)
$outputRootPath = Assert-SafeOutputPath (Resolve-InRepoPath $OutputRoot)
$manifestPath = Join-Path $portablePath "release-manifest.json"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Release manifest missing. Build a clean portable release first: $manifestPath"
}
if (-not (Test-Path -LiteralPath $ModelLayoutFile)) {
    throw "Portable model layout missing: $ModelLayoutFile"
}

$releaseManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (($releaseManifest.PSObject.Properties.Name -contains "dirty") -and [bool]$releaseManifest.dirty -and -not $AllowDirty) {
    throw "Refusing to package a dirty release manifest. Rebuild cleanly or pass -AllowDirty for local testing."
}

$commit = if ($releaseManifest.commit) { [string]$releaseManifest.commit } else { "unknown" }
if (-not $AllowStale) {
    if ([string]::IsNullOrWhiteSpace($commit) -or $commit -eq "unknown") {
        throw "Release manifest does not include a commit. Rebuild cleanly or pass -AllowStale for local testing."
    }

    $headCommit = Get-GitValue @("rev-parse", "HEAD")
    if (-not $commit.Equals($headCommit, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable release commit ($commit) does not match current HEAD ($headCommit). Rebuild first or pass -AllowStale for local testing."
    }
}

$shortCommit = if ($commit.Length -ge 7) { $commit.Substring(0, 7) } else { $commit }
if ([string]::IsNullOrWhiteSpace($PackageName)) {
    $PackageName = "lmo_audio_update_$shortCommit"
}
$PackageName = $PackageName.Trim()
if ([string]::IsNullOrWhiteSpace($PackageName) -or $PackageName -in @(".", "..")) {
    throw "PackageName must be a concrete child folder name."
}
if ($PackageName -match '[\\/:*?"<>|]') {
    throw "PackageName contains invalid path characters: $PackageName"
}

$packageRoot = Assert-SafePackageRoot $outputRootPath (Join-Path $outputRootPath $PackageName)
if (Test-Path -LiteralPath $packageRoot) {
    if (-not $Force) {
        throw "Update package already exists: $packageRoot. Pass -Force to replace it."
    }
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}

$payloadRoot = Join-Path $packageRoot "payload"
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $portablePath "lmo_audio.exe") -Destination (Join-Path $payloadRoot "lmo_audio.exe") -Force
Copy-Item -LiteralPath (Join-Path $portablePath "release-manifest.json") -Destination (Join-Path $payloadRoot "release-manifest.json") -Force

$startHere = Join-Path $portablePath "START_HERE.txt"
if (Test-Path -LiteralPath $startHere) {
    Copy-Item -LiteralPath $startHere -Destination (Join-Path $payloadRoot "START_HERE.txt") -Force
}

Copy-PortableTree (Join-Path $portablePath "binaries") (Join-Path $payloadRoot "binaries")
Copy-PortableTree (Join-Path $portablePath "backend") (Join-Path $payloadRoot "backend")

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "update_lmo_audio.ps1") -Destination (Join-Path $packageRoot "update_lmo_audio.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "verify_update.ps1") -Destination (Join-Path $packageRoot "verify_update.ps1") -Force

if (Test-Path -LiteralPath (Join-Path $payloadRoot "models")) {
    throw "Update package must not include models: $(Join-Path $payloadRoot "models")"
}
if (Test-Path -LiteralPath (Join-Path $payloadRoot "backend\config.json")) {
    throw "Update package must not overwrite an existing user's backend config."
}

$modelLayout = Get-Content -LiteralPath $ModelLayoutFile -Raw | ConvertFrom-Json
$payloadFiles = Get-PayloadFileEntries $packageRoot $payloadRoot
$updateManifest = [ordered]@{
    packageFormat = "lmo-audio-manual-update-v1"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    source = [ordered]@{
        commit = $commit
        dirty = [bool]$releaseManifest.dirty
        app = $releaseManifest.app
        releaseManifest = "payload\release-manifest.json"
        releaseManifestBytes = (Get-Item -LiteralPath (Join-Path $payloadRoot "release-manifest.json")).Length
        releaseManifestSha256 = Get-FileHashValue (Join-Path $payloadRoot "release-manifest.json")
    }
    preservedTargetPaths = @(
        "models",
        "backend\config.json",
        "backend\outputs",
        "backend\temp"
    )
    excludedPayloadPaths = @(
        "payload\models",
        "payload\backend\config.json",
        "payload\backend\outputs",
        "payload\backend\temp",
        "**\__pycache__",
        "**\*.pyc"
    )
    requiredModels = $modelLayout.models
    mutableTargetPaths = @(
        "release-manifest.json"
    )
    payloadFiles = $payloadFiles
}

$manifestOut = Join-Path $packageRoot "update-manifest.json"
$updateManifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestOut -Encoding UTF8

Write-Host "Update package created: $packageRoot"
