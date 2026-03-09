use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionError {
    file: String,
    error: String,
    kind: String,
    source_path: Option<String>,
    checked_cells: Option<Vec<Value>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionResponse {
    files_scanned: usize,
    rows: Vec<Value>,
    errors: Vec<ExtractionError>,
    halted: bool,
    halted_reason: Option<String>,
    halted_at_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchProgressEvent {
    current_file: String,
}

fn has_stencil_package(path: &Path) -> bool {
    path.join("stencilpy").join("__init__.py").is_file()
}

fn resolve_stencil_pythonpath(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut checked_paths: Vec<String> = Vec::new();

    let local_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("stencilpy")
        .join("src");
    checked_paths.push(local_path.display().to_string());
    if has_stencil_package(&local_path) {
        return local_path
            .canonicalize()
            .map_err(|e| format!("Failed to resolve local stencilpy path: {e}"));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {e}"))?;

    let bundled_candidates = vec![
        resource_dir.join("stencilpy").join("src"),
        resource_dir.join("src"),
        resource_dir.join("python"),
        resource_dir.clone(),
    ];

    for candidate in bundled_candidates {
        checked_paths.push(candidate.display().to_string());
        if has_stencil_package(&candidate) {
            return candidate
                .canonicalize()
                .map_err(|e| format!("Failed to resolve bundled stencilpy path: {e}"));
        }
    }

    Err(format!(
        "Could not find stencilpy package. Checked paths: {}",
        checked_paths.join(", ")
    ))
}

fn build_pythonpath(local: &Path) -> Result<OsString, String> {
    let mut paths = vec![local.to_path_buf()];
    if let Some(existing) = env::var_os("PYTHONPATH") {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths).map_err(|e| format!("Failed to construct PYTHONPATH: {e}"))
}

fn spawn_python(
    script: &str,
    schema_path: &Path,
    directory_path: &str,
    glob_filter: &str,
    stop_on_unmatched: bool,
    resume_from_path: Option<String>,
    pythonpath: &OsString,
) -> Result<Child, String> {
    let candidates: Vec<(&str, Vec<&str>)> = if cfg!(target_os = "windows") {
        vec![("py", vec!["-3"]), ("python", vec![]), ("python3", vec![])]
    } else {
        vec![("python3", vec![]), ("python", vec![])]
    };

    let mut errors: Vec<String> = Vec::new();

    for (bin, prefix_args) in candidates {
        let mut command = Command::new(bin);
        for arg in prefix_args {
            command.arg(arg);
        }

        let spawn_result = command
            .arg("-c")
            .arg(script)
            .arg(schema_path)
            .arg(directory_path)
            .arg(glob_filter)
            .arg(if stop_on_unmatched { "true" } else { "false" })
            .arg(resume_from_path.clone().unwrap_or_default())
            .env("PYTHONPATH", pythonpath)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        match spawn_result {
            Ok(child) => return Ok(child),
            Err(e) => errors.push(format!("{bin}: {e}")),
        }
    }

    Err(format!(
        "Failed to start Python interpreter. Tried python launchers: {}",
        errors.join(" | ")
    ))
}

#[tauri::command]
fn run_stencil_on_directory(
    app: tauri::AppHandle,
    schema_yaml: String,
    directory_path: String,
    glob_filter: String,
    stop_on_unmatched: bool,
    resume_from_path: Option<String>,
) -> Result<ExtractionResponse, String> {
    let local_path = resolve_stencil_pythonpath(&app)?;
    let pythonpath = build_pythonpath(&local_path)?;
    let dir = PathBuf::from(&directory_path);
    if !dir.exists() {
        return Err(format!("Directory not found: {directory_path}"));
    }
    if !dir.is_dir() {
        return Err(format!("Path is not a directory: {directory_path}"));
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Clock error: {e}"))?
        .as_nanos();
    let schema_path = env::temp_dir().join(format!("stencil-editor-{nonce}.stencil.yaml"));
    fs::write(&schema_path, schema_yaml)
        .map_err(|e| format!("Failed to write temporary schema file: {e}"))?;

    let script = r#"
import json
import sys
from pathlib import Path

schema_path = Path(sys.argv[1])
dir_path = Path(sys.argv[2])
glob_filter = sys.argv[3] if len(sys.argv) > 3 else "*"
stop_on_unmatched = (sys.argv[4].lower() == "true") if len(sys.argv) > 4 else False
resume_from_path = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None

try:
    from stencilpy import Stencil, VersionError
    from stencilpy.extractor import read_cell
    from stencilpy.versioning import resolve_version
    import yaml
except Exception as e:
    print(json.dumps({"_fatal": f"Failed to import stencilpy dependencies: {e}"}))
    sys.exit(0)

import fnmatch

excel_files = []
for pattern in ("**/*.xlsx", "**/*.xlsm", "**/*.xls"):
    excel_files.extend(sorted(dir_path.glob(pattern)))

# Keep order stable while de-duplicating
seen = set()
unique_files = []
for f in excel_files:
    key = str(f.resolve())
    if key in seen:
        continue
    seen.add(key)
    rel = str(f.relative_to(dir_path))
    if fnmatch.fnmatch(rel, glob_filter) or fnmatch.fnmatch(f.name, glob_filter):
        unique_files.append(f)

if resume_from_path:
    start_idx = None
    for idx, path in enumerate(unique_files):
        if str(path) == resume_from_path:
            start_idx = idx
            break
    if start_idx is None:
        print(json.dumps({
            "_fatal": f"Resume path not found in filtered files: {resume_from_path}"
        }))
        sys.exit(0)
    unique_files = unique_files[start_idx:]

stencil = Stencil(schema_path)
schema = stencil._schemas[0]
discriminator_cells = list(schema.discriminator_cells) or ["A1"]

rows = []
errors = []
halted = False
halted_reason = None
halted_at_path = None
for path in unique_files:
    print(f"PROGRESS\t{path}", file=sys.stderr, flush=True)
    try:
        resolved = resolve_version(schema, path)
        model = stencil._extract_with_schema(schema, path, version_key=resolved.version_key)
        row = model.model_dump(mode="json")
        if not isinstance(row, dict):
            row = {"value": row}
        row["_source_file"] = path.name
        row["_source_path"] = str(path)
        row["_discriminator_cell"] = resolved.matched_cell or "<inferred>"
        rows.append(row)
        continue
    except VersionError:
        checked_cells = []
        for disc_cell in discriminator_cells:
            try:
                val = read_cell(path, disc_cell)
                checked_cells.append({
                    "cell": disc_cell,
                    "value": "" if val is None else str(val).strip(),
                })
            except Exception as read_err:
                checked_cells.append({
                    "cell": disc_cell,
                    "value": f"<error: {read_err}>",
                })

        errors.append({
            "file": str(path),
            "source_path": str(path),
            "kind": "discriminator_mismatch",
            "error": "No schema version matched configured discriminator cells and layout inference was inconclusive",
            "checked_cells": checked_cells,
        })

        if stop_on_unmatched:
            halted = True
            halted_reason = f"Stopped at {path} because discriminator did not match"
            halted_at_path = str(path)
            break

        continue
    except Exception as e:
        errors.append({
            "file": str(path),
            "source_path": str(path),
            "kind": "extraction_error",
            "error": str(e),
        })
        continue

print(json.dumps({
    "files_scanned": len(unique_files),
    "rows": rows,
    "errors": errors,
    "halted": halted,
    "halted_reason": halted_reason,
    "halted_at_path": halted_at_path,
}))
"#;

    let mut child = spawn_python(
        script,
        &schema_path,
        &directory_path,
        &glob_filter,
        stop_on_unmatched,
        resume_from_path,
        &pythonpath,
    )?;

    let stderr_capture = Arc::new(Mutex::new(String::new()));
    let stderr_capture_clone = Arc::clone(&stderr_capture);
    let app_clone = app.clone();

    let stderr_thread = child.stderr.take().map(|stderr| {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let line = match line {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(path) = line.strip_prefix("PROGRESS\t") {
                    let _ = app_clone.emit(
                        "batch-extract-progress",
                        BatchProgressEvent {
                            current_file: path.to_string(),
                        },
                    );
                    continue;
                }
                if let Ok(mut captured) = stderr_capture_clone.lock() {
                    captured.push_str(&line);
                    captured.push('\n');
                }
            }
        })
    });

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed while waiting for python3: {e}"))?;

    if let Some(thread) = stderr_thread {
        let _ = thread.join();
    }

    let _ = fs::remove_file(&schema_path);

    if !output.status.success() {
        let stderr = stderr_capture
            .lock()
            .map(|captured| captured.clone())
            .unwrap_or_else(|_| String::new());
        return Err(format!("Python process failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse extraction output: {e}"))?;

    if let Some(fatal) = raw.get("_fatal").and_then(Value::as_str) {
        return Err(fatal.to_string());
    }

    serde_json::from_value(raw)
        .map_err(|e| format!("Invalid extraction response: {e}"))
}

#[tauri::command]
fn read_file_bytes(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(&file_path).map_err(|e| format!("Failed to read file '{file_path}': {e}"))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_stencil_on_directory,
            read_file_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
