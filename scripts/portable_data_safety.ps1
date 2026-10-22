function Test-PortablePathWithin([string]$Path, [string]$Root) {
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    return $fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
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
        $resolved = if ([System.IO.Path]::IsPathRooted($configured)) { $configured } else { Join-Path $backendRoot $configured }
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
    if ($config.export_templates -and $config.export_templates.use_custom_template) {
        $resources += @($config.export_templates.hwpx_template_path, $config.export_templates.docx_template_path)
    }
    foreach ($resource in $resources) {
        if (-not $resource) { continue }
        $resolved = if ([System.IO.Path]::IsPathRooted($resource)) { $resource } else { Join-Path $backendRoot $resource }
        if ((Test-PortablePathWithin $resolved $backendRoot) -and (Test-Path -LiteralPath $resolved)) {
            throw "Unsupported portable data layout: custom model/template inside backend. Move custom resources outside backend before updating or packaging. No data was changed."
        }
    }
}
