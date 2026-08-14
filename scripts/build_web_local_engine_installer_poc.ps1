param(
    [string]$Python = "backend\.venv-desktop\Scripts\python.exe",
    [string]$Makensis = "makensis.exe",
    [string]$ArtifactDir = "releases\web-local-engine-poc",
    [string]$OutputDir = "releases\web-local-engine-installer-poc"
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ExpectedArtifactDir = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "releases\web-local-engine-poc"))
$ExpectedOutputDir = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "releases\web-local-engine-installer-poc"))
$ResolvedArtifactDir = if ([System.IO.Path]::IsPathRooted($ArtifactDir)) {
    [System.IO.Path]::GetFullPath($ArtifactDir)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $ArtifactDir))
}
$ResolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    [System.IO.Path]::GetFullPath($OutputDir)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $OutputDir))
}
if (-not $ResolvedArtifactDir.Equals($ExpectedArtifactDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ArtifactDir must be the dedicated verified web local-engine PoC folder."
}
if (-not $ResolvedOutputDir.Equals($ExpectedOutputDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDir must be the dedicated installer PoC folder."
}

$MakensisCommand = Get-Command $Makensis -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $MakensisCommand) {
    throw "makensis.exe is required. Install or provide a trusted Windows NSIS compiler before the home-PC build gate."
}
$ResolvedMakensis = $MakensisCommand.Source

$PythonCommand = if ([System.IO.Path]::IsPathRooted($Python)) {
    [System.IO.Path]::GetFullPath($Python)
}
elseif ($Python -match '[\\/]') {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Python))
}
else {
    $Python
}
& $PythonCommand -c "import PyInstaller"
if ($LASTEXITCODE -ne 0) {
    throw "Python with PyInstaller is required before replacing installer output."
}

$ManifestPath = Join-Path $ResolvedArtifactDir "poc-manifest.json"
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "The verified frozen artifact manifest is missing."
}
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (
    $Manifest.packageFormat -ne "barorok-web-local-engine-poc-v1" -or
    $Manifest.installScope -ne "current-user" -or
    $Manifest.bind -ne "127.0.0.1:17863" -or
    $Manifest.userDataRoot -ne "%LOCALAPPDATA%\Barorok\LocalEngine" -or
    $Manifest.signed -ne $false -or
    $Manifest.distributionReady -ne $false
) {
    throw "The frozen artifact is not the expected unsigned current-user PoC input."
}
$EngineVersion = [string]$Manifest.engineVersion
if ($EngineVersion -notmatch '^[A-Za-z0-9._-]+$') {
    throw "The engine version cannot be passed safely to the installer compiler."
}
$EngineCandidates = @($Manifest.payloadFiles | Where-Object {
    [string]$_.path -match '^engine\\barorok-local-engine-[A-Za-z0-9_-]+\.exe$'
})
if ($EngineCandidates.Count -ne 1) {
    throw "The frozen artifact must contain exactly one local-engine executable."
}
$EngineRelativePath = [string]$EngineCandidates[0].path
$EnginePath = Join-Path $ResolvedArtifactDir $EngineRelativePath
if (-not (Test-Path -LiteralPath $EnginePath -PathType Leaf)) {
    throw "The local-engine executable declared by the manifest is missing."
}
$EngineExeName = [System.IO.Path]::GetFileName($EngineRelativePath)
$IconPath = Join-Path $RepoRoot "desktop-app\src-tauri\icons\icon.ico"
$NsiPath = Join-Path $RepoRoot "installer\web-local-engine.nsi"
if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $NsiPath -PathType Leaf)) {
    throw "Installer source input is missing."
}

& $PythonCommand (Join-Path $RepoRoot "scripts\verify_web_local_engine_poc.py") `
    $ResolvedArtifactDir `
    --manifest-only
if ($LASTEXITCODE -ne 0) {
    throw "The frozen artifact failed closed-manifest verification."
}

if (Test-Path -LiteralPath $ResolvedOutputDir) {
    $resolvedExisting = (Resolve-Path -LiteralPath $ResolvedOutputDir).Path
    if (-not $resolvedExisting.Equals($ExpectedOutputDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace an unexpected installer output directory."
    }
    Remove-Item -LiteralPath $resolvedExisting -Recurse -Force
}
New-Item -ItemType Directory -Path $ResolvedOutputDir -Force | Out-Null

$HelperPath = Join-Path $ResolvedOutputDir "build-input\barorok-installer-preflight.exe"
& (Join-Path $PSScriptRoot "build_web_local_engine_installer_helper.ps1") `
    -Python $Python `
    -OutputPath $HelperPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
    throw "Installer preflight helper build failed."
}

$InstallerPath = Join-Path $ResolvedOutputDir "Barorok-Local-Engine-Setup-$EngineVersion.exe"
& $ResolvedMakensis `
    "/V3" `
    "/DARTIFACT_DIR=$ResolvedArtifactDir" `
    "/DHELPER_PATH=$HelperPath" `
    "/DOUTPUT_FILE=$InstallerPath" `
    "/DENGINE_EXE_NAME=$EngineExeName" `
    "/DENGINE_VERSION=$EngineVersion" `
    "/DICON_PATH=$IconPath" `
    $NsiPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "NSIS installer build failed."
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

$InstallerFile = Get-Item -LiteralPath $InstallerPath
$InstallerManifest = [ordered]@{
    packageFormat = "barorok-web-local-engine-installer-poc-v1"
    engineVersion = $EngineVersion
    generatedAt = [DateTime]::UtcNow.ToString("o")
    installScope = "current-user"
    installRoot = "%LOCALAPPDATA%\Programs\Barorok\LocalEngine"
    userDataRoot = "%LOCALAPPDATA%\Barorok\LocalEngine"
    stagingMode = "same-volume-stage-atomic-rename"
    preservedUserData = @("config", "models", "database", "results", "logs", "temp")
    installer = [ordered]@{
        file = $InstallerFile.Name
        bytes = $InstallerFile.Length
        sha256 = Get-FileHashValue $InstallerFile.FullName
    }
    signed = $false
    distributionReady = $false
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    (Join-Path $ResolvedOutputDir "installer-poc-manifest.json"),
    (($InstallerManifest | ConvertTo-Json -Depth 6) + "`n"),
    $Utf8NoBom
)

$BuildInputDir = Join-Path $ResolvedOutputDir "build-input"
if (Test-Path -LiteralPath $BuildInputDir) {
    Remove-Item -LiteralPath $BuildInputDir -Recurse -Force
}

Write-Host "Unsigned current-user installer PoC created: $InstallerPath"
Write-Host "Development artifact only. Do not publish a download CTA."
