use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::ShellExt;

fn spawn_backend(app: &tauri::App) -> Result<tauri_plugin_shell::process::CommandChild, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve resource directory: {error}"))?;
    let backend_dir = resource_dir.join("backend");

    let (_events, child) = app
        .shell()
        .sidecar("binaries/meeting-backend")
        .map_err(|error| format!("Could not create backend sidecar command: {error}"))?
        .env("MEETING_AI_BACKEND_DIR", backend_dir)
        .env("ANALYSIS_MODE", "real")
        .spawn()
        .map_err(|error| format!("Could not start backend sidecar: {error}"))?;

    Ok(child)
}

pub fn run() {
    let backend_child: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>> =
        Arc::new(Mutex::new(None));
    let setup_backend_child = Arc::clone(&backend_child);
    let shutdown_backend_child = Arc::clone(&backend_child);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            match spawn_backend(app) {
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
                    if let Some(child) = slot.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
