function Test-PortablePathWithin([string]$Path, [string]$Root) {
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    return $fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-PortableBackendPath([string]$Path, [string]$BackendRoot) {
    $backendFullPath = [System.IO.Path]::GetFullPath($BackendRoot)
    # D:model is relative to that drive's current directory, not D:\model.
    # The desktop child runs in backend, rather than the release shell's cwd.
    if ($Path -match '^([A-Za-z]:)([^\\/].*|)$') {
        $drive = $Matches[1]
        $tail = $Matches[2]
        if ($drive.Equals([System.IO.Path]::GetPathRoot($backendFullPath).TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
            return [System.IO.Path]::GetFullPath((Join-Path $backendFullPath $tail))
        }
        # Another drive cannot refer into this backend. Keep it unchanged so
        # model names such as q:7b do not require a Q: filesystem drive.
        return $Path
    }
    if ($Path -match '^[\\/](?![\\/])') {
        return Join-Path ([System.IO.Path]::GetPathRoot($backendFullPath)) $Path.TrimStart('\', '/')
    }
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return Join-Path $backendFullPath $Path
}

function Assert-PortableDataLayout([string]$PortableRoot, [switch]$ForRuntimeSmoke) {
    $backendRoot = Join-Path $PortableRoot 'backend'
    $configFile = Join-Path $backendRoot 'config.json'
    if (-not (Test-Path -LiteralPath $configFile)) { return }
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $defaults = @{ output_dir = 'outputs'; temp_dir = 'temp'; log_dir = 'logs' }
    foreach ($key in $defaults.Keys) {
        if (-not $config.paths -or $config.paths.PSObject.Properties.Name -notcontains $key) { continue }
        $configured = [string]$config.paths.$key
        $resolved = Resolve-PortableBackendPath $configured $backendRoot
        $expected = Join-Path $backendRoot $defaults[$key]
        $isDefault = [System.IO.Path]::GetFullPath($resolved).TrimEnd('\', '/').Equals([System.IO.Path]::GetFullPath($expected).TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)
        if (-not $isDefault -and ($ForRuntimeSmoke -or (Test-PortablePathWithin $resolved $PortableRoot))) {
            throw "Unsupported portable data layout: paths.$key. Keep custom data outside the portable folder before updating or packaging; runtime smoke requires the default isolated paths. No data was changed."
        }
    }
    # Nonstandard model files or active user templates inside backend would be
    # mirrored as code or copied into a handoff. External resources stay untouched.
    $resources = @()
    foreach ($key in @('stt_model', 'diarization_model', 'segmentation_model', 'llm_model')) {
        if ($config.paths -and $config.paths.$key) { $resources += [string]$config.paths.$key }
    }
    # The backend checks for an existing summary.model file before interpreting
    # it as an Ollama name, including files without an extension.
    $summaryModel = ([string]$config.summary.model).Trim()
    if ($summaryModel) {
        $resolvedSummaryModel = Resolve-PortableBackendPath $summaryModel $backendRoot
        # Names such as gemma4:e2b are not filesystem paths on Windows.
        if (Test-Path -LiteralPath $resolvedSummaryModel -PathType Leaf -ErrorAction SilentlyContinue) {
            $resources += $resolvedSummaryModel
        }
    }
    if ($config.export_templates -and $config.export_templates.use_custom_template) {
        $resources += @($config.export_templates.hwpx_template_path, $config.export_templates.docx_template_path)
    }
    foreach ($resource in $resources) {
        if (-not $resource) { continue }
        $resolved = Resolve-PortableBackendPath $resource $backendRoot
        if ((Test-PortablePathWithin $resolved $backendRoot) -and (Test-Path -LiteralPath $resolved)) {
            throw "Unsupported portable data layout: custom model/template inside backend. Move custom resources outside backend before updating or packaging. No data was changed."
        }
    }
}

# Files the app writes inside backend. Release, update and handoff steps never
# ship, replace or delete them, whatever a manifest lists.
function Test-PortableUserDataPath([string]$RelativePath) {
    # Judge the file Windows would open, so '.', '..', or a trailing dot or space
    # cannot disguise a record. A path that does not resolve inside counts as one.
    $root = 'C:\portable-root'
    try { $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root (($RelativePath -replace '/', '\').TrimStart('\')))) }
    catch { return $true }
    if (-not $fullPath.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    $parts = $fullPath.Substring($root.Length + 1) -split '\\'
    if ($parts.Length -lt 2 -or -not $parts[0].Equals('backend', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ($parts.Length -eq 2 -and $parts[1].Equals('config.json', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($parts.Length -gt 2 -and $parts[1] -in @('outputs', 'temp', 'logs', 'database')) { return $true }
    return ($parts[-1] -like '*.db*') -or ($parts[-1] -like '*.sqlite*')
}

function Get-PortableSha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '') }
        finally { $sha.Dispose() }
    }
    finally { $stream.Dispose() }
}

# The build manifest's portablePayloadFiles is the list of package-owned files.
# Returns $null when an older or damaged manifest has no list.
function Get-PortablePackageEntries([string]$ManifestPath) {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return $null }
    try { $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $null }
    if (-not $manifest -or $manifest.PSObject.Properties.Name -notcontains 'portablePayloadFiles') { return $null }
    # Handoffs made before 2026-10-22 listed a walk of backend that could include
    # user copies. Only a list taken from a build proves package ownership.
    if ($manifest.PSObject.Properties.Name -contains 'handoff' -and [string]$manifest.handoff.payloadList -ne 'build') { return $null }
    $entries = @($manifest.portablePayloadFiles | Where-Object { $_ -and $_.path })
    if ($entries.Count -eq 0) { return $null }
    return ,$entries
}

# Removes files a previous build listed under Folder that the new package no
# longer ships. A listed file that was changed since is kept, and so is every
# unlisted file (records, user copies, alias model folders): they are the user's.
function Remove-StalePortablePackageFiles([string]$TargetRoot, [string]$SourceRoot, $PreviousEntries, [string]$Folder) {
    $rootPath = [System.IO.Path]::GetFullPath($TargetRoot).TrimEnd('\')
    $folderRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath $Folder)).TrimEnd('\')
    foreach ($entry in @($PreviousEntries)) {
        try { $targetFile = [System.IO.Path]::GetFullPath((Join-Path $rootPath (([string]$entry.path -replace '/', '\').TrimStart('\')))) }
        catch { continue }
        if (-not (Test-PortablePathWithin $targetFile $folderRoot) -or $targetFile.TrimEnd('\').Equals($folderRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        # Work with the path Windows resolves, not the manifest's spelling.
        $relativePath = $targetFile.Substring($rootPath.Length + 1)
        if (Test-PortableUserDataPath $relativePath) { continue }
        if (Test-Path -LiteralPath (Join-Path $SourceRoot $relativePath)) { continue }
        if (-not (Test-Path -LiteralPath $targetFile -PathType Leaf)) { continue }
        if ((Get-PortableSha256 $targetFile) -ne [string]$entry.sha256) {
            Write-Warning "Kept a changed file that the new package no longer ships: $relativePath"
            continue
        }
        Remove-Item -LiteralPath $targetFile -Force
        # Drop folders this emptied; a folder that still holds anything stays.
        $parent = Split-Path -Parent $targetFile
        while ($parent -and -not $parent.TrimEnd('\').Equals($folderRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Test-PortablePathWithin $parent $folderRoot) -and -not (Get-ChildItem -LiteralPath $parent -Force | Select-Object -First 1)) {
            Remove-Item -LiteralPath $parent -Force
            $parent = Split-Path -Parent $parent
        }
    }
}

# Guide placed in runtime\ollama when the build has no embedded Ollama.
# Installing Ollama from the app replaces it, so a handoff restores these bytes.
function Get-PortableOllamaReadmeText {
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("7ZqM7J2YIOyalOyVvSDtlITroZzqt7jrnqgg7Y+0642UCgrsnbQg7Y+0642U64qUIO2ajOydmCDsmpTslb3sl5Ag7JOw64qUIOyLpO2WiSDtlITroZzqt7jrnqjsnbQg65Ok7Ja06rCIIOyekOumrOyeheuLiOuLpC4KCuuMgO2ZlOuhnSDsnpHshLHrp4wg7ZWgIOuVjOuKlCDsmpTslb0g7ZSE66Gc6re4656o7J20IO2VhOyalO2VmOyngCDslYrsirXri4jri6QuCuyghOyytCDsmpTslb0sIOyjvOygnOuzhCDsoJXrpqwsIOywuOyEneyekOuzhCDsoJXrpqzrpbwg7IKs7Jqp7ZWgIOuVjOunjCDsmpTslb0g7ZSE66Gc6re4656o6rO8IO2ajOydmCDsmpTslb0g66qo64247J20IO2VhOyalO2VqeuLiOuLpC4KCuydvOuwmCDsoITri6zsmqkg7Yyo7YKk7KeA7JeQ64qUIOyalOyVvSDtlITroZzqt7jrnqgg7Iuk7ZaJIO2MjOydvOydtCDrk6TslrQg7J6I7KeAIOyViuyKteuLiOuLpC4K7J247YSw64S37J20IOuQmOuKlCBQQ+yXkOyEnOuKlCDslbHsnYQg7Iuk7ZaJ7ZWcIOuSpCDshKTsoJUgPiDrqqjrjbgg7ZmU66m07JeQ7IScICLsmpTslb0g7ZSE66Gc6re4656oIOuwm+q4sCLrpbwg64iE66W07IS47JqULgrslbHsnbQg7ZWE7JqU7ZWcIOyalOyVvSDtlITroZzqt7jrnqjsnYQg7J20IO2PtOuNlOyXkCDspIDruYTtlanri4jri6QuCgrsoJXsg4HsoIHsnLzroZwg7KSA67mE65CY66m0IOyalOyVvSDtlITroZzqt7jrnqgg7Iuk7ZaJIO2MjOydvOydtCDsg53quYHri4jri6QuCu2MjOydvCDsnbTrpoQ6IG9sbGFtYS5leGUKCu2ajOyCrCDrs7TslYgg7KCV7LGF7J2064KYIOyduO2EsOuEtyDssKjri6jsnLzroZwg67Cb6riw6rCAIOyLpO2MqO2VmOuptCwg6rSA66as7J6Q7JeQ6rKMIOyalOyVvSDtlITroZzqt7jrnqgg7KSA67mE66W8IOyalOyyre2VmOyEuOyalC4K"))
}
