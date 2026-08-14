param(
    [string]$Python = "backend\.venv-desktop\Scripts\python.exe",
    [Parameter(Mandatory = $true)]
    [string]$Origin,
    [string]$EngineVersion = "0.0.0-dev",
    [string]$FfmpegPath = "backend\ffmpeg.exe",
    [string]$OutputDir = "releases\web-local-engine-poc"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BackendDir = Join-Path $RepoRoot "backend"
$ExpectedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "releases\web-local-engine-poc"))
$ResolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    [System.IO.Path]::GetFullPath($OutputDir)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $OutputDir))
}
if (-not $ResolvedOutputDir.Equals($ExpectedOutputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDir must be the dedicated PoC folder: $ExpectedOutputRoot"
}

$PythonCommand = if ([System.IO.Path]::IsPathRooted($Python)) {
    [System.IO.Path]::GetFullPath($Python)
}
elseif ($Python -match '[\\/]') {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Python))
}
else {
    $Python
}

$ResolvedFfmpegPath = if ([System.IO.Path]::IsPathRooted($FfmpegPath)) {
    [System.IO.Path]::GetFullPath($FfmpegPath)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $FfmpegPath))
}

$parsedOrigin = $null
$originIsValid = [System.Uri]::TryCreate($Origin, [System.UriKind]::Absolute, [ref]$parsedOrigin) -and
    $parsedOrigin.Scheme.Equals("https", [System.StringComparison]::OrdinalIgnoreCase) -and
    -not [string]::IsNullOrWhiteSpace($parsedOrigin.Host) -and
    [string]::IsNullOrEmpty($parsedOrigin.UserInfo) -and
    ($parsedOrigin.AbsolutePath -eq "/" -or [string]::IsNullOrEmpty($parsedOrigin.AbsolutePath)) -and
    [string]::IsNullOrEmpty($parsedOrigin.Query) -and
    [string]::IsNullOrEmpty($parsedOrigin.Fragment) -and
    -not $Origin.Contains("*") -and
    -not $Origin.Contains(",")
