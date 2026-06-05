param(
    [ValidateSet("quick", "release", "portable")]
    [string]$Tier = "quick",
    [switch]$SkipFrontend,
    [switch]$SkipBackend,
    [switch]$SkipSimulations,
    [switch]$SkipPortableVerify,
    [switch]$AllowDirtyPortable,
    [switch]$IncludeModelSmoke,
    [int]$PortableTimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

$BackendQuickModules = @(
    "backend.test_job_checkpoints",
    "backend.test_storage_preflight",
    "tests.test_align_speakers",
    "tests.test_export_hwpx",
    "tests.test_export_record",
    "tests.test_qwen_segments",
    "tests.test_summarize_followups",
    "tests.test_transcript_display",
    "tests.test_portable_release_scripts"
)

$BackendReleaseModules = @(
    "backend.test_api",
    "tests.test_update_package_scripts"
)

$FrontendSimulationScripts = @(
    "test:generation-flow",
    "test:analysis-stop-flow",
    "test:resume-flow",
    "test:resume-draft-flow",
    "test:edit-guard-flow",
    "test:close-guard-flow",
    "test:audio-extract-ui",
    "test:meeting-detail-flow",
    "test:settings-backend-restart",
    "test:settings-model-management",
    "test:topic-generation-ui"
)

function Invoke-External([string]$FilePath, [string[]]$ArgumentList) {
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
    }
}

function Invoke-Step([string]$Name, [scriptblock]$Block) {
    Write-Host ""
    Write-Host "== $Name"
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Block
        $stopwatch.Stop()
        Write-Host ("PASS {0} ({1:n1}s)" -f $Name, $stopwatch.Elapsed.TotalSeconds)
    }
    catch {
        $stopwatch.Stop()
        Write-Host ("FAIL {0} ({1:n1}s)" -f $Name, $stopwatch.Elapsed.TotalSeconds)
        throw
    }
}

function Get-CheckPython {
    $desktopPython = Join-Path $RepoRoot "backend\.venv-desktop\Scripts\python.exe"
    if (Test-Path -LiteralPath $desktopPython) {
        return $desktopPython
    }

    if ($Tier -in @("release", "portable")) {
        throw "Release and portable checks require backend\.venv-desktop\Scripts\python.exe. Run the portable build venv setup before release verification."
    }

    $candidates = @(
        (Join-Path $RepoRoot "backend\.venv\Scripts\python.exe"),
        (Join-Path $RepoRoot "backend\.venv-test312\Scripts\python.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        return $pythonCommand.Source
    }

    throw "No Python runtime found. Expected backend\.venv-desktop\Scripts\python.exe for release checks."
}

function Invoke-PythonUnittest([string]$Python, [string[]]$Modules) {
    $previousPythonPath = $env:PYTHONPATH
    $backendPath = Join-Path $RepoRoot "backend"
    try {
        if ($previousPythonPath) {
            $env:PYTHONPATH = "$backendPath;$($RepoRoot.Path);$previousPythonPath"
        }
        else {
            $env:PYTHONPATH = "$backendPath;$($RepoRoot.Path)"
        }
        Invoke-External $Python (@("-m", "unittest") + $Modules)
    }
    finally {
        if ($null -eq $previousPythonPath) {
            Remove-Item Env:\PYTHONPATH -ErrorAction SilentlyContinue
        }
        else {
            $env:PYTHONPATH = $previousPythonPath
        }
    }
}

Set-Location $RepoRoot

Write-Host "Release check tier: $Tier"
Write-Host "Repository: $($RepoRoot.Path)"

Invoke-Step "git status" {
    Invoke-External "git" @("-c", "core.excludesFile=", "status", "--short", "--branch", "--untracked-files=all")
}

if (-not $SkipFrontend) {
    Invoke-Step "frontend typecheck" {
        Invoke-External "corepack" @("pnpm", "--dir", "desktop-app", "run", "typecheck")
    }

    Invoke-Step "frontend lint" {
        Invoke-External "corepack" @("pnpm", "--dir", "desktop-app", "run", "lint")
    }
}
else {
    Write-Host "SKIP frontend checks"
}

if (-not $SkipBackend) {
    $python = Get-CheckPython
    Write-Host "Python: $python"

    Invoke-Step "backend quick unittest" {
        Invoke-PythonUnittest $python $BackendQuickModules
    }

    if ($Tier -in @("release", "portable")) {
        Invoke-Step "backend API unittest" {
            Invoke-PythonUnittest $python $BackendReleaseModules
        }
    }

    if ($IncludeModelSmoke) {
        Invoke-Step "backend model smoke unittest" {
            Invoke-PythonUnittest $python @("backend.test_transcribe")
        }
    }
    else {
        Write-Host "SKIP backend model smoke unittest; pass -IncludeModelSmoke to run backend.test_transcribe."
    }
}
else {
    Write-Host "SKIP backend checks"
}

if (($Tier -in @("release", "portable")) -and (-not $SkipSimulations)) {
    foreach ($scriptName in $FrontendSimulationScripts) {
        Invoke-Step "frontend simulation $scriptName" {
            Invoke-External "corepack" @("pnpm", "--dir", "desktop-app", "run", $scriptName)
        }
    }
}
elseif ($Tier -in @("release", "portable")) {
    Write-Host "SKIP frontend simulations"
}

if (($Tier -eq "portable") -and (-not $SkipPortableVerify)) {
    Invoke-Step "portable verify" {
        $args = @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "scripts\verify_portable.ps1",
            "-PortableDir",
            "releases\lmo_audio",
            "-TimeoutSeconds",
            [string]$PortableTimeoutSeconds
        )
        if ($AllowDirtyPortable) {
            $args += "-AllowDirty"
        }
        Invoke-External "powershell" $args
    }
}
elseif ($Tier -eq "portable") {
    Write-Host "SKIP portable verify"
}

Write-Host ""
Write-Host "Release checks completed: $Tier"
