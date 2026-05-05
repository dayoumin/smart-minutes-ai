param(
    [string]$PortableDir = "Smart Minutes AI",
    [switch]$RequireCohere,
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"

function Resolve-InRepoPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return (Resolve-Path -LiteralPath $Path).Path
    }
    return (Resolve-Path -LiteralPath (Join-Path (Get-Location) $Path)).Path
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
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Test-ReleaseManifest([string]$PortableRoot, [string]$ManifestPath) {
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

function Start-BackendSidecar([string]$ExePath, [string]$BackendRoot, [int]$Port) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $ExePath
    $startInfo.WorkingDirectory = $BackendRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.Environment["MEETING_AI_BACKEND_DIR"] = $BackendRoot
    $startInfo.Environment["ANALYSIS_MODE"] = "real"
    $startInfo.Environment["PORT"] = [string]$Port
    return [System.Diagnostics.Process]::Start($startInfo)
}

$script:Results = @()
$script:Failed = $false

$portablePath = Resolve-InRepoPath $PortableDir
$appExe = Join-Path $portablePath "Smart Minutes AI.exe"
$sidecarExe = Join-Path $portablePath "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
$backendDir = Join-Path $portablePath "backend"
$ffmpegExe = Join-Path $backendDir "ffmpeg.exe"
$modelsDir = Join-Path $portablePath "models"
$manifestFile = Join-Path $portablePath "release-manifest.json"
$cohereModelFile = Join-Path $modelsDir "model.safetensors"
$cohereConfigFile = Join-Path $modelsDir "config.json"
$pyannoteConfigFile = Join-Path $modelsDir "config.yaml"
$pyannoteEmbeddingFile = Join-Path $modelsDir "embedding\pytorch_model.bin"

Add-Result "portable folder exists" (Test-Path -LiteralPath $portablePath) $portablePath
Add-Result "app exe exists" (Test-Path -LiteralPath $appExe) $appExe
Add-Result "sidecar exe exists" (Test-Path -LiteralPath $sidecarExe) $sidecarExe
Add-Result "backend folder exists" (Test-Path -LiteralPath $backendDir) $backendDir
Add-Result "root models folder exists" (Test-Path -LiteralPath $modelsDir) $modelsDir
Add-Result "ffmpeg exists" (Test-Path -LiteralPath $ffmpegExe) $ffmpegExe
Add-Result "release manifest exists" (Test-Path -LiteralPath $manifestFile) $manifestFile
Test-ReleaseManifest $portablePath $manifestFile
Add-Result "pyannote direct layout" ((Test-Path -LiteralPath $pyannoteConfigFile) -and (Test-Path -LiteralPath $pyannoteEmbeddingFile)) $modelsDir

if ($RequireCohere) {
    Add-Result "cohere direct layout" ((Test-Path -LiteralPath $cohereConfigFile) -and (Test-Path -LiteralPath $cohereModelFile)) $modelsDir
}
else {
    Add-Result "cohere direct location" $true $modelsDir
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
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        $backendProcess.Refresh()
        if ($backendProcess.HasExited) {
            Add-Result "sidecar process running" $false "exited with code $($backendProcess.ExitCode)"
            break
        }

        $connection = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $backendProcess.Id } |
            Select-Object -First 1
        if ($connection) {
            break
        }

        Start-Sleep -Seconds 3
    }

    $listening = $false
    if ($backendProcess -and -not $backendProcess.HasExited) {
        $listening = $null -ne (Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $backendProcess.Id } |
            Select-Object -First 1)
    }
    Add-Result "sidecar process listens" $listening $(if ($listening) { "port $backendPort" } else { "no listen port found" })

    if ($listening) {
        $baseUrl = "http://127.0.0.1:$backendPort"
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 5
        Add-Result "health endpoint" ($health.ok -eq $true -and $health.service -eq "NIFS AI Meeting API") ($health | ConvertTo-Json -Compress)

        $settings = Invoke-RestMethod -Uri "$baseUrl/api/settings" -TimeoutSec 5
        Add-Result "settings endpoint" ($null -ne $settings) "analysis_mode=$($settings.analysis_mode)"

        $models = Invoke-RestMethod -Uri "$baseUrl/api/models/status" -TimeoutSec 5
        $missingRequired = @($models.models | Where-Object { $_.required -and -not $_.installed } | Select-Object -ExpandProperty label)
        Add-Result "models endpoint" ($null -ne $models.models) "ready=$($models.ready); missing=$($missingRequired -join ', ')"
        if ($RequireCohere) {
            Add-Result "required models ready" ($models.ready -eq $true) "missing=$($missingRequired -join ', ')"
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
            $smokeFile = Join-Path ([System.IO.Path]::GetTempPath()) "smart-minutes-export-smoke-$kind.tmp"
            try {
                Invoke-WebRequest -Uri "$baseUrl/api/export-record/$kind" -Method Post -ContentType "application/json; charset=utf-8" -Body $smokeRecord -OutFile $smokeFile -TimeoutSec 15
                if (-not (Test-Path -LiteralPath $smokeFile) -or (Get-Item -LiteralPath $smokeFile).Length -le 0) {
                    $exportFailures += "$kind empty response"
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
    Add-Result "runtime smoke test" $false $_.Exception.Message
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
