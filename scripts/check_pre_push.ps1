$ErrorActionPreference = "Stop"
$PrePushRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$PrePushSourcePaths = @("desktop-app", "backend", "scripts", "tests", "configs", "package.json", "pnpm-lock.yaml", ".githooks", ".gitattributes")

function Invoke-PrePushCommand([string]$FilePath, [string[]]$ArgumentList) {
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Pre-push check failed: $FilePath (exit $LASTEXITCODE)."
    }
}

function Assert-PrePushSourcesCommitted {
    & git diff --quiet HEAD -- @PrePushSourcePaths
    if ($LASTEXITCODE -ne 0) {
        throw "Commit source changes before pushing so checks match the pushed commit."
    }
    $untrackedSource = @(& git ls-files --others --exclude-standard -- @PrePushSourcePaths)
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect untracked source files." }
    if ($untrackedSource.Count -gt 0) {
        throw "Commit or move aside untracked source files before pushing."
    }
}

function Assert-PrePushRefUpdates([string]$RefUpdates) {
    $currentCommit = & git rev-parse --verify HEAD
    if ($LASTEXITCODE -ne 0) { throw "Could not identify the checked-out commit." }
    foreach ($line in ($RefUpdates -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -ne 4 -or $parts[1] -notmatch '^[a-fA-F0-9]{40}$') {
            throw "Invalid pre-push ref input."
        }
        if ($parts[1] -eq ('0' * 40)) { continue }
        $targetCommit = & git rev-parse --verify ($parts[1] + '^{commit}')
        if ($LASTEXITCODE -ne 0 -or $targetCommit -ne $currentCommit) {
            throw "Push target must match the checked-out HEAD. Check out the target commit and run its checks first."
        }
    }
}

function Get-PrePushPython {
    foreach ($relative in @("backend\.venv-desktop\Scripts\python.exe", "backend\.venv\Scripts\python.exe")) {
        $candidate = Join-Path $PrePushRepoRoot $relative
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw "Pre-push requires an existing Windows backend virtual environment."
}

function Invoke-PrePushChecks {
    $previousPythonPath = $env:PYTHONPATH
    Push-Location $PrePushRepoRoot
    try {
        Write-Host "Pre-push: frontend types, engine boundary contracts and fast backend tests."
        Invoke-PrePushCommand "corepack" @("pnpm", "--dir", "desktop-app", "typecheck")
        Invoke-PrePushCommand "corepack" @(
            "pnpm", "--dir", "desktop-app", "exec", "node", "--experimental-strip-types",
            "--test", "--test-concurrency=1", "scripts/test-api-auth-boundary.mjs",
            "scripts/test-desktop-release.mjs", "scripts/test-update-activity.mjs"
        )
        $python = Get-PrePushPython
        $env:PYTHONPATH = (Join-Path $PrePushRepoRoot "backend") + ";" + $PrePushRepoRoot
        if ($previousPythonPath) { $env:PYTHONPATH += ";" + $previousPythonPath }
        Invoke-PrePushCommand $python @(
            "-X", "utf8", "-B", "-m", "unittest", "backend.test_analysis_errors",
            "backend.test_brand", "backend.test_job_checkpoints", "backend.test_storage_preflight",
            "backend.test_update_activity"
        )
        Write-Host "Pre-push checks passed."
    }
    finally {
        if ($null -eq $previousPythonPath) { Remove-Item Env:\PYTHONPATH -ErrorAction SilentlyContinue }
        else { $env:PYTHONPATH = $previousPythonPath }
        Pop-Location
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        Push-Location $PrePushRepoRoot
        try {
            $refUpdates = if ([Console]::IsInputRedirected) { [Console]::In.ReadToEnd() } else { "" }
            Assert-PrePushRefUpdates $refUpdates
            Assert-PrePushSourcesCommitted
        }
        finally { Pop-Location }
        Invoke-PrePushChecks
    }
    catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
