use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const BACKEND_SIDECAR: &str = "meeting-backend-x86_64-pc-windows-msvc.exe";
const PREFERRED_BACKEND_PORT: u16 = 17863;
const PREFERRED_BACKEND_PORT_ATTEMPTS: u16 = 100;

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

#[derive(Clone)]
struct BackendConfig {
    base_url: String,
}

struct CloseGuardState {
    active: AtomicBool,
}

#[tauri::command]
fn get_backend_base_url(config: State<'_, BackendConfig>) -> String {
    config.base_url.clone()
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

fn find_available_port() -> Result<u16, String> {
    for offset in 0..PREFERRED_BACKEND_PORT_ATTEMPTS {
        let candidate = PREFERRED_BACKEND_PORT + offset;
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Ok(candidate);
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve an analysis port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read reserved analysis port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn spawn_backend(app: &tauri::App, port: u16) -> Result<Child, String> {
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
    let backend_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let setup_backend_child = Arc::clone(&backend_child);
    let shutdown_backend_child = Arc::clone(&backend_child);

    tauri::Builder::default()
        .manage(BackendConfig {
            base_url: backend_base_url,
        })
        .manage(CloseGuardState {
            active: AtomicBool::new(false),
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_backend_base_url,
            set_close_guard_active,
            open_saved_file_location,
            write_frontend_log
        ])
        .setup(move |app| {
            match spawn_backend(app, backend_port) {
                Ok(child) => {
                    if let Ok(mut slot) = setup_backend_child.lock() {
                        *slot = Some(child);
                    }
                }
                Err(error) => {
                    if let Ok(resource_dir) = app.path().resource_dir() {
                        let log_dir = resource_dir.join("logs");
                        let _ = fs::create_dir_all(&log_dir);
                        let _ = fs::write(log_dir.join("startup-error.log"), &error);
                    }
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
        .run(move |_app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Ok(mut slot) = shutdown_backend_child.lock() {
                    if let Some(mut child) = slot.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
