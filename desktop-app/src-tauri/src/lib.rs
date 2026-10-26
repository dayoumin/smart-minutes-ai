use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::ShellExt;

mod backend_port;
use backend_port::{find_available_port, PREFERRED_BACKEND_PORT};

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const BACKEND_SIDECAR: &str = "meeting-backend-x86_64-pc-windows-msvc.exe";

#[cfg(target_os = "windows")]
const MB_YESNO: u32 = 0x00000004;
#[cfg(target_os = "windows")]
const MB_ICONQUESTION: u32 = 0x00000020;
#[cfg(target_os = "windows")]
const MB_DEFBUTTON2: u32 = 0x00000100;
#[cfg(target_os = "windows")]
const IDYES: i32 = 6;

#[cfg(target_os = "windows")]
extern "system" {
    fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, u_type: u32) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "advapi32")]
extern "system" {
    #[link_name = "SystemFunction036"]
    fn rtl_gen_random(random_buffer: *mut c_void, random_buffer_length: u32) -> u8;
}

#[derive(Clone)]
struct BackendConfig {
    base_url: String,
    desktop_action_token: String,
}

struct BackendProcess {
    child: Mutex<Option<Child>>,
    port: u16,
}

struct CloseGuardState {
    active: AtomicBool,
}

#[tauri::command]
fn get_backend_base_url(config: State<'_, BackendConfig>) -> String {
    config.base_url.clone()
}

#[tauri::command]
fn get_desktop_action_token(config: State<'_, BackendConfig>) -> String {
    config.desktop_action_token.clone()
}

/// Read the identity beside the running portable executable, never the working directory or Git.
#[tauri::command]
fn get_desktop_release_identity() -> Option<serde_json::Value> {
    if cfg!(debug_assertions) {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    let file = fs::File::open(executable.parent()?.join("release-manifest.json")).ok()?;
    // Payload inventories may be large; cap reads even if a local file changes while being read.
    const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;
    let mut content = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut content).ok()?;
    if content.len() > MAX_MANIFEST_BYTES as usize {
        return None;
    }
    desktop_release_identity_from_bytes(&content)
}

