param(
    [string]$VenvDir = "C:\tmp\lmo-llama-venv",
    [string]$Python = "python",
    [switch]$SkipLongPathCheck
)

$ErrorActionPreference = "Stop"

$resolvedVenv = [System.IO.Path]::GetFullPath($VenvDir)
if (-not $resolvedVenv.StartsWith("C:\tmp\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Use a short path under C:\tmp for llama-cpp-python to avoid Windows long path install failures: $resolvedVenv"
}

if (-not $SkipLongPathCheck) {
    $longPathValue = $null
    try {
        $longPathValue = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled").LongPathsEnabled
    } catch {
        throw "Could not read Windows LongPathsEnabled. Run PowerShell as administrator or pass -SkipLongPathCheck after confirming long paths are enabled."
    }

    if ($longPathValue -ne 1) {
        throw "Windows LongPathsEnabled is $longPathValue. llama-cpp-python source installs fail on this PC until Windows long paths are enabled by an administrator."
    }
}

function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments)

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

$shortTemp = "C:\tmp\lmo-pip-temp"
New-Item -ItemType Directory -Force -Path $shortTemp | Out-Null
$env:TEMP = $shortTemp
$env:TMP = $shortTemp

Invoke-Native $Python @("-m", "venv", $resolvedVenv)
$venvPython = Join-Path $resolvedVenv "Scripts\python.exe"
Invoke-Native $venvPython @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Native $venvPython @(
    "-m",
    "pip",
    "install",
    "--no-cache-dir",
    "-r",
    (Join-Path (Split-Path -Parent $PSScriptRoot) "backend\requirements-llama.txt")
)
Invoke-Native $venvPython @("-c", "from llama_cpp import Llama; print('llama_cpp import ok')")

Write-Host "llama-cpp-python environment is ready:"
Write-Host $resolvedVenv
