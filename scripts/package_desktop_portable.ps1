param(
    [string]$Configuration = "release",
    [switch]$AllowMissingEmbeddedOllama
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TauriDir = Join-Path $RepoRoot "desktop-app\src-tauri"
$ReleaseDir = Join-Path $TauriDir "target\$Configuration"
$PortableFolderName = "lmo_audio"
$PortableAppExeName = "lmo_audio.exe"
$PortableDir = Join-Path $ReleaseDir "portable\$PortableFolderName"
$AppExe = Join-Path $ReleaseDir "smart-minutes-ai.exe"
$SidecarExe = Join-Path $TauriDir "binaries\meeting-backend-x86_64-pc-windows-msvc.exe"
$SidecarDepsDir = Join-Path $TauriDir "binaries\_internal"
$ResourceBackendDir = Join-Path $TauriDir "resources\backend"
$ModelSourceRoot = Join-Path $RepoRoot "models"
$OllamaRuntimeSource = Join-Path $RepoRoot "runtime\ollama"
$ModelLayoutFile = Join-Path $PSScriptRoot "portable_model_layout.json"
$ModelLayout = Get-Content -LiteralPath $ModelLayoutFile -Raw | ConvertFrom-Json

function ConvertFrom-Utf8Base64([string]$Value) {
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Get-PeSubsystem {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    $optionalHeaderOffset = $peOffset + 24
    return [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset + 68)
}

if (-not (Test-Path $AppExe)) {
    throw "App executable does not exist. Run `corepack pnpm run desktop:build` or `cargo build --release` first: $AppExe"
}
if (-not (Test-Path $SidecarExe)) {
    throw "Backend sidecar does not exist. Run scripts/package_backend_sidecar.ps1 first: $SidecarExe"
}
if (-not (Test-Path $SidecarDepsDir)) {
    throw "Backend sidecar dependencies do not exist. Run scripts/package_backend_sidecar.ps1 first: $SidecarDepsDir"
}
if (-not (Test-Path $ResourceBackendDir)) {
    throw "Prepared backend resources do not exist. Run scripts/prepare_tauri_resources.ps1 first: $ResourceBackendDir"
}
if ((Get-PeSubsystem $AppExe) -ne 2) {
    throw "App executable must be Windows GUI subsystem: $AppExe"
}
if ((Get-PeSubsystem $SidecarExe) -ne 2) {
    throw "Backend sidecar must be Windows GUI subsystem: $SidecarExe"
}

if (Test-Path $PortableDir) {
    Remove-Item -Recurse -Force $PortableDir
}

New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PortableDir "binaries") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PortableDir "runtime") | Out-Null

Copy-Item -Force $AppExe (Join-Path $PortableDir $PortableAppExeName)
Copy-Item -Force $SidecarExe (Join-Path $PortableDir "binaries\meeting-backend-x86_64-pc-windows-msvc.exe")
Copy-Item -Recurse -Force $SidecarDepsDir (Join-Path $PortableDir "binaries\_internal")
Copy-Item -Recurse -Force $ResourceBackendDir (Join-Path $PortableDir "backend")