fn desktop_release_identity_from_bytes(content: &[u8]) -> Option<serde_json::Value> {
    // Windows PowerShell 5.1 writes these UTF-8 manifests with a BOM.
    let json = content.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(content);
    let manifest: serde_json::Value = serde_json::from_slice(json).ok()?;
    if manifest.get("app")?.as_str()? != "lmo_audio" || manifest.get("dirty")?.as_bool()? {
        return None;
    }
    let commit = manifest.get("commit")?.as_str()?;
    let generated_at = manifest.get("generatedAt")?.as_str()?;
    if commit.len() != 40 || !commit.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
        || generated_at.is_empty() || generated_at.len() > 40 {
        return None;
    }
    Some(serde_json::json!({ "commit": commit, "generatedAt": generated_at }))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn make_desktop_action_token() -> String {
    let mut bytes = [0u8; 32];

    #[cfg(target_os = "windows")]
    {
        let filled = unsafe { rtl_gen_random(bytes.as_mut_ptr() as *mut c_void, bytes.len() as u32) } != 0;
        if filled {
            return bytes_to_hex(&bytes);
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{:032x}{:08x}", now, std::process::id())
}

fn write_backend_error_log(app: &AppHandle, filename: &str, message: &str) {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let log_dir = resource_dir.join("logs");
        let _ = fs::create_dir_all(&log_dir);
        let _ = fs::write(log_dir.join(filename), message);
    }
}

#[tauri::command]
fn restart_backend(
    app: AppHandle,
    backend: State<'_, BackendProcess>,
    config: State<'_, BackendConfig>,
) -> Result<String, String> {
    let mut slot = backend
        .child
        .lock()
        .map_err(|_| "Could not access backend process state.".to_string())?;

    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    let child = match spawn_backend(&app, backend.port, &config.desktop_action_token) {
        Ok(child) => child,
        Err(error) => {
            write_backend_error_log(&app, "restart-error.log", &error);
            return Err(format!("분석 서버를 다시 시작하지 못했습니다. {error}"));
        }
    };
    *slot = Some(child);
    Ok(format!("http://127.0.0.1:{}", backend.port))
}

#[tauri::command]
fn set_close_guard_active(state: State<'_, CloseGuardState>, active: bool) {
    state.active.store(active, Ordering::SeqCst);
}

#[tauri::command]
fn write_frontend_log(app: AppHandle, message: String) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve resource directory: {error}"))?;
    let log_dir = resource_dir.join("logs");
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Could not create log directory at {log_dir:?}: {error}"))?;
    let mut log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("frontend.log"))
        .map_err(|error| format!("Could not open frontend log: {error}"))?;
    writeln!(log_file, "{message}")
        .map_err(|error| format!("Could not write frontend log: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_saved_file_location(saved_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(saved_path);
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("Could not locate saved file: {error}"))?;
    if !canonical_path.is_file() {
        return Err("Saved path is not a file.".to_string());
    }

    let home_dir = std::env::var_os("USERPROFILE")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "Could not resolve user profile folder.".to_string())?;
    let downloads_dir = home_dir.join("Downloads");
    let allowed_root = if downloads_dir.exists() {
        downloads_dir
    } else {
        home_dir
    }
    .canonicalize()
    .map_err(|error| format!("Could not resolve download folder: {error}"))?;

    if !canonical_path.starts_with(&allowed_root) {
        return Err("Saved file is outside the download folder.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", canonical_path.display()))
            .spawn()
            .map_err(|error| format!("Could not open download folder: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let parent = canonical_path
            .parent()
            .ok_or_else(|| "Could not resolve saved file folder.".to_string())?;
        Command::new("open")
            .arg(parent)
            .spawn()
            .map_err(|error| format!("Could not open download folder: {error}"))?;
        Ok(())
    }
}

#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://ollama.com/") && !is_desktop_update_download_url(&url) {
        return Err("Unsupported external URL.".to_string());
    }

    #[allow(deprecated)]
    app.shell()
        .open(url, None)
        .map_err(|error| format!("Could not open external URL: {error}"))
}

fn is_desktop_update_download_url(url: &str) -> bool {
    let desktop_commit = url.strip_prefix("https://barorok.ecomarin.workers.dev/downloads/lmo_audio_update_")
        .and_then(|value| value.strip_suffix(".zip"));
    desktop_commit.map(|commit| commit.len() == 40
        && commit.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)))
        .unwrap_or(false)
}

#[cfg(test)]
mod desktop_update_tests {
    use super::{desktop_release_identity_from_bytes, is_desktop_update_download_url};

    #[test]
    fn desktop_release_identity_only_exposes_clean_build_identity_and_handles_windows_bom() {
        let manifest = serde_json::json!({
            "app": "lmo_audio", "dirty": false, "commit": "a".repeat(40),
            "generatedAt": "2026-10-26T11:15:48.0878238+09:00", "repoRoot": "private-path",
        });
        let expected = serde_json::json!({ "commit": manifest["commit"], "generatedAt": manifest["generatedAt"] });
        let plain = serde_json::to_vec(&manifest).unwrap();
        assert_eq!(desktop_release_identity_from_bytes(&plain), Some(expected.clone()));
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(&plain);
        assert_eq!(desktop_release_identity_from_bytes(&bom), Some(expected));
        for (key, value) in [
            ("dirty", serde_json::json!(true)), ("app", serde_json::json!("other")),
            ("commit", serde_json::json!("0.1.0")), ("generatedAt", serde_json::json!("")),
        ] {
            let mut invalid = manifest.clone();
            invalid[key] = value;
            assert_eq!(desktop_release_identity_from_bytes(&serde_json::to_vec(&invalid).unwrap()), None);
        }
        assert_eq!(desktop_release_identity_from_bytes(b"not JSON"), None);
    }

