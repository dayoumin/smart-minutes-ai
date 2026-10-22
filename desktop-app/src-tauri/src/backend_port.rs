use std::net::TcpListener;

// The installed web engine always listens on 17863. Desktop must leave it
// available even when the desktop application is started first.
const WEB_ENGINE_PORT: u16 = 17863;
pub const PREFERRED_BACKEND_PORT: u16 = WEB_ENGINE_PORT + 1;
const PREFERRED_BACKEND_PORT_ATTEMPTS: u16 = 100;

pub fn find_available_port() -> Result<u16, String> {
    for offset in 0..PREFERRED_BACKEND_PORT_ATTEMPTS {
        let candidate = PREFERRED_BACKEND_PORT + offset;
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Ok(candidate);
        }
    }

    loop {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("Could not reserve an analysis port: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Could not read reserved analysis port: {error}"))?
            .port();
        if port != WEB_ENGINE_PORT {
            return Ok(port);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    static PORT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn desktop_leaves_web_port_available() {
        let _guard = PORT_TEST_LOCK.lock().unwrap();
        // An already running web engine is allowed; never stop it for a test.
        let web = TcpListener::bind(("127.0.0.1", WEB_ENGINE_PORT)).ok();
        let desktop_port = find_available_port().expect("desktop port");
        assert_ne!(desktop_port, WEB_ENGINE_PORT);
        let _desktop = TcpListener::bind(("127.0.0.1", desktop_port)).expect("desktop bind");
        if let Some(web) = web {
            drop(web);
            let _later_web = TcpListener::bind(("127.0.0.1", WEB_ENGINE_PORT))
                .expect("web can start while desktop is running");
        } else {
            println!("web port is owned externally; verified desktop selection only");
        }
    }

    #[test]
    fn desktop_first_does_not_take_idle_web_port() {
        let _guard = PORT_TEST_LOCK.lock().unwrap();
        let Ok(web) = TcpListener::bind(("127.0.0.1", WEB_ENGINE_PORT)) else {
            println!("desktop-first order not exercised: web port is owned externally");
            return;
        };
        drop(web);
        let port = find_available_port().expect("desktop port while web is stopped");
        assert_ne!(port, WEB_ENGINE_PORT);
        let _desktop = TcpListener::bind(("127.0.0.1", port)).expect("desktop bind");
        let _web = TcpListener::bind(("127.0.0.1", WEB_ENGINE_PORT))
            .expect("web can start after desktop");
        println!("desktop-first order exercised with idle web port");
    }

    #[test]
    fn exhausted_preferred_range_uses_non_web_ephemeral_port() {
        let _guard = PORT_TEST_LOCK.lock().unwrap();
        // Hold only ports we can bind ourselves; leave external owners intact.
        let _occupied: Vec<_> = (0..PREFERRED_BACKEND_PORT_ATTEMPTS)
            .filter_map(|offset| TcpListener::bind(("127.0.0.1", PREFERRED_BACKEND_PORT + offset)).ok())
            .collect();
        let port = find_available_port().expect("ephemeral fallback port");
        assert_ne!(port, WEB_ENGINE_PORT);
        assert!(!(PREFERRED_BACKEND_PORT..PREFERRED_BACKEND_PORT + PREFERRED_BACKEND_PORT_ATTEMPTS).contains(&port));
        let _fallback = TcpListener::bind(("127.0.0.1", port)).expect("fallback bind");
    }

    #[test]
    fn occupied_desktop_port_is_skipped() {
        let _guard = PORT_TEST_LOCK.lock().unwrap();
        let port = find_available_port().expect("first desktop port");
        let _first = TcpListener::bind(("127.0.0.1", port)).expect("first desktop bind");
        let next = find_available_port().expect("second desktop port");
        assert_ne!(next, port);
        assert_ne!(next, WEB_ENGINE_PORT);
    }
}
