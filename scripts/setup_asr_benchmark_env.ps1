param(
    [ValidateSet("faster-whisper", "qwen3-asr")]
    [string]$Engine = "qwen3-asr",
    [string]$Python = "py -3.12",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if ($Engine -eq "faster-whisper") {
    $venv = Join-Path $root "backend\.venv-asr-faster-whisper"
    $packages = @("faster-whisper", "huggingface-hub")
} else {
    $venv = Join-Path $root "backend\.venv-asr-qwen3"
    $packages = @("qwen-asr", "huggingface-hub", "soundfile")
}

if ($Force -and (Test-Path -LiteralPath $venv)) {
    Remove-Item -LiteralPath $venv -Recurse -Force
}

if (!(Test-Path -LiteralPath $venv)) {
    Invoke-Expression "$Python -m venv `"$venv`""
}

$pythonExe = Join-Path $venv "Scripts\python.exe"
& $pythonExe -m pip install --upgrade pip
& $pythonExe -m pip install @packages

Write-Host "ASR benchmark environment ready: $venv"
Write-Host "Python: $pythonExe"
