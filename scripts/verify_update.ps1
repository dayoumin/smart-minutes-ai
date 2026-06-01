param(
    [Parameter(Mandatory = $true)]
    [string]$TargetDir,
    [string]$PackageDir = $PSScriptRoot
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
    return $resolvedPath
}

function Add-Result([string]$Name, [bool]$Passed, [string]$Detail = "") {
    $script:Results += [pscustomobject]@{
        Check = $Name
        Result = if ($Passed) { "PASS" } else { "FAIL" }
        Detail = $Detail
    }
    if (-not $Passed) {
        $script:Failed = $true
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

function Test-RequiredModels([string]$TargetRoot, $Manifest) {
    $missing = @()
    $modelsDir = Join-Path $TargetRoot "models"
    foreach ($model in @($Manifest.requiredModels)) {
        $modelDir = Join-Path $modelsDir ([string]$model.portableDir)
        foreach ($marker in @($model.requiredMarkers)) {
            $markerPath = Join-Path $modelDir ([string]$marker)
            if (-not (Test-Path -LiteralPath $markerPath)) {
                $missing += "models\$($model.portableDir)\$marker"
            }
        }
    }
    Add-Result "required model markers" ($missing.Count -eq 0) ($missing -join "; ")
}

function Test-PayloadHashes([string]$TargetRoot, $Manifest) {
    $mismatches = @()
    foreach ($entry in @($Manifest.payloadFiles)) {
        $packageRelativePath = [string]$entry.path
        if (-not $packageRelativePath.StartsWith("payload\", [System.StringComparison]::OrdinalIgnoreCase)) {
            $mismatches += "$packageRelativePath is outside payload"
            continue
        }

        $targetRelativePath = $packageRelativePath.Substring("payload\".Length)
        $targetPath = Join-Path $TargetRoot $targetRelativePath
        $actualHash = Get-FileHashValue $targetPath
        if (-not $actualHash) {
            $mismatches += "$targetRelativePath missing"
        }
        elseif ($actualHash -ne [string]$entry.sha256) {
            $mismatches += "$targetRelativePath hash mismatch"
        }
    }
    Add-Result "payload file hashes" ($mismatches.Count -eq 0) ($mismatches -join "; ")
}

function Test-PackagePayloadIntegrity([string]$PackageRoot, [string]$PayloadRoot, $Manifest) {
    $failures = @()

    try {
        $releaseManifestPath = Join-Path $PackageRoot ([string]$Manifest.source.releaseManifest)
        if (-not (Test-IsPathWithin $releaseManifestPath $PackageRoot) -or -not (Test-Path -LiteralPath $releaseManifestPath)) {
            $failures += "package release manifest missing"
        }
        else {
            if ($Manifest.source.releaseManifestSha256) {
                $actualReleaseManifestHash = Get-FileHashValue $releaseManifestPath
                if ($actualReleaseManifestHash -ne [string]$Manifest.source.releaseManifestSha256) {
                    $failures += "package release manifest hash mismatch"
                }
            }
            if ($null -ne $Manifest.source.releaseManifestBytes) {
                $actualReleaseManifestBytes = (Get-Item -LiteralPath $releaseManifestPath).Length
                if ([int64]$actualReleaseManifestBytes -ne [int64]$Manifest.source.releaseManifestBytes) {
                    $failures += "package release manifest size mismatch"
                }
            }
        }

        $listedPayloadFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in @($Manifest.payloadFiles)) {
            $relativePath = [string]$entry.path
            if (-not $relativePath.StartsWith("payload\", [System.StringComparison]::OrdinalIgnoreCase)) {
                $failures += "$relativePath outside payload"
                continue
            }
            $payloadFile = Join-Path $PackageRoot $relativePath
            if (-not (Test-IsPathWithin $payloadFile $PayloadRoot)) {
                $failures += "$relativePath escaped payload root"
                continue
            }
            if (-not (Test-Path -LiteralPath $payloadFile)) {
                $failures += "$relativePath missing in package"
                continue
            }
            if ($null -ne $entry.bytes) {
                $actualBytes = (Get-Item -LiteralPath $payloadFile).Length
                if ([int64]$actualBytes -ne [int64]$entry.bytes) {
                    $failures += "$relativePath package size mismatch"
                    continue
                }
            }
            $actualHash = Get-FileHashValue $payloadFile
            if ($actualHash -ne [string]$entry.sha256) {
                $failures += "$relativePath package hash mismatch"
            }
            [void]$listedPayloadFiles.Add($relativePath)
        }

        Get-ChildItem -LiteralPath $PayloadRoot -File -Recurse -Force | ForEach-Object {
            $relativePath = "payload\" + (Get-RelativePath $PayloadRoot $_.FullName)
            if ($relativePath.Equals("payload\release-manifest.json", [System.StringComparison]::OrdinalIgnoreCase)) {
                return
            }
            if (-not $listedPayloadFiles.Contains($relativePath)) {
                $failures += "$relativePath not listed in update-manifest.json"
            }
        }
    }
    catch {
        $failures += $_.Exception.Message
    }

    Add-Result "package payload integrity" ($failures.Count -eq 0) ($failures -join "; ")
}

function Test-ReleaseManifest([string]$TargetRoot, $Manifest) {
    $manifestPath = Join-Path $TargetRoot "release-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Add-Result "release manifest" $false "missing"
        return
    }

    try {
        $releaseManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    }
    catch {
        Add-Result "release manifest" $false "parse failed: $($_.Exception.Message)"
        return
    }

    $checks = @()
    if ($releaseManifest.commit -and $Manifest.source.commit) {
        if ([string]$releaseManifest.commit -ne [string]$Manifest.source.commit) {
            $checks += "commit mismatch"
        }
    }
    if (($releaseManifest.PSObject.Properties.Name -contains "dirty") -and [bool]$releaseManifest.dirty) {
        $checks += "dirty=true"
    }

    if (-not $releaseManifest.files -or @($releaseManifest.files.PSObject.Properties).Count -eq 0) {
        $checks += "file hashes missing"
    }
    else {
        foreach ($property in $releaseManifest.files.PSObject.Properties) {
            $entry = $property.Value
            $relativePath = [string]$entry.path
            $expectedHash = [string]$entry.sha256
            if ([string]::IsNullOrWhiteSpace($relativePath) -or [string]::IsNullOrWhiteSpace($expectedHash)) {
                $checks += "$($property.Name) missing path or sha256"
                continue
            }
            $targetFile = Join-Path $TargetRoot $relativePath
            if (-not (Test-IsPathWithin $targetFile $TargetRoot)) {
                $checks += "$relativePath escaped target root"
                continue
            }
            $actualHash = Get-FileHashValue $targetFile
            if (-not $actualHash) {
                $checks += "$relativePath missing"
            }
            elseif ($actualHash -ne $expectedHash) {
                $checks += "$relativePath hash mismatch"
            }
        }
    }

    $payloadEntries = @($releaseManifest.portablePayloadFiles)
    if ($payloadEntries.Count -eq 0) {
        $checks += "portable payload file hashes missing"
    }
    else {
        foreach ($entry in $payloadEntries) {
            $relativePath = [string]$entry.path
            $expectedHash = [string]$entry.sha256
            if ([string]::IsNullOrWhiteSpace($relativePath) -or [string]::IsNullOrWhiteSpace($expectedHash)) {
                $checks += "portable payload entry missing path or sha256"
                continue
            }
            $targetFile = Join-Path $TargetRoot $relativePath
            if (-not (Test-IsPathWithin $targetFile $TargetRoot)) {
                $checks += "$relativePath escaped target root"
                continue
            }
            $actualHash = Get-FileHashValue $targetFile
            if (-not $actualHash) {
                $checks += "$relativePath missing"
            }
            elseif ($actualHash -ne $expectedHash) {
                $checks += "$relativePath hash mismatch"
            }
        }
    }

    $configPath = Join-Path $TargetRoot "backend\config.json"
    if (-not (Test-Path -LiteralPath $configPath)) {
        $checks += "backend config missing"
    }
    elseif ($releaseManifest.files -and ($releaseManifest.files.PSObject.Properties.Name -contains "backendConfig")) {
        $actualConfigHash = Get-FileHashValue $configPath
        if ([string]$releaseManifest.files.backendConfig.sha256 -ne $actualConfigHash) {
            $checks += "backend config hash mismatch"
        }
    }

    if ($releaseManifest.modelMarkers) {
        foreach ($marker in @($releaseManifest.modelMarkers)) {
            $markerPath = Join-Path $TargetRoot ([string]$marker.path)
            $exists = Test-Path -LiteralPath $markerPath
            if ([bool]$marker.exists -ne $exists) {
                $checks += "$($marker.path) existence mismatch"
                continue
            }
            if ($exists -and $null -ne $marker.bytes) {
                $actualBytes = (Get-Item -LiteralPath $markerPath).Length
                if ([int64]$marker.bytes -ne [int64]$actualBytes) {
                    $checks += "$($marker.path) size mismatch"
                }
            }
        }
    }

    Add-Result "release manifest" ($checks.Count -eq 0) ($checks -join "; ")
}

$script:Results = @()
$script:Failed = $false

$targetPath = Assert-SafeTargetPath $TargetDir
$packagePath = Resolve-ExistingPath $PackageDir
$payloadPath = Join-Path $packagePath "payload"
$manifestPath = Join-Path $packagePath "update-manifest.json"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Update manifest missing: $manifestPath"
}

$updateManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Add-Result "update manifest format" ([string]$updateManifest.packageFormat -eq "lmo-audio-manual-update-v1") ([string]$updateManifest.packageFormat)
Add-Result "payload exists" (Test-Path -LiteralPath $payloadPath) $payloadPath
Add-Result "payload excludes models" (-not (Test-Path -LiteralPath (Join-Path $payloadPath "models"))) "payload\models"
Add-Result "payload excludes backend config" (-not (Test-Path -LiteralPath (Join-Path $payloadPath "backend\config.json"))) "payload\backend\config.json"
Test-PackagePayloadIntegrity $packagePath $payloadPath $updateManifest
Add-Result "app exe exists" (Test-Path -LiteralPath (Join-Path $targetPath "lmo_audio.exe")) "lmo_audio.exe"
Add-Result "sidecar exe exists" (Test-Path -LiteralPath (Join-Path $targetPath "binaries\meeting-backend-x86_64-pc-windows-msvc.exe")) "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
Add-Result "ffmpeg exists" (Test-Path -LiteralPath (Join-Path $targetPath "backend\ffmpeg.exe")) "backend\ffmpeg.exe"
Add-Result "backend config preserved" (Test-Path -LiteralPath (Join-Path $targetPath "backend\config.json")) "backend\config.json"
Test-RequiredModels $targetPath $updateManifest
Test-PayloadHashes $targetPath $updateManifest
Test-ReleaseManifest $targetPath $updateManifest

$Results | Format-Table -AutoSize

if ($Failed) {
    throw "Update verification failed."
}

Write-Host "Update verification passed." -ForegroundColor Green
