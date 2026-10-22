"""Run the packager's SSL resource discovery in a real frozen HTTP client."""
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == "nt" and shutil.which("powershell") and importlib.util.find_spec("PyInstaller"), "Windows sidecar build tools required")
class SidecarSslRuntimeTest(unittest.TestCase):
    def test_discovered_ssl_policy_survives_freezing(self):
        with tempfile.TemporaryDirectory(prefix="sidecar-ssl-") as temporary:
            work = Path(temporary)
            script = ROOT / "scripts/package_backend_sidecar.ps1"
            command = work / "discover.ps1"
            quoted_script = str(script).replace("'", "''")
            quoted_python = sys.executable.replace("'", "''")
            command.write_text(
                "$ErrorActionPreference='Stop'\n"
                f"$ast=[System.Management.Automation.Language.Parser]::ParseFile('{quoted_script}',[ref]$null,[ref]$null)\n"
                "$node=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-SslRuntimeDataArgs'},$true)\n"
                "if(-not $node){throw 'SSL discovery helper missing'}\n"
                "Invoke-Expression $node.Extent.Text\n"
                f"ConvertTo-Json -InputObject @(Get-SslRuntimeDataArgs '{quoted_python}') -Compress\n",
                encoding="utf-8",
            )
            discovered = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(command)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
            self.assertEqual(discovered.returncode, 0, discovered.stdout + discovered.stderr)
            resource_args = json.loads(discovered.stdout)
            self.assertIn("@SslRuntimeDataArgs", script.read_text(encoding="utf-8"))
            probe = work / "probe.py"
            probe.write_text(
                "import json, pathlib, ssl, sys, urllib.request\n"
                "context=ssl.create_default_context()\n"
                "with urllib.request.urlopen(sys.argv[1],timeout=5) as response: status=response.status\n"
                "pathlib.Path(sys.argv[2]).write_text(json.dumps({'status':status,'verify_required':context.verify_mode==ssl.CERT_REQUIRED,'check_hostname':context.check_hostname}),encoding='utf-8')\n",
                encoding="utf-8",
            )
            built = subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir", "--noconsole", "--name", "ssl-probe", "--distpath", str(work / "dist"), "--workpath", str(work / "build"), "--specpath", str(work), *resource_args, str(probe)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
            self.assertEqual(built.returncode, 0, built.stdout[-3000:] + built.stderr[-3000:])

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"ok")

                def log_message(self, *_args):
                    pass

            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = work / "result.json"
                ran = subprocess.run([str(work / "dist/ssl-probe/ssl-probe.exe"), f"http://127.0.0.1:{server.server_port}/", str(result)], capture_output=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(ran.returncode, 0, ran.stderr)
                self.assertEqual(json.loads(result.read_text(encoding="utf-8")), {"status": 200, "verify_required": True, "check_hostname": True})
                for source_arg in resource_args[1::2]:
                    source = Path(source_arg.rsplit(":", 1)[0])
                    bundled = work / "dist/ssl-probe/_internal" / source.name
                    self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), hashlib.sha256(bundled.read_bytes()).digest())
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
