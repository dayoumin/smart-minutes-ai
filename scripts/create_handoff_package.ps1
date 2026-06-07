param(
    [string]$PortableDir = "releases\lmo_audio",
    [string]$OutputRoot = "releases\handoff",
    [string]$PackageName = "",
    [switch]$AllowDirty,
    [switch]$AllowStale,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ModelLayoutFile = Join-Path $PSScriptRoot "portable_model_layout.json"
$PortableAppExeName = "lmo_audio.exe"

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
    $expectedRoot = Normalize-FullPath (Join-Path $repoRootPath "releases\handoff")
    if (-not ($resolvedPath.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedPath.StartsWith($expectedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "OutputRoot must stay under $expectedRoot, got $resolvedPath"
    }
    return $resolvedPath
}

function Assert-SafeChildPath([string]$Root, [string]$Child) {
    $rootPath = Normalize-FullPath $Root
    $childPath = Normalize-FullPath $Child
    if (-not $childPath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Child path escaped root: $childPath"
    }
    if ($childPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Child path must not equal root: $childPath"
    }
    return $childPath
}

function Get-FileHashValue([string]$Path) {
    if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
        return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Get-GitValue([string[]]$Arguments) {
    $output = & git -c core.excludesFile= @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read git metadata for handoff package: git $($Arguments -join ' ')"
    }
    return ($output -join "`n").Trim()
}

function Test-RequiredMarkers {
    param(
        [string]$Root,
        [string[]]$Markers,
        [string]$Label
    )

    $missing = @()
    foreach ($marker in $Markers) {
        $path = Join-Path $Root $marker
        if (-not (Test-Path -LiteralPath $path)) {
            $missing += $marker
        }
    }
    if ($missing.Count -gt 0) {
        throw "$Label model is incomplete at $Root. Missing: $($missing -join ', ')"
    }
}

function Get-HandoffPayloadFiles([string]$PortableRoot) {
    $portableRootPath = Normalize-FullPath $PortableRoot
    $files = @()
    foreach ($name in @($PortableAppExeName, "START_HERE.txt")) {
        $path = Join-Path $PortableRoot $name
        if (Test-Path -LiteralPath $path) {
            $files += [ordered]@{
                path = $name
                sha256 = Get-FileHashValue $path
                bytes = (Get-Item -LiteralPath $path).Length
            }
        }
    }

    foreach ($folder in @("binaries", "backend", "runtime")) {
        $root = Join-Path $PortableRoot $folder
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }
        Get-ChildItem -LiteralPath $root -File -Recurse -Force |
            Sort-Object FullName |
            ForEach-Object {
                $fullPath = Normalize-FullPath $_.FullName
                $relativePath = $fullPath.Substring($portableRootPath.Length).TrimStart("\", "/")
                $relativeParts = $relativePath -split '[\\/]'
                if ($relativeParts -contains "__pycache__") {
                    return
                }
                if ($_.Name -like "*.pyc") {
                    return
                }
                if ($relativeParts.Length -ge 2 -and $relativeParts[0].Equals("backend", [System.StringComparison]::OrdinalIgnoreCase) -and $relativeParts[1] -in @("outputs", "temp", "logs")) {
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

function ConvertFrom-Utf8Base64([string]$Value) {
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Copy-HandoffTree([string]$Source, [string]$Destination, [string[]]$IncludedModelDirs, [string[]]$ExcludedModelDirs) {
    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Portable source folder missing: $Source"
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $sourceRoot = Normalize-FullPath $Source
    $included = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $IncludedModelDirs) { [void]$included.Add($name) }
    $excluded = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $ExcludedModelDirs) { [void]$excluded.Add($name) }

    Get-ChildItem -LiteralPath $Source -Recurse -Force | ForEach-Object {
        $fullPath = Normalize-FullPath $_.FullName
        $relativePath = $fullPath.Substring($sourceRoot.Length).TrimStart("\", "/")
        if (-not $relativePath) {
            return
        }
        $relativeParts = $relativePath -split '[\\/]'

        if ($relativeParts -contains "__pycache__") {
            return
        }
        if (-not $_.PSIsContainer -and $_.Name -like "*.pyc") {
            return
        }
        if ($relativeParts.Length -ge 2 -and $relativeParts[0].Equals("backend", [System.StringComparison]::OrdinalIgnoreCase) -and $relativeParts[1] -in @("outputs", "temp", "logs")) {
            return
        }
        if ($relativeParts.Length -ge 2 -and $relativeParts[0].Equals("models", [System.StringComparison]::OrdinalIgnoreCase)) {
            $modelDirName = $relativeParts[1]
            if ($excluded.Contains($modelDirName)) {
                return
            }
            if ($relativeParts.Length -gt 1 -and -not $included.Contains($modelDirName)) {
                return
            }
            if ($relativeParts -contains ".git" -or $relativeParts -contains ".cache") {
                return
            }
            if (-not $_.PSIsContainer -and $_.Name -like "*.lock") {
                return
            }
        }
        if ($relativeParts.Length -eq 2 -and $relativeParts[0].Equals("models", [System.StringComparison]::OrdinalIgnoreCase) -and $_.Name.Equals("README.txt", [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }

        $targetPath = Join-Path $Destination $relativePath
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
            return
        }

        New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $targetPath -Force
    }
}

function Write-HandoffReadmes([string]$PortableRoot, [object[]]$IncludedModels, [object[]]$ExcludedModels) {
    $modelsDir = Join-Path $PortableRoot "models"
    New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

    $includedLines = @($IncludedModels | ForEach-Object { "- models\$($_.portableDir)" }) -join "`r`n"
    $excludedLines = @($ExcludedModels | ForEach-Object { "- models\$($_.portableDir)" }) -join "`r`n"
    $modelsReadme = ConvertFrom-Utf8Base64 "TE1PIO2ajOydmCDsnbjsgqzsnbTtirgg66qo6424IO2PtOuNlAoK7J20IOyKrOumvCDsoITri6zrs7jsl5DripQg7J6R7J2AIOywuOyEneyekCDqtazrtoQg66qo64247J20IOydtOuvuCDtj6ztlajrkJjslrQg7J6I7Iq164uI64ukOgokaW5jbHVkZWRMaW5lcwoK7YGwIOydjOyEsSDsnbjsi50g66qo64247J2AIOyaqeufiSDrlYzrrLjsl5Ag7KCc7Jm465CY7Ja0IOyeiOyKteuLiOuLpDoKJGV4Y2x1ZGVkTGluZXMKCuyLpOygnCDrjIDtmZTroZ0g7J6R7ISx7J2EIOyLpO2Wie2VmOq4sCDsoITsl5Ag6rSA66as7J6Q6rCAIOykgOu5hO2VnCBmYXN0ZXItd2hpc3Blci1sYXJnZS12MyDrqqjrjbgg66y27J2M7J2EIOyVhOuemCDsnITsuZjsl5Ag64Sj7Ja0IOyjvOyEuOyalDoKbW9kZWxzXGZhc3Rlci13aGlzcGVyLWxhcmdlLXYzCgrtmZXsnbjtlaAg7YyM7J28OgotIG1vZGVsc1xmYXN0ZXItd2hpc3Blci1sYXJnZS12M1xtb2RlbC5iaW4KLSBtb2RlbHNcZmFzdGVyLXdoaXNwZXItbGFyZ2UtdjNcdG9rZW5pemVyLmpzb24KLSBtb2RlbHNcZmFzdGVyLXdoaXNwZXItbGFyZ2UtdjNcY29uZmlnLmpzb24KCk9sbGFtYSDsoJXrpqwg66qo64247J2AIOyVseydmCDsi5zsiqTthZwg7ISk7KCVID4g66qo6424IO2ZlOuptOyXkOyEnCBPbGxhbWEg7ISk7LmYIO2bhCDrsJvsnYQg7IiYIOyeiOyKteuLiOuLpC4K"
    $modelsReadme = $modelsReadme.Replace('$includedLines', $includedLines).Replace('$excludedLines', $excludedLines)
    $modelsReadme += ConvertFrom-Utf8Base64 "DQrtmozsgqwg67O07JWIIOuYkOuKlCDsnbjthLDrhLcg7LCo64uo7Jy866GcIOuqqOuNuCDrsJvquLDqsIAg7Iuk7Yyo7ZWY66m0IOyCrOuCtCDri7Tri7nsnpDsl5Dqsowg66qo6424IO2MjOydvCDspIDruYTrpbwg7JqU7LKt7ZW0IOyjvOyEuOyalC4NCuyXsOudveyymDogMjAyNy0wMy0zMeq5jOyngCBlY29tYXJpbmVAa29yZWEua3IsIDIwMjctMDQtMDHrtoDthLAgZWNvbWFyaW5AbmF2ZXIuY29tDQo="
    [System.IO.File]::WriteAllText(
        (Join-Path $modelsDir "README.txt"),
        $modelsReadme,
        [System.Text.UTF8Encoding]::new($false)
    )

    $topLevelReadme = ConvertFrom-Utf8Base64 "TE1PIO2ajOydmCDsnbjsgqzsnbTtirggLSDsiqzrprwg7KCE64us67O4CgoxLiDsi6TtlokKICAgLSDsnbQg7Y+0642UIOyViOydmCBsbW9fYXVkaW8uZXhl66W8IOyLpO2Wie2VqeuLiOuLpC4KICAgLSBleGXrp4wg65Sw66GcIOyYruq4sOyngCDrp5Dqs6AgbG1vX2F1ZGlvIO2PtOuNlCDsoITssrTrpbwg7ZWo6ruYIOyYruq4sOyEuOyalC4KCjIuIOydtOuvuCDtj6ztlajrkJwg6rKDCiAgIC0g7JWxIOyLpO2WiSDtjIzsnbwsIOu2hOyEnSDrsLHsl5Trk5wsIOyLpO2WiSDsnZjsobQg7YyM7J28CiAgIC0g7LC47ISd7J6QIOq1rOu2hCDrqqjrjbg6IG1vZGVsc1xzcGVha2VyLWRpYXJpemF0aW9uLWNvbW11bml0eS0xCgozLiDstpTqsIDroZwg7ZWE7JqU7ZWcIOqygwogICAtIOydjOyEsSDsnbjsi50g66qo6424OiBtb2RlbHNcZmFzdGVyLXdoaXNwZXItbGFyZ2UtdjMKICAgLSDsnbQg7YGwIOuqqOuNuOydgCB6aXAg7Jqp65+J7J2EIOykhOydtOq4sCDsnITtlbQg7J2867aA65+sIOygnOyZuO2WiOyKteuLiOuLpC4KICAgLSDsi6TsoJwg64yA7ZmU66GdIOyekeyEsSDsoITsl5Ag6rSA66as7J6Q6rCAIOykgOu5hO2VnCDrqqjrjbgg66y27J2M7J2EIO2VtOuLuSDtj7TrjZTsl5Ag64Sj7Ja0IOyjvOyEuOyalC4KCjQuIO2ajOydmCDsmpTslb0g66qo6424CiAgIC0g7JWx7J2YIOyLnOyKpO2FnCDshKTsoJUgPiDrqqjrjbgg7ZmU66m07JeQ7IScIE9sbGFtYSDshKTsuZgg66eB7YGs66W8IOyXtOqzoCDshKTsuZjtlanri4jri6QuCiAgIC0g7ISk7LmYIO2bhCDqtozsnqUg7JqU7JW9IOuqqOuNuOydhCDslbHsl5DshJwg67Cb7Iq164uI64ukLgoKNS4g66y47KCc6rCAIOyeiOycvOuptAogICAtIOuovOyggCDslbEg7ISk7KCV7JeQ7IScIOuqqOuNuCDsg4Htg5zrpbwg7ZmV7J247ZWp64uI64ukLgogICAtIOydjOyEsSDsnbjsi50g66qo64247J2EIOuzteyCrO2VnCDrkqTsl5DripQg7IOB7YOcIOyDiOuhnOqzoOy5qOydhCDriITrpbTqsbDrgpgg7JWx7J2EIOuLpOyLnCDsi6Ttlontlanri4jri6QuCg=="
    $topLevelReadme += ConvertFrom-Utf8Base64 "DQrtmozsgqwg67O07JWIIOuYkOuKlCDsnbjthLDrhLcg7LCo64uo7Jy866GcIOyEpOy5mCDtjpjsnbTsp4Drgpgg66qo6424IOuwm+q4sOqwgCDsi6TtjKjtlZjrqbQg7IKs64K0IOuLtOuLueyekOyXkOqyjCDrqqjrjbgg7KSA67mE66W8IOyalOyyre2VtCDso7zshLjsmpQuDQrsl7Drnb3sspg6IDIwMjctMDMtMzHquYzsp4AgZWNvbWFyaW5lQGtvcmVhLmtyLCAyMDI3LTA0LTAx67aA7YSwIGVjb21hcmluQG5hdmVyLmNvbQ0K"
    [System.IO.File]::WriteAllText(
        (Join-Path $PortableRoot "START_HERE.txt"),
        $topLevelReadme,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Update-HandoffManifest([string]$PortableRoot, [object[]]$IncludedModels, [object[]]$ExcludedModels) {
    $manifestPath = Join-Path $PortableRoot "release-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        throw "Release manifest missing: $manifestPath"
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if (($manifest.PSObject.Properties.Name -contains "dirty") -and [bool]$manifest.dirty -and -not $AllowDirty) {
        throw "Refusing to package a dirty release manifest. Rebuild cleanly or pass -AllowDirty for local testing."
    }

    $excludedPrefixes = @($ExcludedModels | ForEach-Object { "models\$($_.portableDir)\" })
    foreach ($marker in @($manifest.modelMarkers)) {
        foreach ($prefix in $excludedPrefixes) {
            if ([string]$marker.path -like "$prefix*") {
                $marker.exists = $false
                $marker.bytes = $null
                $marker | Add-Member -NotePropertyName excludedFromHandoff -NotePropertyValue $true -Force
            }
        }
    }

    $manifest | Add-Member -NotePropertyName handoff -NotePropertyValue ([ordered]@{
        packageFormat = "lmo-audio-slim-handoff-v1"
        excludedModels = @($ExcludedModels | ForEach-Object { $_.portableDir })
        includedModels = @($IncludedModels | ForEach-Object { $_.portableDir })
        note = "This handoff zip excludes the large speech recognition model but includes the speaker diarization model."
    }) -Force

    if ($manifest.files -and ($manifest.files.PSObject.Properties.Name -contains "startHere")) {
        $startHere = Join-Path $PortableRoot "START_HERE.txt"
        $manifest.files.startHere.sha256 = Get-FileHashValue $startHere
    }
    if ($manifest.PSObject.Properties.Name -contains "portablePayloadFiles") {
        $manifest.portablePayloadFiles = @(Get-HandoffPayloadFiles $PortableRoot)
    }
    else {
        $manifest | Add-Member -NotePropertyName portablePayloadFiles -NotePropertyValue @(Get-HandoffPayloadFiles $PortableRoot)
    }

    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}

function Test-HandoffPackage([string]$PortableRoot, [string]$ZipPath, [object[]]$IncludedModels, [object[]]$ExcludedModels) {
    foreach ($model in @($IncludedModels)) {
        $modelDir = Join-Path (Join-Path $PortableRoot "models") ([string]$model.portableDir)
        Test-RequiredMarkers $modelDir @($model.requiredMarkers) ([string]$model.label)
    }
    foreach ($model in @($ExcludedModels)) {
        $modelDir = Join-Path (Join-Path $PortableRoot "models") ([string]$model.portableDir)
        if (Test-Path -LiteralPath $modelDir) {
            throw "Excluded model is still present in handoff staging folder: $modelDir"
        }
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            [void]$entries.Add($entry.FullName.Replace("/", "\"))
        }
        foreach ($model in @($IncludedModels)) {
            foreach ($marker in @($model.requiredMarkers)) {
                $entryPath = "lmo_audio\models\$($model.portableDir)\$($marker.Replace('/', '\'))"
                if (-not $entries.Contains($entryPath)) {
                    throw "Handoff zip is missing included model marker: $entryPath"
                }
            }
        }
        foreach ($model in @($ExcludedModels)) {
            foreach ($marker in @($model.requiredMarkers)) {
                $entryPath = "lmo_audio\models\$($model.portableDir)\$($marker.Replace('/', '\'))"
                if ($entries.Contains($entryPath)) {
                    throw "Handoff zip includes excluded model marker: $entryPath"
                }
            }
        }
    }
    finally {
        $zip.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $ModelLayoutFile)) {
    throw "Portable model layout missing: $ModelLayoutFile"
}

$portablePath = Assert-SafePortablePath (Resolve-InRepoPath $PortableDir)
$outputPath = Assert-SafeOutputPath (Resolve-InRepoPath $OutputRoot)
$modelLayout = Get-Content -LiteralPath $ModelLayoutFile -Raw | ConvertFrom-Json
$includedModels = @($modelLayout.models | Where-Object { [string]$_.role -eq "diarization" })
$excludedModels = @($modelLayout.models | Where-Object { [string]$_.role -eq "default_stt" })
if ($includedModels.Count -eq 0) {
    throw "No included models were found. Expected the speaker diarization model to remain in the handoff package."
}
if ($excludedModels.Count -eq 0) {
    throw "No excluded default STT model was found. Expected faster-whisper-large-v3 to be excluded from the handoff package."
}

$commitLabel = "unknown"
$manifestPath = Join-Path $portablePath "release-manifest.json"
if (Test-Path -LiteralPath $manifestPath) {
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.commit) {
            $commitLabel = ([string]$manifest.commit).Substring(0, [Math]::Min(7, ([string]$manifest.commit).Length))
        }
    }
    catch {
        $commitLabel = "unknown"
    }
}

if (-not $PackageName) {
    $PackageName = "lmo_audio_no_whisper_$commitLabel"
}
$PackageName = $PackageName.Trim()
if ([string]::IsNullOrWhiteSpace($PackageName) -or $PackageName -in @(".", "..")) {
    throw "PackageName must be a concrete child file name."
}
if ($PackageName -match '[\\/:*?"<>|]') {
    throw "PackageName contains invalid path characters: $PackageName"
}

if (-not $AllowStale) {
    $commit = "unknown"
    if (Test-Path -LiteralPath $manifestPath) {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.commit) {
            $commit = [string]$manifest.commit
        }
    }
    if ([string]::IsNullOrWhiteSpace($commit) -or $commit -eq "unknown") {
        throw "Release manifest does not include a commit. Rebuild cleanly or pass -AllowStale for local testing."
    }
    $headCommit = Get-GitValue @("rev-parse", "HEAD")
    if (-not $commit.Equals($headCommit, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable release commit ($commit) does not match current HEAD ($headCommit). Rebuild first or pass -AllowStale for local testing."
    }
}

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$stagingRoot = Assert-SafeChildPath $outputPath (Join-Path $outputPath ".staging\$PackageName")
$stagingPortable = Join-Path $stagingRoot "lmo_audio"
$zipPath = Assert-SafeChildPath $outputPath (Join-Path $outputPath "$PackageName.zip")

if ((Test-Path -LiteralPath $stagingRoot) -or (Test-Path -LiteralPath $zipPath)) {
    if (-not $Force) {
        throw "Handoff package already exists. Pass -Force to replace: $PackageName"
    }
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
}

New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
Copy-HandoffTree `
    -Source $portablePath `
    -Destination $stagingPortable `
    -IncludedModelDirs @($includedModels | ForEach-Object { [string]$_.portableDir }) `
    -ExcludedModelDirs @($excludedModels | ForEach-Object { [string]$_.portableDir })
Write-HandoffReadmes $stagingPortable $includedModels $excludedModels
Update-HandoffManifest $stagingPortable $includedModels $excludedModels

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingRoot, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Test-HandoffPackage $stagingPortable $zipPath $includedModels $excludedModels

Remove-Item -LiteralPath $stagingRoot -Recurse -Force

Write-Host "Created slim handoff package:"
Write-Host $zipPath