    #[test]
    fn desktop_update_browser_action_only_accepts_exact_trusted_zip_urls() {
        let url = format!("https://barorok.ecomarin.workers.dev/downloads/lmo_audio_update_{}.zip", "a".repeat(40));
        assert!(is_desktop_update_download_url(&url));
        for candidate in [format!("{url}?token=x"), format!("{url}#fragment"),
            url.replace("https:", "http:"), url.replace(".zip", ".exe"),
            url.replace("barorok.ecomarin.workers.dev", "other.example"),
            url.replace(&"a".repeat(40), "aaaaaaa"),
        ] {
            assert!(!is_desktop_update_download_url(&candidate));
        }
    }
}

#[cfg(target_os = "windows")]
fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn confirm_app_close() -> bool {
    let text = to_wide(
        "앱을 종료할까요?\n진행 중인 분석은 중단되고, 저장하지 않은 작성/편집 내용은 사라질 수 있습니다.",
    );
    let caption = to_wide("lmo_audio 종료 확인");
    let result = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2,
        )
    };
    result == IDYES
}

#[cfg(not(target_os = "windows"))]
fn confirm_app_close() -> bool {
    true
}

fn spawn_backend(app: &AppHandle, port: u16, desktop_action_token: &str) -> Result<Child, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve resource directory: {error}"))?;
    let backend_dir = resource_dir.join("backend");
    let sidecar_path = resource_dir.join("binaries").join(BACKEND_SIDECAR);
    let log_dir = resource_dir.join("logs");
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Could not create log directory at {log_dir:?}: {error}"))?;
    let stdout_log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(log_dir.join("sidecar.stdout.log"))
        .map_err(|error| format!("Could not open sidecar stdout log: {error}"))?;
    let stderr_log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(log_dir.join("sidecar.stderr.log"))
        .map_err(|error| format!("Could not open sidecar stderr log: {error}"))?;

    let mut command = Command::new(&sidecar_path);
    command
        .current_dir(&backend_dir)
        .env("MEETING_AI_BACKEND_DIR", backend_dir)
        .env("ANALYSIS_MODE", "real")
        .env("PORT", port.to_string())
        .env("LMO_DESKTOP_ACTION_TOKEN", desktop_action_token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));

    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000 | 0x00000008);

    let child = command
        .spawn()
        .map_err(|error| format!("Could not start backend sidecar at {sidecar_path:?}: {error}"))?;

    Ok(child)
}

pub fn run() {
    let backend_port = find_available_port().unwrap_or(PREFERRED_BACKEND_PORT);
    let backend_base_url = format!("http://127.0.0.1:{backend_port}");
    let backend_config = BackendConfig {
        base_url: backend_base_url,
        desktop_action_token: make_desktop_action_token(),
    };

    tauri::Builder::default()
        .manage(backend_config.clone())
        .manage(BackendProcess {
            child: Mutex::new(None),
            port: backend_port,
        })
        .manage(CloseGuardState {
            active: AtomicBool::new(false),
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_backend_base_url,
            get_desktop_action_token,
            get_desktop_release_identity,
            restart_backend,
            set_close_guard_active,
            open_saved_file_location,
            open_external_url,
            write_frontend_log
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            match spawn_backend(&app_handle, backend_port, &backend_config.desktop_action_token) {
                Ok(child) => {
                    let backend = app.state::<BackendProcess>();
                    if let Ok(mut slot) = backend.child.lock() {
                        *slot = Some(child);
                    };
                }
                Err(error) => {
                    write_backend_error_log(&app_handle, "startup-error.log", &error);
                    eprintln!("{error}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_guard = window.state::<CloseGuardState>();
                if close_guard.active.load(Ordering::SeqCst) && !confirm_app_close() {
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application")
        .run(move |app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let backend = app_handle.state::<BackendProcess>();
                if let Ok(mut slot) = backend.child.lock() {
                    if let Some(mut child) = slot.take() {
                        let _ = child.kill();
                    }
                };
            }
        });
}
