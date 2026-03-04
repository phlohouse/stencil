use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

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

fn local_stencil_pythonpath() -> Result<PathBuf, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("stencilpy")
        .join("src")
        .canonicalize()
        .map_err(|e| format!("Failed to resolve local stencilpy path: {e}"))?;
    Ok(path)
}

fn build_pythonpath(local: &PathBuf) -> String {
    let local_str = local.to_string_lossy();
    if let Some(existing) = env::var_os("PYTHONPATH") {
        let existing = existing.to_string_lossy();
        format!("{local_str}:{existing}")
    } else {
        local_str.to_string()
    }
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
    let local_path = local_stencil_pythonpath()?;
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
with open(schema_path, "r", encoding="utf-8") as f:
    schema_doc = yaml.safe_load(f) or {}
raw_disc = schema_doc.get("discriminator") or {}
discriminator_cells = raw_disc.get("cells") or []
if not discriminator_cells and raw_disc.get("cell"):
    discriminator_cells = [raw_disc.get("cell")]
if not discriminator_cells:
    discriminator_cells = [schema.discriminator_cell for schema in stencil._schemas if schema.discriminator_cell]
discriminator_cells = [str(cell).strip() for cell in discriminator_cells if str(cell).strip()]
if not discriminator_cells:
    discriminator_cells = ["A1"]

rows = []
errors = []
halted = False
halted_reason = None
halted_at_path = None
for path in unique_files:
    print(f"PROGRESS\t{path}", file=sys.stderr, flush=True)
    matched = False
    checked_cells = []
    for disc_cell in discriminator_cells:
        for schema in stencil._schemas:
            schema.discriminator_cell = disc_cell
        try:
            model = stencil.extract(path)
            row = model.model_dump(mode="json")
            if not isinstance(row, dict):
                row = {"value": row}
            row["_source_file"] = path.name
            row["_source_path"] = str(path)
            row["_discriminator_cell"] = disc_cell
            rows.append(row)
            matched = True
            break
        except VersionError:
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
            continue
        except Exception as e:
            errors.append({
                "file": str(path),
                "source_path": str(path),
                "kind": "extraction_error",
                "error": str(e),
                "checked_cells": checked_cells or None,
            })
            matched = True
            break

    if matched:
        continue

    errors.append({
        "file": str(path),
        "source_path": str(path),
        "kind": "discriminator_mismatch",
        "error": "No schema version matched discriminator values from configured discriminator cells",
        "checked_cells": checked_cells,
    })

    if stop_on_unmatched:
        halted = True
        halted_reason = f"Stopped at {path} because discriminator did not match"
        halted_at_path = str(path)
        break

print(json.dumps({
    "files_scanned": len(unique_files),
    "rows": rows,
    "errors": errors,
    "halted": halted,
    "halted_reason": halted_reason,
    "halted_at_path": halted_at_path,
}))
"#;

    let mut child = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(&schema_path)
        .arg(&directory_path)
        .arg(&glob_filter)
        .arg(if stop_on_unmatched { "true" } else { "false" })
        .arg(resume_from_path.unwrap_or_default())
        .env("PYTHONPATH", build_pythonpath(&local_path))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to execute python3: {e}"))?;

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