$PortableOllamaRuntime = Join-Path $PortableDir "runtime\ollama"
if (Test-Path -LiteralPath (Join-Path $OllamaRuntimeSource "ollama.exe")) {
    robocopy $OllamaRuntimeSource $PortableOllamaRuntime /MIR /XD .git .cache /XF *.lock /NFL /NDL /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while copying app-managed Ollama runtime with exit code $LASTEXITCODE`: $OllamaRuntimeSource"
    }
}
else {
    New-Item -ItemType Directory -Force -Path $PortableOllamaRuntime | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $PortableOllamaRuntime "README.txt"),
        (ConvertFrom-Utf8Base64 "7ZqM7J2YIOyalOyVvSDtlITroZzqt7jrnqgg7Y+0642UCgrsnbQg7Y+0642U64qUIO2ajOydmCDsmpTslb3sl5Ag7JOw64qUIOyLpO2WiSDtlITroZzqt7jrnqjsnbQg65Ok7Ja06rCIIOyekOumrOyeheuLiOuLpC4KCuuMgO2ZlOuhnSDsnpHshLHrp4wg7ZWgIOuVjOuKlCDsmpTslb0g7ZSE66Gc6re4656o7J20IO2VhOyalO2VmOyngCDslYrsirXri4jri6QuCuyghOyytCDsmpTslb0sIOyjvOygnOuzhCDsoJXrpqwsIOywuOyEneyekOuzhCDsoJXrpqzrpbwg7IKs7Jqp7ZWgIOuVjOunjCDsmpTslb0g7ZSE66Gc6re4656o6rO8IO2ajOydmCDsmpTslb0g66qo64247J20IO2VhOyalO2VqeuLiOuLpC4KCuydvOuwmCDsoITri6zsmqkg7Yyo7YKk7KeA7JeQ64qUIOyalOyVvSDtlITroZzqt7jrnqgg7Iuk7ZaJIO2MjOydvOydtCDrk6TslrQg7J6I7KeAIOyViuyKteuLiOuLpC4K7J247YSw64S37J20IOuQmOuKlCBQQ+yXkOyEnOuKlCDslbHsnYQg7Iuk7ZaJ7ZWcIOuSpCDshKTsoJUgPiDrqqjrjbgg7ZmU66m07JeQ7IScICLsmpTslb0g7ZSE66Gc6re4656oIOuwm+q4sCLrpbwg64iE66W07IS47JqULgrslbHsnbQg7ZWE7JqU7ZWcIOyalOyVvSDtlITroZzqt7jrnqjsnYQg7J20IO2PtOuNlOyXkCDspIDruYTtlanri4jri6QuCgrsoJXsg4HsoIHsnLzroZwg7KSA67mE65CY66m0IOyalOyVvSDtlITroZzqt7jrnqgg7Iuk7ZaJIO2MjOydvOydtCDsg53quYHri4jri6QuCu2MjOydvCDsnbTrpoQ6IG9sbGFtYS5leGUKCu2ajOyCrCDrs7TslYgg7KCV7LGF7J2064KYIOyduO2EsOuEtyDssKjri6jsnLzroZwg67Cb6riw6rCAIOyLpO2MqO2VmOuptCwg6rSA66as7J6Q7JeQ6rKMIOyalOyVvSDtlITroZzqt7jrnqgg7KSA67mE66W8IOyalOyyre2VmOyEuOyalC4K"),
        [System.Text.UTF8Encoding]::new($false)
    )
}

$PortableModelsDir = Join-Path $PortableDir "models"
New-Item -ItemType Directory -Force -Path $PortableModelsDir | Out-Null

$modelLines = @($ModelLayout.models) | ForEach-Object { "- models\$($_.portableDir)" } | Out-String
$ModelReadme = (ConvertFrom-Utf8Base64 "TE1PIO2ajOydmCDsnbjsgqzsnbTtirgg66qo6424IO2PtOuNlAoK66qo64247J2AIG1vZGVscyDtj7TrjZQg7JWE656Y7JeQIOygle2VtOynhCDsnbTrpoTsnLzroZwg64Sj7Ja07JW8IO2VqeuLiOuLpC4K7Y+0642UIOydtOumhOydhCDrsJTqvrjrqbQg7JWx7J20IOuqqOuNuOydhCDssL7sp4Ag66q77ZWgIOyImCDsnojsirXri4jri6QuCgrtlYTsmpTtlZwg66qo6424IO2PtOuNlDoKe3tNT0RFTF9MSU5FU319CgrrjIDtmZTroZ0g7J6R7ISx7JeQ64qUIOydjOyEsSDsnbjsi50g66qo64247J24IGZhc3Rlci13aGlzcGVyLWxhcmdlLXYz6rCAIO2VhOyalO2VqeuLiOuLpC4K7LC47ISd7J6QIOq1rOu2hOyXkOuKlCBzcGVha2VyLWRpYXJpemF0aW9uLWNvbW11bml0eS0xIOuqqOuNuOydtCDtlYTsmpTtlanri4jri6QuCgrtmozsnZgg7JqU7JW97J2AIOychCDrqqjrjbjqs7wg67OE6rCc7J6F64uI64ukLgotIOuMgO2ZlOuhnSDsnpHshLHrp4wg7ZWgIOuVjOuKlCDsmpTslb0g7ZSE66Gc6re4656o7J20IO2VhOyalO2VmOyngCDslYrsirXri4jri6QuCi0g7KCE7LK0IOyalOyVvSwg7KO87KCc67OEIOygleumrCwg7LC47ISd7J6Q67OEIOygleumrOulvCDsgqzsmqntlaAg65WM64qUIOyalOyVvSDtlITroZzqt7jrnqjqs7wg7ZqM7J2YIOyalOyVvSDrqqjrjbjsnbQg7ZWE7JqU7ZWp64uI64ukLgotIOyalOyVvSDquLDriqXsnbQg7ZWE7JqU7ZWY66m0IOyVsSDshKTsoJUgPiDrqqjrjbjsl5DshJwgIuyalOyVvSDtlITroZzqt7jrnqgi6rO8ICLtmozsnZgg7JqU7JW9IOuqqOuNuCLsnYQg7KSA67mE7ZWY7IS47JqULgo=").Replace("{{MODEL_LINES}}", $modelLines)
[System.IO.File]::WriteAllText(
    (Join-Path $PortableModelsDir "README.txt"),
    $ModelReadme,
    [System.Text.UTF8Encoding]::new($false)
)

function Test-RequiredMarkers {
    param(
        [string]$Root,
        [string[]]$Markers,
        [string]$Label
    )

    $missing = @()
    foreach ($marker in $Markers) {
        $path = Join-Path $Root $marker
        if (-not (Test-Path -LiteralPath $path)) {
            $missing += $marker
        }
    }
    if ($missing.Count -gt 0) {
        throw "$Label model is incomplete at $Root. Missing: $($missing -join ', ')"
    }
}

function Copy-ModelDirectory {
    param(
        [string]$Source,
        [string]$Destination,
        [string]$Label,
        [string[]]$RequiredMarkers
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        $modelName = Split-Path -Leaf $Source
        throw @"
$Label model was not found at $Source

Portable builds read model sources from the project-root models folder:
  models\$modelName

For a rebuild, put or link the model folder there before running release_portable.ps1.
The final app will copy it to:
  releases\lmo_audio\models\$modelName

Do not use the old root lmo_audio folder as the release target.
"@
    }

    Test-RequiredMarkers $Source $RequiredMarkers $Label

    robocopy $Source $Destination /E /XD .git .cache /XF *.lock /NFL /NDL /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while copying model with exit code $LASTEXITCODE`: $Source"
    }

    Test-RequiredMarkers $Destination $RequiredMarkers $Label
}

