Embedded Ollama runtime placeholder

For embedded Ollama builds, extract the official Windows standalone CLI package here.

Expected executable:

  runtime\ollama\ollama.exe

User-ready portable builds fail when ollama.exe is missing.
Use -AllowMissingEmbeddedOllama only for development fallback builds that still rely on a separately installed Ollama.

Do not commit the extracted Ollama binaries to Git. They are copied into the portable
release package from this folder on the build machine.
