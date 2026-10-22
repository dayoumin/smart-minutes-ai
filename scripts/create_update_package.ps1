param(
    [string]$PortableDir = "releases\lmo_audio",
    [string]$OutputRoot = "releases\updates",
    [string]$PackageName = "",
    [switch]$AllowDirty,
    [switch]$AllowStale,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'portable_data_safety.ps1')

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ModelLayoutFile = Join-Path $PSScriptRoot "portable_model_layout.json"
$PreservedTargetPaths = @(
    "models",
    "runtime",
    "backend\config.json",
    "backend\outputs",
    "backend\temp",
    "backend\logs",
    "backend\database"
)
$PreservedTargetPatterns = @(
    "backend\**\*.db*",
    "backend\**\*.sqlite*"
)

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

function Test-IsPathWithin([string]$Path, [string]$Root) {
    $fullPath = Normalize-FullPath $Path
    $rootPath = Normalize-FullPath $Root
    return $fullPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Normalize-RelativePath([string]$Path) {
    return ($Path -replace '/', '\').TrimStart("\", "/")
}

function Test-IsPreservedTargetPath([string]$RelativePath) {
    $normalizedPath = Normalize-RelativePath $RelativePath
    foreach ($preservedPath in $PreservedTargetPaths) {
        $normalizedPreservedPath = Normalize-RelativePath $preservedPath
        if ($normalizedPath.Equals($normalizedPreservedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
        if ($normalizedPath.StartsWith($normalizedPreservedPath + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
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

# The update replaces the app, binaries and backend code only. runtime and
# models stay as the installation has them.
function Test-IsUpdatePayloadPath([string]$RelativePath) {
    $normalizedPath = Normalize-RelativePath $RelativePath
    if ($normalizedPath -in @("lmo_audio.exe", "START_HERE.txt")) {
        return $true
    }
    return $normalizedPath.StartsWith("binaries\", [System.StringComparison]::OrdinalIgnoreCase) -or
        $normalizedPath.StartsWith("backend\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-UpdatePayloadEntries($Manifest) {
    $entries = @($Manifest.portablePayloadFiles | Where-Object { $_ -and (Test-IsUpdatePayloadPath ([string]$_.path)) })
    foreach ($entry in $entries) {
        if (Test-PortableUserDataPath ([string]$entry.path)) {
            throw "Release manifest lists user data as package payload: $($entry.path)"
        }
    }
    return ,$entries
}

# Copy exactly the files the build listed. Anything else in the installation,
# such as records or folders users created in backend, never enters the payload.
function Copy-ListedPayloadFiles([string]$PortableRoot, [string]$PayloadRoot, $Entries) {
    foreach ($entry in @($Entries)) {
        $relativePath = Normalize-RelativePath ([string]$entry.path)
        $sourceFile = Join-Path $PortableRoot $relativePath
        $targetFile = Join-Path $PayloadRoot $relativePath
        if (-not (Test-IsPathWithin $sourceFile $PortableRoot) -or -not (Test-IsPathWithin $targetFile $PayloadRoot)) {
            throw "Release manifest payload entry escaped the package: $relativePath"
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetFile) -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
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

function Assert-ManifestEntriesMatchPortable([string]$PortableRoot, $Entries, [string]$Label, [switch]$SkipPreservedTargetPaths) {
    $properties = @($Entries)
    if ($null -eq $Entries) {
        throw "Release manifest does not include $Label hashes. Rebuild the portable release first."
    }

    $mismatches = @()
    foreach ($entry in $properties) {
        $relativePath = [string]$entry.path
        if ([string]::IsNullOrWhiteSpace($relativePath)) {
            $mismatches += "$Label entry is missing path"
            continue
        }
        if ($SkipPreservedTargetPaths -and (Test-IsPreservedTargetPath $relativePath)) {
            continue
        }

        $expectedHash = [string]$entry.sha256
        if ([string]::IsNullOrWhiteSpace($expectedHash)) {
            $mismatches += "$Label entry is missing sha256"
            continue
        }

        $filePath = Join-Path $PortableRoot $relativePath
        if (-not (Test-IsPathWithin $filePath $PortableRoot)) {
            $mismatches += "$relativePath escaped portable root"
            continue
        }
        if (-not (Test-Path -LiteralPath $filePath)) {
            $mismatches += "$relativePath missing"
            continue
        }
        $actualHash = Get-FileHashValue $filePath
        if ($actualHash -ne $expectedHash) {
            $mismatches += "$relativePath hash mismatch"
        }
    }

    if ($properties.Count -eq 0) {
        $mismatches += "$Label hashes are empty"
    }

    if ($mismatches.Count -gt 0) {
        throw "Portable release manifest does not match current files: $($mismatches -join '; ')"
    }
}

function Assert-ReleaseManifestMatchesPortable([string]$PortableRoot, $Manifest) {
    if (-not $Manifest.files -or @($Manifest.files.PSObject.Properties).Count -eq 0) {
        throw "Release manifest does not include file hashes. Rebuild the portable release first."
    }

    $fileEntries = @()
    foreach ($property in $Manifest.files.PSObject.Properties) {
        $fileEntries += $property.Value
    }
    Assert-ManifestEntriesMatchPortable $PortableRoot $fileEntries "core file" -SkipPreservedTargetPaths
    # Only what the update ships must match. runtime\ollama\README.txt, for
    # example, is replaced when the app installs Ollama and is not shipped.
    Assert-ManifestEntriesMatchPortable $PortableRoot (Get-UpdatePayloadEntries $Manifest) "portable payload file"
}

$portablePath = Assert-SafePortablePath (Resolve-InRepoPath $PortableDir)
Assert-PortableDataLayout $portablePath
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
Assert-ReleaseManifestMatchesPortable $portablePath $releaseManifest

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

Copy-ListedPayloadFiles $portablePath $payloadRoot (Get-UpdatePayloadEntries $releaseManifest)

foreach ($scriptName in @("update_lmo_audio.ps1", "verify_update.ps1", "portable_data_safety.ps1")) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $scriptName) -Destination (Join-Path $packageRoot $scriptName) -Force
}

if (Test-Path -LiteralPath (Join-Path $payloadRoot "models")) {
    throw "Update package must not include models: $(Join-Path $payloadRoot "models")"
}
if (Test-Path -LiteralPath (Join-Path $payloadRoot "backend\config.json")) {
    throw "Update package must not overwrite an existing user's backend config."
}

$modelLayout = Get-Content -LiteralPath $ModelLayoutFile -Raw | ConvertFrom-Json
$payloadFiles = Get-PayloadFileEntries $packageRoot $payloadRoot
# The copies must still be the files the build hashed.
$buildHashes = @{}
foreach ($entry in @(Get-UpdatePayloadEntries $releaseManifest)) {
    $buildHashes["payload\" + (Normalize-RelativePath ([string]$entry.path))] = [string]$entry.sha256
}
foreach ($file in @($payloadFiles)) {
    if ($buildHashes.ContainsKey($file.path) -and $buildHashes[$file.path] -ne $file.sha256) {
        throw "Update payload file changed while packaging: $($file.path)"
    }
}
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
    preservedTargetPaths = $PreservedTargetPaths
    preservedTargetPatterns = $PreservedTargetPatterns
    payloadSource = "release-manifest.json portablePayloadFiles: lmo_audio.exe, START_HERE.txt, binaries, backend"
    excludedPayloadPaths = @(
        "payload\models",
        "payload\runtime",
        "payload\backend\config.json",
        "payload\backend\outputs",
        "payload\backend\temp",
        "payload\backend\logs",
        "payload\backend\database",
        "backend files the release manifest does not list"
    )
    stalePackageFiles = "Only backend files listed by the installed release manifest and unchanged since are removed."
    requiredModels = $modelLayout.models
    mutableTargetPaths = @(
        "release-manifest.json"
    )
    payloadFiles = $payloadFiles
}

$manifestOut = Join-Path $packageRoot "update-manifest.json"
$updateManifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestOut -Encoding UTF8

Write-Host "Update package created: $packageRoot"