foreach ($model in @($ModelLayout.models)) {
    $source = Join-Path $ModelSourceRoot ([string]$model.source)
    $destination = Join-Path $PortableModelsDir ([string]$model.portableDir)
    Copy-ModelDirectory $source $destination ([string]$model.label) @($model.requiredMarkers)
}

$TopLevelReadme = ConvertFrom-Utf8Base64 "TE1PIO2ajOydmCDsnbjsgqzsnbTtirggLSDrqLzsoIAg7J297Ja0IOyjvOyEuOyalAoKMS4g7Iuk7ZaJIOuwqeuylQogICAtIOydtCDtj7TrjZQg7JWI7J2YIGxtb19hdWRpby5leGXrpbwg7Iuk7ZaJ7ZWp64uI64ukLgogICAtIGV4ZSDtjIzsnbzrp4wg65Sw66GcIOyYruq4sOyngCDrp5Dqs6AgbG1vX2F1ZGlvIO2PtOuNlCDsoITssrTrpbwg7ZWo6ruYIOyYruqyqCDso7zshLjsmpQuCgoyLiDsnbQg7Y+0642U66GcIO2VoCDsiJgg7J6I64qUIOydvAogICAtIOydjOyEsS/smIHsg4Eg7YyM7J287JeQ7IScIOuMgO2ZlOuhneydhCDrp4zrk6Qg7IiYIOyeiOyKteuLiOuLpC4KICAgLSDrqqjrjbjsnbQg7KSA67mE65CY7Ja0IOyeiOycvOuptCDssLjshJ3snpAg6rWs67aE64+EIOyLpO2Wie2VoCDsiJgg7J6I7Iq164uI64ukLgogICAtIO2ajOydmCDsmpTslb0g6riw64ql7J2AIOuzhOuPhOydmCDsmpTslb0g7ZSE66Gc6re4656o6rO8IO2ajOydmCDsmpTslb0g66qo64247J20IOykgOu5hOuQmOyWtOyVvCDsgqzsmqntlaAg7IiYIOyeiOyKteuLiOuLpC4KICAgLSDsnbjthLDrhLfsnbQg7JeG7Ja064+EIOykgOu5hOuQnCDrqqjrjbjsnbQg7J6I7Jy866m0IOuMgO2ZlOuhnSDsnpHshLHsnYAg7IKs7Jqp7ZWgIOyImCDsnojsirXri4jri6QuCgozLiDqvK0g7KeA7Lyc7JW8IO2VoCDsoJAKICAgLSDsnbQg7Y+0642UIOyghOyytOulvCDqt7jrjIDroZwg7IKs7Jqp7ZWY7IS47JqULgogICAtIGxtb19hdWRpby5leGXrp4wg64uk66W4IOqzs+ycvOuhnCDrs7XsgqztlZjrqbQg67aE7ISdIOq4sOuKpeqzvCDrqqjrjbjsnYQg7LC+7KeAIOuqu+2VoCDsiJgg7J6I7Iq164uI64ukLgogICAtIG1vZGVscyDtj7TrjZQg7JWI7J2YIOuqqOuNuCDtj7TrjZQg7J2066aE7J2EIOuwlOq+uOyngCDrp4jshLjsmpQuCiAgIC0g67aE7ISd7ZWgIOydjOyEsS/smIHsg4Eg7YyM7J287J2AIOyVseyXkOyEnCDshKDtg53tlZjrqbQg65Cp64uI64ukLiDsnbQg7Y+0642UIOyViOycvOuhnCDrs7XsgqztlbQg65GYIO2VhOyalOuKlCDsl4bsirXri4jri6QuCgo0LiDrqqjrjbgg7KSA67mECiAgIC0g64yA7ZmU66GdIOyekeyEsSDrqqjrjbg6IG1vZGVsc1xmYXN0ZXItd2hpc3Blci1sYXJnZS12MwogICAtIOywuOyEneyekCDqtazrtoQg66qo6424OiBtb2RlbHNcc3BlYWtlci1kaWFyaXphdGlvbi1jb21tdW5pdHktMQogICAtIOuqqOuNuOydhCDrs7XsgqztlZwg65Kk7JeQ64qUIOyVsSDshKTsoJUgPiDrqqjrjbjsl5DshJwg7KSA67mEIOyDge2DnOulvCDri6Tsi5wg7ZmV7J247ZWY7IS47JqULgoKNS4g7ZqM7J2YIOyalOyVvSDquLDriqUKICAgLSDrjIDtmZTroZ0g7J6R7ISx66eMIO2VoCDrlYzripQg7JqU7JW9IO2UhOuhnOq3uOueqOydtCDtlYTsmpTtlZjsp4Ag7JWK7Iq164uI64ukLgogICAtIOyghOyytCDsmpTslb0sIOyjvOygnOuzhCDsoJXrpqwsIOywuOyEneyekOuzhCDsoJXrpqzrpbwg7JOw66Ck66m0IOyVsSDshKTsoJUgPiDrqqjrjbjsl5DshJwgIuyalOyVvSDtlITroZzqt7jrnqgi6rO8ICLtmozsnZgg7JqU7JW9IOuqqOuNuCLsnYQg7KSA67mE7ZWY7IS47JqULgogICAtIOyalOyVvSDtlITroZzqt7jrnqjqs7wg7JqU7JW9IOuqqOuNuOydgCDsnYzshLEg7J247IudIOuqqOuNuOqzvCDrs4Trj4TroZwg7KSA67mE65Cp64uI64ukLgogICAtIOyduO2EsOuEt+ydtCDssKjri6jrkJwgUEPsl5DshJzripQg7JWx7JeQ7IScIOyalOyVvSDtlITroZzqt7jrnqjsnbTrgpgg7JqU7JW9IOuqqOuNuOydhCDrsJvsnYQg7IiYIOyXhuydhCDsiJgg7J6I7Iq164uI64ukLgoKNi4g7Y+0642UIOyViOuCtAogICAtIGxtb19hdWRpby5leGU6IOyLpO2WiSDtjIzsnbwKICAgLSBtb2RlbHM6IOydjOyEsSDsnbjsi50g66qo64246rO8IOywuOyEneyekCDqtazrtoQg66qo6424CiAgIC0gbG9nczog7Iuk7ZaJIOykkSDrrLjsoJzqsIAg7IOd6rK87J2EIOuVjCDtmZXsnbjtlZjripQg6riw66GdIO2MjOydvAogICAtIOq3uCDrsJbsnZgg7Y+0642U7JmAIO2MjOydvOydgCDslbEg7Iuk7ZaJ7JeQIO2VhOyalO2VnCDrgrTrtoAg7YyM7J287J6F64uI64ukLiDsnbTrpoTsnYQg67CU6r646rGw64KYIOyCreygnO2VmOyngCDrp4jshLjsmpQuCgo3LiDrrLjsoJzqsIAg7J6I7Jy866m0CiAgIC0g66i87KCAIOyVsSDshKTsoJUgPiDrqqjrjbjsl5DshJwg66qo6424IOyDge2DnOulvCDtmZXsnbjtlZjshLjsmpQuCiAgIC0g66qo64247J2EIOuLpOyLnCDrs7XsgqztlZwg65Kk7JeQ64qUIOykgOu5hCDsg4Htg5wg7ZmV7J247J2EIOuIhOultOqxsOuCmCDslbHsnYQg64uk7IucIOyLpO2Wie2VmOyEuOyalC4KICAgLSBXaW5kb3dzIOuztOyViCDqsr3qs6DqsIAg65yo66m0IO2ajOyCrCDrs7TslYgg7KCV7LGF7JeQIOuUsOudvCDtl4jsmqkg7Jes67aA66W8IO2ZleyduO2VmOyEuOyalC4KICAgLSDtmozsgqwg67O07JWIIOygleyxheydtOuCmCDsnbjthLDrhLcg7LCo64uo7Jy866GcIOuqqOuNuCDrsJvquLDqsIAg7Iuk7Yyo7ZWY66m0IOq0gOumrOyekOyXkOqyjCDrqqjrjbgg7KSA67mE66W8IOyalOyyre2VmOyEuOyalC4K"
[System.IO.File]::WriteAllText(
    (Join-Path $PortableDir "START_HERE.txt"),
    $TopLevelReadme,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Created portable desktop package:"
Write-Host $PortableDir
