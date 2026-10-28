"""Hash-command selection must not cache file contents or weaken failures."""
import hashlib
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_ROOT = Path(os.environ.get('PORTABLE_HASH_SCRIPTS', ROOT / 'scripts'))
SCRIPTS = ('verify_portable.ps1', 'create_update_package.ps1', 'create_handoff_package.ps1', 'release_portable.ps1', 'diagnose_portable.ps1')


def _quote(path):
    return "'" + str(path).replace("'", "''") + "'"


class PortableHashSelectionTest(unittest.TestCase):
    def _check(self, name, mode):
        source = (SCRIPT_ROOT / name).read_text(encoding='utf-8')
        function = 'Get-HashIfExists' if name == 'diagnose_portable.ps1' else 'Get-FileHashValue'
        helper = re.search(rf'^function {function}\b[\s\S]+?(?=^function |\Z)', source, re.M).group(0)
        # Run the real initializers too, including resetting a previous invocation.
        initializers = '\n'.join(re.findall(r'^\$script:FileHashCommand(?:Resolved)? = .*$', source, re.M))
        handoff = name == 'create_handoff_package.ps1'
        missing_returns = name in ('verify_portable.ps1', 'release_portable.ps1', 'diagnose_portable.ps1')
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'content[1].bin'
            path.write_bytes(b'first')
            setup = r'''
Import-Module ($env:WINDIR + '\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$script:ActualHashCommand = Microsoft.PowerShell.Core\Get-Command Get-FileHash -ErrorAction Stop
function Invoke-CountedHash {
    param([string]$LiteralPath, [string]$Algorithm)
    $script:Invocations++
    if ($script:FailInvocation) { throw 'Per-file hash failure' }
    & $script:ActualHashCommand -LiteralPath $LiteralPath -Algorithm $Algorithm
}
$script:SelectedCommand = Microsoft.PowerShell.Core\Get-Command Invoke-CountedHash -ErrorAction Stop
'''
            if mode == 'missing':
                setup = '$script:SelectedCommand = $null'
            # Missing file contracts intentionally differ between helpers.
            missing_returns = missing_returns or (name == 'create_update_package.ps1' and mode == 'available')
            missing = f'''
$failed = $false
try {{ $missing = {function} ($path + '.missing') }} catch {{ $failed = $true }}
if ({'$true' if missing_returns else '$false'}) {{
    if ($failed -or $missing) {{ throw 'Missing file return contract changed' }}
}} elseif (-not $failed) {{ throw 'Missing file must be rejected' }}
'''
            command = f'''
$ErrorActionPreference = 'Stop'
$script:FileHashCommandResolved = $true
$script:FileHashCommand = 'stale command from previous invocation'
{initializers}
$script:DiscoveryCalls = 0
$script:Invocations = 0
$script:FailInvocation = ${str(mode == 'broken').lower()}
{setup}
function Get-Command {{ $script:DiscoveryCalls++; return $script:SelectedCommand }}
{helper}
$path = {_quote(path)}
'''
            if name in ('verify_portable.ps1', 'release_portable.ps1', 'diagnose_portable.ps1'):
                command += f'''
if ({function} ($path + '.missing')) {{ throw 'Missing file became valid' }}
if ($script:DiscoveryCalls -ne 0) {{ throw 'Missing file must not trigger discovery' }}
'''
            if mode == 'broken' and handoff:
                command += f'''
foreach ($iteration in 1..2) {{
    $failed = $false
    try {{ $null = {function} $path }} catch {{ $failed = $true }}
    if (-not $failed) {{ throw 'Handoff must retain command invocation failure' }}
}}
if ($script:Invocations -ne 2) {{ throw 'Per-file invocation changed' }}
'''
            else:
                command += f'''
$first = {function} $path
[IO.File]::WriteAllText($path, 'other')
$second = {function} $path
if ($first -cne '{hashlib.sha256(b'first').hexdigest().lower() if handoff else hashlib.sha256(b'first').hexdigest().upper()}') {{ throw 'First SHA/case mismatch' }}
if ($second -cne '{hashlib.sha256(b'other').hexdigest().lower() if handoff else hashlib.sha256(b'other').hexdigest().upper()}') {{ throw 'Changed bytes were not rehashed' }}
$locked = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {{
    $failed = $false
    try {{ $null = {function} $path }} catch {{ $failed = $true }}
    if (-not $failed) {{ throw 'Unreadable file was accepted' }}
}} finally {{ $locked.Dispose() }}
if (({function} $path) -cne $second) {{ throw 'Read did not recover after unlock' }}
{missing}
'''
            command += '''
if ($script:DiscoveryCalls -ne 1) { throw "Expected one discovery, got $script:DiscoveryCalls" }
'''
            script = Path(temp) / 'check.ps1'
            script.write_text(command, encoding='utf-8-sig')
            result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unavailable_command_rehashes_changed_files_and_rejects_unreadable_files(self):
        for name in SCRIPTS:
            with self.subTest(script=name):
                self._check(name, 'missing')

    def test_available_command_rehashes_files_with_one_discovery(self):
        for name in SCRIPTS:
            with self.subTest(script=name):
                self._check(name, 'available')

    def test_per_file_invocation_failure_retains_existing_fallback_or_error(self):
        for name in SCRIPTS:
            with self.subTest(script=name):
                self._check(name, 'broken')


if __name__ == '__main__':
    unittest.main(verbosity=2)
