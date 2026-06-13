use std::path::Path;

const DOTENV_KEYS: &[&str] = &["AVARK_SUBMITPACKAGE_URL", "AVARK_SUBMITPACKAGE_TOKEN"];

fn forward_dotenv_keys() {
    let dotenv = Path::new("../.env");
    if dotenv.exists() {
        println!("cargo:rerun-if-changed=../.env");
    }

    let dotenv_values: Vec<(String, String)> = match dotenvy::from_path_iter(dotenv) {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(), // no .env — the process env may still provide keys
    };

    for key in DOTENV_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        if std::env::var(key).is_ok_and(|v| !v.is_empty()) {
            continue;
        }
        if let Some((_, value)) = dotenv_values.iter().find(|(k, _)| k == key) {
            if !value.is_empty() && !value.contains('\n') {
                println!("cargo:rustc-env={key}={value}");
            }
        }
    }
}

fn main() {
    forward_dotenv_keys();
    tauri_build::build()
}
