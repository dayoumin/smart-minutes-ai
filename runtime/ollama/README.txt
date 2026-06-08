Ollama runtime placeholder

Ollama is not bundled by default.

The desktop app can download the pinned official Windows standalone CLI release zip on first use
and extract it into the portable app folder:

Expected executable:

  runtime\ollama\ollama.exe

If the portable app folder is not writable, the app falls back to:

  %LOCALAPPDATA%\LMO_audio\runtime\ollama\ollama.exe

For offline or pre-bundled builds, extract the official Windows standalone CLI
package here before packaging. The app prefers this managed runtime over a
separately installed system Ollama.

If this managed runtime is missing, the app falls back to OLLAMA_EXE, PATH
ollama, and the common Windows system install locations.

Release operators can override the pinned runtime with LMO_OLLAMA_RUNTIME_VERSION
or LMO_OLLAMA_RUNTIME_DOWNLOAD_URL, and should set LMO_OLLAMA_RUNTIME_SHA256 when
shipping a release that allows in-app runtime downloads.

Do not commit the extracted Ollama binaries to Git. They are copied into the portable
release package from this folder only when they exist on the build machine.
