param(
    [string]$PortableDir = "desktop-app\src-tauri\target\release\portable\Smart Minutes AI",
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

function Stop-PortableProcesses([string]$PortableRoot) {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Path -and (
                $_.Path.StartsWith($PortableRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
                $_.ProcessName -like "meeting-backend*"
            )
        } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

$script:Results = @()
$script:Failed = $false

$portablePath = Resolve-InRepoPath $PortableDir
$appExe = Join-Path $portablePath "Smart Minutes AI.exe"
$sidecarExe = Join-Path $portablePath "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
$backendDir = Join-Path $portablePath "backend"
$ffmpegExe = Join-Path $backendDir "ffmpeg.exe"
$modelsDir = Join-Path $portablePath "models"
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
    $appProcess = Start-Process -FilePath $appExe -WorkingDirectory $portablePath -PassThru
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        $backendProcess = Get-Process meeting-backend* -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.StartsWith($portablePath, [System.StringComparison]::OrdinalIgnoreCase) } |
            Select-Object -First 1

        if ($backendProcess) {
            $connection = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.OwningProcess -eq $backendProcess.Id } |
                Select-Object -First 1
            if ($connection) {
                $backendPort = $connection.LocalPort
                break
            }
        }

        Start-Sleep -Seconds 3
    }

    Add-Result "sidecar process listens" ($null -ne $backendPort) $(if ($backendPort) { "port $backendPort" } else { "no listen port found" })

    if ($backendPort) {
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
    }
}
catch {
    Add-Result "runtime smoke test" $false $_.Exception.Message
}
finally {
    Stop-PortableProcesses $portablePath
    if ($appProcess -and -not $appProcess.HasExited) {
        Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
    }
}

$Results | Format-Table -AutoSize

if ($Failed) {
    throw "Portable verification failed."
}

Write-Host "Portable verification passed." -ForegroundColor Green
