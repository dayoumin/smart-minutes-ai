use std::net::TcpListener;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const BACKEND_SIDECAR: &str = "meeting-backend-x86_64-pc-windows-msvc.exe";

#[derive(Clone)]
struct BackendConfig {
    base_url: String,
}

#[tauri::command]
fn get_backend_base_url(config: State<'_, BackendConfig>) -> String {
    config.base_url.clone()
}

fn pick_backend_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not reserve backend port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read backend port: {error}"))?
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

    let mut command = Command::new(&sidecar_path);
    command
        .current_dir(&backend_dir)
        .env("MEETING_AI_BACKEND_DIR", backend_dir)
        .env("ANALYSIS_MODE", "real")
        .env("PORT", port.to_string());

    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let child = command
        .spawn()
        .map_err(|error| format!("Could not start backend sidecar at {sidecar_path:?}: {error}"))?;

    Ok(child)
}

pub fn run() {
    let backend_port = pick_backend_port().expect("error while reserving backend port");
    let backend_base_url = format!("http://127.0.0.1:{backend_port}");
    let backend_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let setup_backend_child = Arc::clone(&backend_child);
    let shutdown_backend_child = Arc::clone(&backend_child);

    tauri::Builder::default()
        .manage(BackendConfig {
            base_url: backend_base_url,
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_backend_base_url])
        .setup(move |app| {
            match spawn_backend(app, backend_port) {
                Ok(child) => {
                    if let Ok(mut slot) = setup_backend_child.lock() {
                        *slot = Some(child);
                    }
                }
                Err(error) => eprintln!("{error}"),
            }
            Ok(())
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
