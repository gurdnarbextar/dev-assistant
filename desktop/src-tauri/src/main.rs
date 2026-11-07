use std::{
    error::Error,
    io::{BufRead, BufReader, Error as IoError, ErrorKind},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};

use tauri::{
    webview::WebviewWindowBuilder,
    Manager,
    RunEvent,
    WebviewUrl,
};

fn io_error(message: impl Into<String>) -> IoError {
    IoError::new(ErrorKind::Other, message.into())
}

fn start_local_service(
    app: &tauri::AppHandle,
) -> Result<(Child, String), Box<dyn Error>> {
    let resource_dir = app.path().resource_dir()?;
    let bundled_cli = resource_dir.join("dist").join("index.js");

    let development_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;

    let (cli_path, working_directory) = if bundled_cli.is_file() {
        (bundled_cli, resource_dir)
    } else {
        (development_root.join("dist").join("index.js"), development_root)
    };

    if !cli_path.is_file() {
        return Err(io_error(format!(
            "Dev Assistant CLI was not found at {}. Build the Node project first.",
            cli_path.display()
        )).into());
    }

    let mut child = Command::new("node")
        .arg(&cli_path)
        .arg("gui")
        .current_dir(&working_directory)
        .env("DEV_ASSISTANT_TAURI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| io_error(format!(
            "Could not start Node.js. Install Node.js 22 or later and ensure 'node' is on PATH: {error}"
        )))?;

    let stdout = child.stdout.take()
        .ok_or_else(|| io_error("Could not capture the local service startup output."))?;

    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if let Some(url) = line.strip_prefix("Dev Assistant GUI running at ") {
                        let _ = sender.send(Ok(url.trim().to_string()));
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error.to_string()));
                    return;
                }
            }
        }
        let _ = sender.send(Err(
            "The Dev Assistant service stopped before it became ready.".to_string()
        ));
    });

    let url = match receiver.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(url)) => url,
        Ok(Err(error)) => {
            let _ = child.kill();
            return Err(io_error(error).into());
        }
        Err(error) => {
            let _ = child.kill();
            return Err(io_error(format!(
                "Timed out waiting for the local Dev Assistant service: {error}"
            )).into());
        }
    };

    if !url.starts_with("http://127.0.0.1:") {
        let _ = child.kill();
        return Err(io_error("The local service returned an unexpected address.").into());
    }

    Ok((child, url))
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let (child, url) = start_local_service(app.handle())?;
            app.manage(Mutex::new(child));

            let parsed_url = url.parse()
                .map_err(|error| io_error(format!("Invalid local service URL: {error}")))?;

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(parsed_url),
            )
            .title("Dev Assistant")
            .inner_size(1280.0, 840.0)
            .min_inner_size(900.0, 600.0)
            .on_navigation(|url| {
                url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
            })
            .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialise the Dev Assistant desktop application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(child_state) = handle.try_state::<Mutex<Child>>() {
                if let Ok(mut child) = child_state.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
