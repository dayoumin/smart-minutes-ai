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
        if ($parts.Count -ne 4 -or $parts[1] -notmatch '^[a-fA-F0-9]{40}$' -or $parts[3] -notmatch '^[a-fA-F0-9]{40}$') {
            throw "Invalid pre-push ref input."
        }
        if ($parts[1] -eq ('0' * 40)) { continue }
        $targetCommit = & git rev-parse --verify ($parts[1] + '^{commit}')
        if ($LASTEXITCODE -ne 0 -or $targetCommit -ne $currentCommit) {
            throw "Push target must match the checked-out HEAD. Check out the target commit and run its checks first."
        }
    }
}

function Test-PrePushDocumentationPath([string]$Path) {
    if ($Path -match '(^|/)(\.agents|\.claude)/' -or $Path -match '(^|/)AGENTS\.md$') {
        return $false
    }
    return $Path -match '^(README|todo|roadmap|PROJECT_SPEC)\.md$' `
        -or $Path -match '^docs/.+\.(md|txt)$' `
        -or $Path -match '(^|/)README\.md$'
}

function Get-PrePushScope([string]$RefUpdates) {
    Assert-PrePushRefUpdates $RefUpdates
    $updates = @($RefUpdates -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($updates.Count -eq 0) {
        return [pscustomobject]@{ DocumentationOnly = $false; Reason = "No push range supplied." }
    }
    foreach ($line in $updates) {
        $parts = $line.Trim() -split '\s+'
        if ($parts[1] -eq ('0' * 40)) { continue }
        if ($parts[3] -eq ('0' * 40)) {
            return [pscustomobject]@{ DocumentationOnly = $false; Reason = "New remote ref." }
        }
        $remoteCommit = & git rev-parse --verify --quiet ($parts[3] + '^{commit}')
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ DocumentationOnly = $false; Reason = "Remote base is not available locally." }
        }
        # Inspect every outgoing commit, even changes later reverted. Combined merge entries
        # include resolutions without counting code already present on the remote parent again.
        # No rename detection: both deleted/added paths and executable/symlink modes stay visible.
        $changes = @(& git -c core.quotepath=false log --format= --raw --no-renames --diff-merges=dense-combined "$remoteCommit..$($parts[1])" --)
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ DocumentationOnly = $false; Reason = "Could not inspect the push range." }
        }
        # A merge can retain an older parent's code without changing it relative to
        # every parent. Compare the final tree too, so that remote code regressions stay visible.
        $tipChanges = @(& git -c core.quotepath=false diff --raw --no-renames $remoteCommit $parts[1] --)
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ DocumentationOnly = $false; Reason = "Could not inspect the final pushed tree." }
        }
        $changes += $tipChanges
        foreach ($change in $changes) {
            if ([string]::IsNullOrWhiteSpace($change)) { continue }
            if ($change -notmatch '^(?<parents>:+)(?<metadata>[^\t]+)\t(?<path>.+)$') {
                return [pscustomobject]@{ DocumentationOnly = $false; Reason = "Unrecognized change metadata." }
            }
            $parentCount = $Matches.parents.Length
            $path = $Matches.path
            $fields = $Matches.metadata -split ' '
            $modeCount = $parentCount + 1
            if ($fields.Count -ne (2 * $modeCount + 1) -or $fields[-1] -notmatch '^[A-Z]+\d*$') {
                return [pscustomobject]@{ DocumentationOnly = $false; Reason = "Unrecognized change metadata." }
            }
            $modes = $fields[0..$parentCount]
            $objectIds = $fields[$modeCount..(2 * $modeCount - 1)]
            if (@($objectIds | Where-Object { $_ -notmatch '^[a-f0-9]+$' }).Count -gt 0) {
                return [pscustomobject]@{ DocumentationOnly = $false; Reason = "Unrecognized change metadata." }
            }
            if (@($modes | Where-Object { $_ -notin @('000000', '100644') }).Count -gt 0 `
                -or -not (Test-PrePushDocumentationPath $path)) {
                return [pscustomobject]@{ DocumentationOnly = $false; Reason = "Code, configuration or automation changed." }
            }
        }
    }
    return [pscustomobject]@{ DocumentationOnly = $true; Reason = "Only approved documentation paths or ref deletions." }
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
        $scope = $null
        try {
            $refUpdates = if ([Console]::IsInputRedirected) { [Console]::In.ReadToEnd() } else { "" }
            $scope = Get-PrePushScope $refUpdates
            if (-not $scope.DocumentationOnly) { Assert-PrePushSourcesCommitted }
        }
        finally { Pop-Location }
        if ($scope.DocumentationOnly) {
            Write-Host "Pre-push: documentation-only push; skipping typecheck, Node and Python tests."
        }
        else {
            Write-Host ("Pre-push: " + $scope.Reason)
            Invoke-PrePushChecks
        }
    }
    catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
