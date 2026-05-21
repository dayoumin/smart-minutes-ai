param(
    [string]$PortableDir = "releases\lmo_audio",
    [int]$TimeoutSeconds = 240,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
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

function Assert-SafePortablePath([string]$Path) {
    $resolvedPath = Normalize-FullPath $Path
    $repoRootPath = Normalize-FullPath $RepoRoot.Path
    $parentRepoPath = Normalize-FullPath (Split-Path -Parent $repoRootPath)

    foreach ($unsafePath in @($repoRootPath, $parentRepoPath, (Join-Path $repoRootPath "desktop-app"), (Join-Path $repoRootPath "releases"))) {
        $unsafeFullPath = Normalize-FullPath $unsafePath
        if ($resolvedPath.Equals($unsafeFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe PortableDir points to a project, parent, or broad release directory: $resolvedPath"
        }
    }

    if (-not (Split-Path -Leaf $resolvedPath).Equals("lmo_audio", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe PortableDir must point to the lmo_audio folder itself: $resolvedPath"
    }

    foreach ($child in @("backend", "binaries", "models")) {
        $childPath = Normalize-FullPath (Join-Path $resolvedPath $child)
        if (-not $childPath.StartsWith($resolvedPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe PortableDir child path escaped portable root: $childPath"
        }
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

function Get-PeSubsystem([string]$Path) {
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $buffer = New-Object byte[] 4096
        [void]$fs.Read($buffer, 0, $buffer.Length)
        $peOffset = [BitConverter]::ToInt32($buffer, 0x3c)
        $subsystemOffset = $peOffset + 24 + 68
        $subsystem = [BitConverter]::ToUInt16($buffer, $subsystemOffset)
        if ($subsystem -eq 2) { return "Windows GUI" }
        if ($subsystem -eq 3) { return "Windows Console" }
        return "Other $subsystem"
    }
    finally {
        $fs.Dispose()
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

function Get-ZipMissingEntries([string]$Path, [string[]]$RequiredEntries) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

    $zip = $null
    try {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
        $entrySet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            [void]$entrySet.Add($entry.FullName.Replace("/", "\"))
        }

        $missing = @()
        foreach ($requiredEntry in $RequiredEntries) {
            $normalized = $requiredEntry.Replace("/", "\")
            if (-not $entrySet.Contains($normalized)) {
                $missing += $requiredEntry
            }
        }
        return $missing
    }
    catch {
        return @("invalid zip: $($_.Exception.Message)")
    }
    finally {
        if ($zip) {
            $zip.Dispose()
        }
    }
}

function Test-ReleaseManifest([string]$PortableRoot, [string]$ManifestPath, [bool]$AllowDirtyManifest) {
    if (-not (Test-Path -LiteralPath $ManifestPath)) {
        Add-Result "manifest hash check" $false "manifest missing"
        return
    }

    try {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    }
    catch {
        Add-Result "manifest hash check" $false "manifest parse failed: $($_.Exception.Message)"
        return
    }

    if ($manifest.PSObject.Properties.Name -contains "dirty") {
        Add-Result "manifest clean" ((-not [bool]$manifest.dirty) -or $AllowDirtyManifest) "dirty=$($manifest.dirty)"
    }

    $mismatches = @()
    foreach ($entry in $manifest.files.PSObject.Properties) {
        $relativePath = [string]$entry.Value.path
        $expectedHash = [string]$entry.Value.sha256
        $fullPath = Join-Path $PortableRoot $relativePath
        $actualHash = Get-FileHashValue $fullPath
        if (-not $actualHash) {
            $mismatches += "$relativePath missing"
        }
        elseif ($expectedHash -and $actualHash -ne $expectedHash) {
            $mismatches += "$relativePath hash mismatch"
        }
    }

    if ($manifest.modelMarkers) {
        foreach ($marker in $manifest.modelMarkers) {
            $fullPath = Join-Path $PortableRoot ([string]$marker.path)
            $exists = Test-Path -LiteralPath $fullPath
            if ([bool]$marker.exists -ne $exists) {
                $mismatches += "$($marker.path) existence mismatch"
                continue
            }
            if ($exists -and $null -ne $marker.bytes) {
                $actualBytes = (Get-Item -LiteralPath $fullPath).Length
                if ([int64]$marker.bytes -ne [int64]$actualBytes) {
                    $mismatches += "$($marker.path) size mismatch"
                }
            }
        }
    }

    Add-Result "manifest hash check" ($mismatches.Count -eq 0) ($mismatches -join "; ")
}

function Test-CleanPortableSurface([string]$PortableRoot) {
    $allowedRootNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @($PortableAppExeName, "release-manifest.json", "START_HERE.txt", "backend", "binaries", "models")) {
        $null = $allowedRootNames.Add($name)
    }

    $unexpectedRootEntries = @()
    foreach ($entry in Get-ChildItem -LiteralPath $PortableRoot -Force) {
        if (-not $allowedRootNames.Contains($entry.Name)) {
            $unexpectedRootEntries += $entry.Name
        }
    }
    Add-Result "portable root clean" ($unexpectedRootEntries.Count -eq 0) ($unexpectedRootEntries -join ", ")

    $runtimePaths = @(
        "backend\outputs",
        "backend\temp",
        "backend\logs",
        "backend\__pycache__"
    )
    $presentRuntimePaths = @(
        foreach ($relativePath in $runtimePaths) {
            if (Test-Path -LiteralPath (Join-Path $PortableRoot $relativePath)) {
                $relativePath
            }
        }
    )
    Add-Result "runtime folders excluded" ($presentRuntimePaths.Count -eq 0) ($presentRuntimePaths -join ", ")
}

function Stop-PortableProcesses([string]$PortableRoot) {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Path -and $_.Path.StartsWith($PortableRoot, [System.StringComparison]::OrdinalIgnoreCase)
        } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

function Test-PortAvailable([int]$Port) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($listener) {
            $listener.Stop()
        }
    }
}

function Get-AvailableBackendPort([int]$StartPort = 17863, [int]$Attempts = 100) {
    for ($offset = 0; $offset -lt $Attempts; $offset += 1) {
        $candidate = $StartPort + $offset
        if (Test-PortAvailable $candidate) {
            return $candidate
        }
    }
    throw "No available backend port found from $StartPort to $($StartPort + $Attempts - 1)."
}

function Start-BackendSidecar([string]$ExePath, [string]$BackendRoot, [int]$Port, [string]$Arguments = "") {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $ExePath
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $BackendRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    $envValues = @{
        MEETING_AI_BACKEND_DIR = $BackendRoot
        ANALYSIS_MODE = "real"
        PORT = [string]$Port
    }

    $previousEnv = @{}
    foreach ($key in $envValues.Keys) {
        $previousEnv[$key] = [System.Environment]::GetEnvironmentVariable($key, "Process")
        [System.Environment]::SetEnvironmentVariable($key, $envValues[$key], "Process")
    }

    try {
        return [System.Diagnostics.Process]::Start($startInfo)
    }
    finally {
        foreach ($key in $envValues.Keys) {
            [System.Environment]::SetEnvironmentVariable($key, $previousEnv[$key], "Process")
        }
    }
}

function Test-BackendHealth([string]$BaseUrl) {
    try {
        $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 5
        if ($health.ok -eq $true -and $health.service -eq "NIFS AI Meeting API") {
            return $health
        }
    }
    catch {
        return $null
    }

    return $null
}

$script:Results = @()
$script:Failed = $false

$PortableAppExeName = "lmo_audio.exe"
$portablePath = Assert-SafePortablePath (Resolve-InRepoPath $PortableDir)
$runtimeRequestTimeoutSeconds = [Math]::Max(60, [Math]::Min($TimeoutSeconds, 180))
$appExe = Join-Path $portablePath $PortableAppExeName
$sidecarExe = Join-Path $portablePath "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
$backendDir = Join-Path $portablePath "backend"
$backendConfigFile = Join-Path $backendDir "config.json"
$ffmpegExe = Join-Path $backendDir "ffmpeg.exe"
$modelsDir = Join-Path $portablePath "models"
$manifestFile = Join-Path $portablePath "release-manifest.json"

Add-Result "portable folder exists" (Test-Path -LiteralPath $portablePath) $portablePath
Add-Result "app exe exists" (Test-Path -LiteralPath $appExe) $appExe
Add-Result "sidecar exe exists" (Test-Path -LiteralPath $sidecarExe) $sidecarExe
Add-Result "backend folder exists" (Test-Path -LiteralPath $backendDir) $backendDir
Add-Result "root models folder exists" (Test-Path -LiteralPath $modelsDir) $modelsDir
Add-Result "ffmpeg exists" (Test-Path -LiteralPath $ffmpegExe) $ffmpegExe
Add-Result "release manifest exists" (Test-Path -LiteralPath $manifestFile) $manifestFile
Test-CleanPortableSurface $portablePath
Test-ReleaseManifest $portablePath $manifestFile ([bool]$AllowDirty)
foreach ($model in @($ModelLayout.models)) {
    $modelDir = Join-Path $modelsDir ([string]$model.portableDir)
    $missingMarkers = @(
        foreach ($marker in @($model.requiredMarkers)) {
            $markerPath = Join-Path $modelDir ([string]$marker)
            if (-not (Test-Path -LiteralPath $markerPath)) {
                [string]$marker
            }
        }
    )
    Add-Result "$($model.label) model layout" ($missingMarkers.Count -eq 0) $(if ($missingMarkers.Count -eq 0) { $modelDir } else { "missing=$($missingMarkers -join ', ')" })
}

if (Test-Path -LiteralPath $appExe) {
    $appSubsystem = Get-PeSubsystem $appExe
    Add-Result "app exe subsystem" ($appSubsystem -eq "Windows GUI") $appSubsystem
}

if (Test-Path -LiteralPath $sidecarExe) {
    $sidecarSubsystem = Get-PeSubsystem $sidecarExe
    Add-Result "sidecar exe subsystem" ($sidecarSubsystem -eq "Windows GUI") $sidecarSubsystem
}

Stop-PortableProcesses $portablePath
Start-Sleep -Seconds 1

$appProcess = $null
$backendProcess = $null
$backendPort = $null

try {
    $backendPort = Get-AvailableBackendPort
    $backendProcess = Start-BackendSidecar $sidecarExe $backendDir $backendPort
    $baseUrl = "http://127.0.0.1:$backendPort"
    $health = $null
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        $backendProcess.Refresh()
        if ($backendProcess.HasExited) {
            Add-Result "sidecar process running" $false "exited with code $($backendProcess.ExitCode)"
            break
        }

        $health = Test-BackendHealth $baseUrl
        if ($null -ne $health) {
            break
        }

        Start-Sleep -Seconds 3
    }

    $responding = $false
    if ($backendProcess -and -not $backendProcess.HasExited -and $null -eq $health) {
        $health = Test-BackendHealth $baseUrl
    }
    $responding = $null -ne $health
    Add-Result "sidecar health responds" $responding $(if ($responding) { "port $backendPort" } else { "no health response" })

    if ($responding) {
        Add-Result "health endpoint" ($health.ok -eq $true -and $health.service -eq "NIFS AI Meeting API") ($health | ConvertTo-Json -Compress)

        $settings = Invoke-RestMethod -Uri "$baseUrl/api/settings" -TimeoutSec 5
        Add-Result "settings endpoint" ($null -ne $settings) "analysis_mode=$($settings.analysis_mode)"

        $models = Invoke-RestMethod -Uri "$baseUrl/api/models/status" -TimeoutSec $runtimeRequestTimeoutSeconds
        $missingRequired = @($models.models | Where-Object { $_.required -and -not $_.installed } | Select-Object -ExpandProperty label)
        Add-Result "models endpoint" ($null -ne $models.models) "ready=$($models.ready); missing=$($missingRequired -join ', ')"
        Add-Result "required models ready" ($models.ready -eq $true) "selected=$($models.selected_stt_model); missing=$($missingRequired -join ', ')"

        $previousSttModel = $settings.stt.selected_model
        if (-not $previousSttModel) {
            $previousSttModel = "faster-whisper-large-v3"
        }
        $originalBackendConfigBytes = if (Test-Path -LiteralPath $backendConfigFile) {
            [System.IO.File]::ReadAllBytes($backendConfigFile)
        } else {
            $null
        }
        try {
            $qwenLayoutKeys = @($ModelLayout.models | Where-Object { $_.key -in @("stt_qwen", "stt_qwen_aligner") } | Select-Object -ExpandProperty key)
            $qwenIncluded = $qwenLayoutKeys -contains "stt_qwen" -and $qwenLayoutKeys -contains "stt_qwen_aligner"
            if ($qwenIncluded) {
                $qwenBody = @{ stt = @{ selected_model = "qwen3-asr" } } | ConvertTo-Json -Depth 4
                Invoke-RestMethod -Uri "$baseUrl/api/settings" -Method Patch -ContentType "application/json" -Body $qwenBody -TimeoutSec 5 | Out-Null
                $qwenModels = Invoke-RestMethod -Uri "$baseUrl/api/models/status" -TimeoutSec $runtimeRequestTimeoutSeconds
                $qwenMissingRequired = @($qwenModels.models | Where-Object { $_.required -and -not $_.installed } | Select-Object -ExpandProperty label)
                $qwenRequiredKeys = @($qwenModels.models | Where-Object { $_.required } | Select-Object -ExpandProperty key)
                $qwenReady = (
                    $qwenModels.ready -eq $true -and
                    $qwenModels.selected_stt_model -eq "qwen3-asr" -and
                    $qwenRequiredKeys -contains "stt_qwen" -and
                    $qwenRequiredKeys -contains "stt_qwen_aligner"
                )
                Add-Result "Qwen selection ready" $qwenReady "selected=$($qwenModels.selected_stt_model); required=$($qwenRequiredKeys -join ', '); missing=$($qwenMissingRequired -join ', ')"
            }
            else {
                Add-Result "Qwen optional model omitted" $true "portable layout excludes Qwen ASR models"
            }
        }
        finally {
            $restoreBody = @{ stt = @{ selected_model = $previousSttModel } } | ConvertTo-Json -Depth 4
            Invoke-RestMethod -Uri "$baseUrl/api/settings" -Method Patch -ContentType "application/json" -Body $restoreBody -TimeoutSec 5 | Out-Null
            if ($null -ne $originalBackendConfigBytes) {
                [System.IO.File]::WriteAllBytes($backendConfigFile, $originalBackendConfigBytes)
            }
        }

        $smokeRecord = [ordered]@{
            id = "portable_verify_smoke"
            jobId = "portable_verify_smoke"
            title = "Portable verify smoke"
            date = (Get-Date).ToString("yyyy-MM-dd HH:mm")
            participants = "tester"
            sourceFile = "smoke.wav"
            summary = "Portable export smoke test."
            topics = @("release")
            actions = @("verify export")
            segments = @(
                [ordered]@{
                    start = "00:00:00"
                    end = "00:00:01"
                    speaker = "speaker01"
                    text = "portable export smoke"
                }
            )
        } | ConvertTo-Json -Depth 6

        $exportFailures = @()
        foreach ($kind in @("txt", "md", "docx", "hwpx")) {
            $smokeFile = Join-Path ([System.IO.Path]::GetTempPath()) "lmo-audio-export-smoke-$kind.tmp"
            try {
                Invoke-WebRequest -Uri "$baseUrl/api/export-record/$kind" -Method Post -ContentType "application/json; charset=utf-8" -Body $smokeRecord -OutFile $smokeFile -TimeoutSec 15
                if (-not (Test-Path -LiteralPath $smokeFile) -or (Get-Item -LiteralPath $smokeFile).Length -le 0) {
                    $exportFailures += "$kind empty response"
                }
                elseif ($kind -eq "docx") {
                    $missingEntries = @(Get-ZipMissingEntries $smokeFile @("[Content_Types].xml", "_rels/.rels", "word/document.xml"))
                    if ($missingEntries.Count -gt 0) {
                        $exportFailures += "$kind missing zip entries: $($missingEntries -join ', ')"
                    }
                }
                elseif ($kind -eq "hwpx") {
                    $missingEntries = @(Get-ZipMissingEntries $smokeFile @("mimetype", "META-INF/container.xml", "version.xml", "Contents/content.hpf", "Contents/section0.xml"))
                    if ($missingEntries.Count -gt 0) {
                        $exportFailures += "$kind missing zip entries: $($missingEntries -join ', ')"
                    }
                }
            }
            catch {
                $exportFailures += "$kind $($_.Exception.Message)"
            }
            finally {
                Remove-Item -LiteralPath $smokeFile -Force -ErrorAction SilentlyContinue
            }
        }
        Add-Result "export smoke" ($exportFailures.Count -eq 0) ($exportFailures -join "; ")

        try {
            Invoke-RestMethod -Uri "$baseUrl/api/outputs/portable_verify_smoke" -Method Delete -TimeoutSec 5 | Out-Null
        }
        catch {
            Add-Result "export smoke cleanup" $false $_.Exception.Message
        }
    }
}
catch {
    Add-Result "runtime smoke test" $false "$($_.Exception.Message) $($_.ScriptStackTrace)"
}
finally {
    if ($backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-PortableProcesses $portablePath
}

$Results | Format-Table -AutoSize

if ($Failed) {
    throw "Portable verification failed."
}

Write-Host "Portable verification passed." -ForegroundColor Green
