param(
    [Parameter(Mandatory = $true)]
    [string]$TargetDir,
    [string]$PackageDir = $PSScriptRoot,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

function Normalize-FullPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Resolve-ExistingPath([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Path not found: $Path"
    }
    return Normalize-FullPath (Resolve-Path -LiteralPath $Path).Path
}

function Test-IsPathWithin([string]$Path, [string]$Root) {
    $fullPath = Normalize-FullPath $Path
    $rootPath = Normalize-FullPath $Root
    return $fullPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RelativePath([string]$Root, [string]$Path) {
    $rootPath = Normalize-FullPath $Root
    $fullPath = Normalize-FullPath $Path
    if (-not (Test-IsPathWithin $fullPath $rootPath)) {
        throw "Path escaped root. Root=$rootPath Path=$fullPath"
    }
    return $fullPath.Substring($rootPath.Length).TrimStart("\", "/")
}

function Assert-SafeTargetPath([string]$Path) {
    $resolvedPath = Resolve-ExistingPath $Path
    if (-not (Split-Path -Leaf $resolvedPath).Equals("lmo_audio", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "TargetDir must point to the existing lmo_audio folder itself: $resolvedPath"
    }
    foreach ($child in @("backend", "binaries", "models")) {
        $childPath = Normalize-FullPath (Join-Path $resolvedPath $child)
        if (-not $childPath.StartsWith($resolvedPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "TargetDir child path escaped portable root: $childPath"
        }
    }
    return $resolvedPath
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

function Assert-RequiredModels([string]$TargetRoot, $Manifest) {
    $modelsDir = Join-Path $TargetRoot "models"
    if (-not (Test-Path -LiteralPath $modelsDir)) {
        throw "Existing models folder is missing: $modelsDir"
    }

    foreach ($model in @($Manifest.requiredModels)) {
        $modelDir = Join-Path $modelsDir ([string]$model.portableDir)
        foreach ($marker in @($model.requiredMarkers)) {
            $markerPath = Join-Path $modelDir ([string]$marker)
            if (-not (Test-Path -LiteralPath $markerPath)) {
                throw "Required model marker missing: $markerPath"
            }
        }
    }
}

function Assert-UpdatePackageIntegrity([string]$PackageRoot, [string]$PayloadRoot, $Manifest) {
    if ([string]$Manifest.packageFormat -ne "lmo-audio-manual-update-v1") {
        throw "Unsupported update package format: $($Manifest.packageFormat)"
    }
    if (Test-Path -LiteralPath (Join-Path $PayloadRoot "models")) {
        throw "Refusing to apply update package because it contains payload\models."
    }
    if (Test-Path -LiteralPath (Join-Path $PayloadRoot "backend\config.json")) {
        throw "Refusing to apply update package because it contains backend\config.json."
    }

    $releaseManifestPath = Join-Path $PackageRoot ([string]$Manifest.source.releaseManifest)
    if (-not (Test-IsPathWithin $releaseManifestPath $PackageRoot) -or -not (Test-Path -LiteralPath $releaseManifestPath)) {
        throw "Package release manifest missing or outside package root: $releaseManifestPath"
    }
    if ($Manifest.source.releaseManifestSha256) {
        $actualReleaseManifestHash = Get-FileHashValue $releaseManifestPath
        if ($actualReleaseManifestHash -ne [string]$Manifest.source.releaseManifestSha256) {
            throw "Package release manifest hash mismatch."
        }
    }
    if ($null -ne $Manifest.source.releaseManifestBytes) {
        $actualReleaseManifestBytes = (Get-Item -LiteralPath $releaseManifestPath).Length
        if ([int64]$actualReleaseManifestBytes -ne [int64]$Manifest.source.releaseManifestBytes) {
            throw "Package release manifest size mismatch."
        }
    }

    $listedPayloadFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Manifest.payloadFiles)) {
        $relativePath = [string]$entry.path
        if (-not $relativePath.StartsWith("payload\", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Manifest payload entry is outside payload: $relativePath"
        }
        $payloadFile = Join-Path $PackageRoot $relativePath
        if (-not (Test-IsPathWithin $payloadFile $PayloadRoot)) {
            throw "Manifest payload entry escaped payload root: $relativePath"
        }
        if (-not (Test-Path -LiteralPath $payloadFile)) {
            throw "Manifest payload file missing: $relativePath"
        }
        if ($null -ne $entry.bytes) {
            $actualBytes = (Get-Item -LiteralPath $payloadFile).Length
            if ([int64]$actualBytes -ne [int64]$entry.bytes) {
                throw "Manifest payload file size mismatch: $relativePath"
            }
        }
        $actualHash = Get-FileHashValue $payloadFile
        if ($actualHash -ne [string]$entry.sha256) {
            throw "Manifest payload file hash mismatch: $relativePath"
        }
        [void]$listedPayloadFiles.Add($relativePath)
    }

    Get-ChildItem -LiteralPath $PayloadRoot -File -Recurse -Force | ForEach-Object {
        $relativePath = "payload\" + (Get-RelativePath $PayloadRoot $_.FullName)
        if ($relativePath.Equals("payload\release-manifest.json", [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }
        if (-not $listedPayloadFiles.Contains($relativePath)) {
            throw "Payload file is not listed in update-manifest.json: $relativePath"
        }
    }
}

function Stop-TargetProcesses([string]$TargetRoot) {
    try {
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                $_.ExecutablePath -and (Test-IsPathWithin $_.ExecutablePath $TargetRoot)
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
            $_.Path -and (Test-IsPathWithin $_.Path $TargetRoot)
        } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

function Test-PreservedRelativePath([string]$RelativePath, [string[]]$PreserveTopLevelDirectories, [string[]]$PreserveRelativeFiles) {
    $normalized = $RelativePath.Replace("/", "\").TrimStart("\")
    foreach ($file in $PreserveRelativeFiles) {
        if ($normalized.Equals($file, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    $topLevel = ($normalized -split '\\')[0]
    foreach ($directory in $PreserveTopLevelDirectories) {
        if ($topLevel.Equals($directory, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Sync-TreePreservingPaths([string]$Source, [string]$Destination, [string[]]$PreserveTopLevelDirectories = @(), [string[]]$PreserveRelativeFiles = @()) {
    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Payload folder missing: $Source"
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $sourceRoot = Normalize-FullPath $Source
    $destinationRoot = Normalize-FullPath $Destination

    $sourceFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $sourceDirs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    [void]$sourceDirs.Add("")

    Get-ChildItem -LiteralPath $Source -Directory -Recurse -Force | ForEach-Object {
        [void]$sourceDirs.Add((Get-RelativePath $sourceRoot $_.FullName))
    }
    Get-ChildItem -LiteralPath $Source -File -Recurse -Force | ForEach-Object {
        [void]$sourceFiles.Add((Get-RelativePath $sourceRoot $_.FullName))
    }

    Get-ChildItem -LiteralPath $Destination -File -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $relativePath = Get-RelativePath $destinationRoot $_.FullName
        if (Test-PreservedRelativePath $relativePath $PreserveTopLevelDirectories $PreserveRelativeFiles) {
            return
        }
        if (-not $sourceFiles.Contains($relativePath)) {
            Remove-Item -LiteralPath $_.FullName -Force
        }
    }

    Get-ChildItem -LiteralPath $Destination -Directory -Recurse -Force -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        ForEach-Object {
            $relativePath = Get-RelativePath $destinationRoot $_.FullName
            if (Test-PreservedRelativePath $relativePath $PreserveTopLevelDirectories $PreserveRelativeFiles) {
                return
            }
            if (-not $sourceDirs.Contains($relativePath)) {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force
            }
        }

    Get-ChildItem -LiteralPath $Source -Directory -Recurse -Force | ForEach-Object {
        $relativePath = Get-RelativePath $sourceRoot $_.FullName
        New-Item -ItemType Directory -Path (Join-Path $destinationRoot $relativePath) -Force | Out-Null
    }
    Get-ChildItem -LiteralPath $Source -File -Recurse -Force | ForEach-Object {
        $relativePath = Get-RelativePath $sourceRoot $_.FullName
        $targetFile = Join-Path $destinationRoot $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetFile) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $targetFile -Force
    }
}

function Update-TargetReleaseManifest([string]$TargetRoot, $UpdateManifest) {
    $manifestPath = Join-Path $TargetRoot "release-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        return
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $configPath = Join-Path $TargetRoot "backend\config.json"
    if (Test-Path -LiteralPath $configPath) {
        $configHash = Get-FileHashValue $configPath
        if ($manifest.files -and ($manifest.files.PSObject.Properties.Name -contains "backendConfig")) {
            $manifest.files.backendConfig.sha256 = $configHash
            $manifest.files.backendConfig.path = "backend\config.json"
        }
    }

    $manifest | Add-Member -NotePropertyName update -NotePropertyValue ([ordered]@{
        appliedAt = (Get-Date).ToUniversalTime().ToString("o")
        packageFormat = [string]$UpdateManifest.packageFormat
        packageCommit = [string]$UpdateManifest.source.commit
        preservedTargetPaths = @($UpdateManifest.preservedTargetPaths)
    }) -Force

    $modelMarkers = @()
    foreach ($model in @($UpdateManifest.requiredModels)) {
        foreach ($marker in @($model.requiredMarkers)) {
            $relativePath = "models\$($model.portableDir)\$marker"
            $markerPath = Join-Path $TargetRoot $relativePath
            $entry = [ordered]@{
                path = $relativePath
                exists = (Test-Path -LiteralPath $markerPath)
            }
            if ($entry.exists) {
                $entry.bytes = (Get-Item -LiteralPath $markerPath).Length
            }
            $modelMarkers += $entry
        }
    }
    if ($manifest.PSObject.Properties.Name -contains "modelMarkers") {
        $manifest.modelMarkers = @($modelMarkers)
    }
    else {
        $manifest | Add-Member -NotePropertyName modelMarkers -NotePropertyValue @($modelMarkers)
    }

    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}

$packagePath = Resolve-ExistingPath $PackageDir
$targetPath = Assert-SafeTargetPath $TargetDir
$payloadPath = Join-Path $packagePath "payload"
$updateManifestPath = Join-Path $packagePath "update-manifest.json"

if (-not (Test-Path -LiteralPath $payloadPath)) {
    throw "Update payload missing: $payloadPath"
}
if (-not (Test-Path -LiteralPath $updateManifestPath)) {
    throw "Update manifest missing: $updateManifestPath"
}

$updateManifest = Get-Content -LiteralPath $updateManifestPath -Raw | ConvertFrom-Json
Assert-UpdatePackageIntegrity $packagePath $payloadPath $updateManifest
if (-not (Test-Path -LiteralPath (Join-Path $targetPath "backend\config.json"))) {
    throw "Existing backend config is missing. This update package is for an existing portable install, not a fresh install."
}

Assert-RequiredModels $targetPath $updateManifest
Stop-TargetProcesses $targetPath
Start-Sleep -Seconds 1

Copy-Item -LiteralPath (Join-Path $payloadPath "lmo_audio.exe") -Destination (Join-Path $targetPath "lmo_audio.exe") -Force
if (Test-Path -LiteralPath (Join-Path $payloadPath "START_HERE.txt")) {
    Copy-Item -LiteralPath (Join-Path $payloadPath "START_HERE.txt") -Destination (Join-Path $targetPath "START_HERE.txt") -Force
}
Copy-Item -LiteralPath (Join-Path $payloadPath "release-manifest.json") -Destination (Join-Path $targetPath "release-manifest.json") -Force

Sync-TreePreservingPaths (Join-Path $payloadPath "binaries") (Join-Path $targetPath "binaries")
Sync-TreePreservingPaths (Join-Path $payloadPath "backend") (Join-Path $targetPath "backend") @("outputs", "temp") @("config.json")
Update-TargetReleaseManifest $targetPath $updateManifest

if (-not $SkipVerify) {
    $verifyScript = Join-Path $packagePath "verify_update.ps1"
    if (-not (Test-Path -LiteralPath $verifyScript)) {
        throw "Verify script missing from package: $verifyScript"
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $verifyScript -TargetDir $targetPath -PackageDir $packagePath
    if ($LASTEXITCODE -ne 0) {
        throw "Update verification failed."
    }
}

Write-Host "Update applied: $targetPath"
