param(
    [string]$Python,
    [string]$VenvPath = "backend\.venv-desktop",
    [switch]$SkipInstall,
    [switch]$RecreateBroken
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

function Resolve-InRepoPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
}

function Resolve-PythonCommand([string]$PythonCommand) {
    if ([string]::IsNullOrWhiteSpace($PythonCommand)) {
        foreach ($candidate in @("py -3.12", "py -3.11", "python")) {
            try {
                if ($candidate -eq "python") {
                    $null = & python --version 2>$null
                    if ($LASTEXITCODE -eq 0) {
                        return "python"
                    }
                    continue
                }
                $parts = $candidate -split " "
                $null = & $parts[0] $parts[1] --version 2>$null
                if ($LASTEXITCODE -eq 0) {
                    return $candidate
                }
            }
            catch {
                continue
            }
        }
        throw "No usable Python launcher found. Pass -Python <python.exe> explicitly."
    }

    if ($PythonCommand -match '[\\/]') {
        $resolvedPython = Resolve-InRepoPath $PythonCommand
        if (-not (Test-Path -LiteralPath $resolvedPython)) {
            throw "Python runtime not found: $resolvedPython"
        }
        return $resolvedPython
    }

    return $PythonCommand
}

function Invoke-PythonCommand([string]$PythonCommand, [string[]]$PythonArgs) {
    if ($PythonCommand -like "py -*") {
        $parts = $PythonCommand -split " "
        return & $parts[0] $parts[1] @PythonArgs
    }
    return & $PythonCommand @PythonArgs
}

function Assert-PythonRuntime([string]$PythonCommand) {
    $probeOutput = $null
    try {
        $probeOutput = Invoke-PythonCommand $PythonCommand -PythonArgs @("-c", "import sys; print(sys.executable)")
    }
    catch {
        throw "Python runtime is not usable: $PythonCommand. $($_.Exception.Message)"
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Python runtime probe failed: $PythonCommand"
    }

    Write-Host "Using base Python runtime: $probeOutput"
}

function Get-VenvStatus([string]$ResolvedVenvPath) {
    $status = [ordered]@{
        exists = Test-Path -LiteralPath $ResolvedVenvPath
        healthy = $false
        reason = ""
        pythonPath = Join-Path $ResolvedVenvPath "Scripts\python.exe"
        cfgPath = Join-Path $ResolvedVenvPath "pyvenv.cfg"
        basePython = $null
    }

    if (-not $status.exists) {
        $status.reason = "venv missing"
        return [pscustomobject]$status
    }

    if (-not (Test-Path -LiteralPath $status.cfgPath)) {
        $status.reason = "pyvenv.cfg missing"
        return [pscustomobject]$status
    }

    $cfgLines = Get-Content -LiteralPath $status.cfgPath
    foreach ($line in $cfgLines) {
        if ($line -match '^\s*executable\s*=\s*(.+?)\s*$') {
            $status.basePython = $matches[1].Trim()
            break
        }
        if ($line -match '^\s*home\s*=\s*(.+?)\s*$') {
            $status.basePython = (Join-Path $matches[1].Trim() "python.exe")
        }
    }

    if (-not (Test-Path -LiteralPath $status.pythonPath)) {
        $status.reason = "venv python missing"
        return [pscustomobject]$status
    }

    if ($status.basePython -and -not (Test-Path -LiteralPath $status.basePython)) {
        $status.reason = "base python missing: $($status.basePython)"
        return [pscustomobject]$status
    }

    try {
        $null = & $status.pythonPath -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -ne 0) {
            $status.reason = "venv python probe failed"
            return [pscustomobject]$status
        }
    }
    catch {
        $status.reason = $_.Exception.Message
        return [pscustomobject]$status
    }

    $status.healthy = $true
    $status.reason = "ok"
    return [pscustomobject]$status
}

function Assert-SafeVenvPath([string]$ResolvedVenvPath) {
    $repoRootPath = [System.IO.Path]::GetFullPath($RepoRoot.Path)
    $venvFullPath = [System.IO.Path]::GetFullPath($ResolvedVenvPath)
    if (-not $venvFullPath.StartsWith($repoRootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to manage venv outside repo root: $venvFullPath"
    }
    return $venvFullPath
}

$ResolvedVenvPath = Assert-SafeVenvPath (Resolve-InRepoPath $VenvPath)
$PythonCommand = Resolve-PythonCommand $Python
Assert-PythonRuntime $PythonCommand

$venvStatus = Get-VenvStatus $ResolvedVenvPath
if ($venvStatus.healthy) {
    Write-Host "Build venv is healthy: $($venvStatus.pythonPath)"
}
elseif ($venvStatus.exists -and -not $RecreateBroken) {
    throw "Build venv is broken ($($venvStatus.reason)). Re-run with -RecreateBroken."
}
else {
    if ($venvStatus.exists) {
        Write-Warning "Build venv is broken: $($venvStatus.reason)"
        Write-Host "Recreating build venv: $ResolvedVenvPath"
        Remove-Item -LiteralPath $ResolvedVenvPath -Recurse -Force
    }
    else {
        Write-Host "Creating build venv: $ResolvedVenvPath"
    }

    Invoke-PythonCommand $PythonCommand -PythonArgs @("-m", "venv", $ResolvedVenvPath)
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create venv: $ResolvedVenvPath"
    }
}

$VenvPython = Join-Path $ResolvedVenvPath "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $VenvPython)) {
    throw "Build venv python was not created: $VenvPython"
}

if (-not $SkipInstall) {
    $RequirementsFile = Join-Path $RepoRoot "backend\requirements-desktop.txt"
    Write-Host "Installing backend desktop requirements from: $RequirementsFile"
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to upgrade pip in build venv."
    }
    & $VenvPython -m pip install -r $RequirementsFile
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install backend desktop requirements."
    }
}

Write-Host "Ready build Python: $VenvPython"
Write-Host "Use it for builds:"
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\release_portable.ps1 -Python $VenvPython"
