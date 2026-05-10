param(
    [int]$Port = 17863
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend"
$python = Join-Path $backendDir ".venv\Scripts\python.exe"
$expectedBackendDir = [System.IO.Path]::GetFullPath($backendDir).TrimEnd("\")
$expectedPython = [System.IO.Path]::GetFullPath($python)

if (!(Test-Path -LiteralPath $python)) {
    throw "Backend virtual environment is missing: $python"
}

& $python -c "import fastapi, uvicorn, faster_whisper; print('backend runtime ok')"

$existingByCommand = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -eq "python.exe" -and
        $_.CommandLine -match "uvicorn main:app" -and
        $_.CommandLine -match "--port $Port"
    }

$existingByPort = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ }

$processIds = @($existingByCommand | Select-Object -ExpandProperty ProcessId) + @($existingByPort)
$processIds = $processIds | Sort-Object -Unique

foreach ($processId in $processIds) {
    Stop-Process -Id $processId -Force
}

$process = Start-Process `
    -FilePath $python `
    -ArgumentList @("-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "$Port") `
    -WorkingDirectory $backendDir `
    -WindowStyle Hidden `
    -PassThru

for ($i = 0; $i -lt 30; $i += 1) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        $healthBackendDir = [System.IO.Path]::GetFullPath([string]$health.backend_dir).TrimEnd("\")
        $healthPython = [System.IO.Path]::GetFullPath([string]$health.python_executable)
        if ($health.ok -and $healthBackendDir -eq $expectedBackendDir -and $healthPython -eq $expectedPython) {
            Write-Host "Backend started on http://127.0.0.1:$Port"
            exit 0
        }
    } catch {
        # keep waiting
    }
}

if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}

throw "Backend did not become healthy on port $Port with expected runtime: $expectedPython"
