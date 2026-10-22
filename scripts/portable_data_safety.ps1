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