if (-not $originIsValid) {
    throw "Origin validation failed. Supply one exact HTTPS origin."
}
$normalizedOrigin = $parsedOrigin.GetLeftPart([System.UriPartial]::Authority)
if ([string]::IsNullOrWhiteSpace($EngineVersion)) {
    throw "EngineVersion is required."
}
if (-not (Test-Path -LiteralPath $ResolvedFfmpegPath -PathType Leaf)) {
    throw "ffmpeg.exe is required for the web local-engine payload: $ResolvedFfmpegPath"
}
$outputPrefix = $ExpectedOutputRoot.TrimEnd([char[]]@("\", "/")) + [System.IO.Path]::DirectorySeparatorChar
if (
    $ResolvedFfmpegPath.Equals($ExpectedOutputRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $ResolvedFfmpegPath.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw "FfmpegPath must stay outside the replaceable PoC output directory."
}

$ffmpegProbeInfo = New-Object System.Diagnostics.ProcessStartInfo
$ffmpegProbeInfo.FileName = $ResolvedFfmpegPath
$ffmpegProbeInfo.Arguments = "-version"
$ffmpegProbeInfo.UseShellExecute = $false
$ffmpegProbeInfo.CreateNoWindow = $true
$ffmpegProbeInfo.RedirectStandardOutput = $true
$ffmpegProbeInfo.RedirectStandardError = $true
$ffmpegProbe = New-Object System.Diagnostics.Process
$ffmpegProbe.StartInfo = $ffmpegProbeInfo
try {
    if (-not $ffmpegProbe.Start()) {
        throw "ffmpeg.exe could not be started."
    }
    $ffmpegStdoutTask = $ffmpegProbe.StandardOutput.ReadToEndAsync()
    $ffmpegStderrTask = $ffmpegProbe.StandardError.ReadToEndAsync()
    if (-not $ffmpegProbe.WaitForExit(10000)) {
        $ffmpegProbe.Kill()
        $ffmpegProbe.WaitForExit()
        throw "ffmpeg.exe validation timed out."
    }
    $ffmpegStdout = $ffmpegStdoutTask.GetAwaiter().GetResult()
    $ffmpegStderr = $ffmpegStderrTask.GetAwaiter().GetResult()
    $ffmpegVersionMatch = [regex]::Match(
        ($ffmpegStdout + "`n" + $ffmpegStderr),
        "(?m)^ffmpeg version [^`r`n]+"
    )
    if ($ffmpegProbe.ExitCode -ne 0 -or -not $ffmpegVersionMatch.Success) {
        throw "FfmpegPath did not pass the ffmpeg -version validation."
    }
    $FfmpegVersionLine = $ffmpegVersionMatch.Value.Trim()
}
finally {
    $ffmpegProbe.Dispose()
}

if (Test-Path -LiteralPath $ResolvedOutputDir) {
    $resolvedExisting = (Resolve-Path -LiteralPath $ResolvedOutputDir).Path
    if (-not $resolvedExisting.Equals($ExpectedOutputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace an unexpected output directory: $resolvedExisting"
    }
    Remove-Item -LiteralPath $resolvedExisting -Recurse -Force
}

$EngineDir = Join-Path $ResolvedOutputDir "engine"
$DefaultsDir = Join-Path $ResolvedOutputDir "defaults"
New-Item -ItemType Directory -Path $EngineDir -Force | Out-Null
New-Item -ItemType Directory -Path $DefaultsDir -Force | Out-Null

& (Join-Path $PSScriptRoot "package_backend_sidecar.ps1") `
    -Python $PythonCommand `
    -EntryPoint "web_local_engine_server.py" `
    -ExecutableBaseName "barorok-local-engine" `
    -DestinationDir $EngineDir
if ($LASTEXITCODE -ne 0) {
    throw "Web local-engine sidecar build failed."
}

Copy-Item -LiteralPath (Join-Path $BackendDir "config.json") -Destination (Join-Path $DefaultsDir "config.json") -Force
$engineSettings = [ordered]@{
    format = 1
    allowed_origin = $normalizedOrigin
    engine_version = $EngineVersion.Trim()
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    (Join-Path $DefaultsDir "engine-settings.json"),
    (($engineSettings | ConvertTo-Json -Depth 4) + "`n"),
    $Utf8NoBom
)
Copy-Item -LiteralPath $ResolvedFfmpegPath -Destination (Join-Path $EngineDir "ffmpeg.exe") -Force
$templatesPath = Join-Path $BackendDir "templates"
if (Test-Path -LiteralPath $templatesPath) {
    Copy-Item -LiteralPath $templatesPath -Destination (Join-Path $EngineDir "templates") -Recurse -Force
}

function Get-FileHashValue([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace "-", "").ToLowerInvariant()
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

$payloadFiles = Get-ChildItem -LiteralPath $ResolvedOutputDir -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
        [ordered]@{
            path = $_.FullName.Substring($ResolvedOutputDir.Length).TrimStart("\", "/")
            bytes = $_.Length
            sha256 = Get-FileHashValue $_.FullName
        }
    }

$manifest = [ordered]@{
    packageFormat = "barorok-web-local-engine-poc-v1"
    engineVersion = $EngineVersion
    ffmpegVersion = $FfmpegVersionLine
    allowedOrigin = $normalizedOrigin
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    installScope = "current-user"
    bind = "127.0.0.1:17863"
    userDataRoot = "%LOCALAPPDATA%\Barorok\LocalEngine"
    preservedUserData = @("config", "models", "database", "results", "logs")
    excludedFromPayload = @("models", "database", "results", "temp", "logs", "security secrets")
    signed = $false
    distributionReady = $false
    payloadFiles = @($payloadFiles)
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ResolvedOutputDir "poc-manifest.json") -Encoding UTF8

Write-Host "Web local-engine PoC payload created: $ResolvedOutputDir"
Write-Host "Unsigned development artifact only. Do not publish a download CTA."
