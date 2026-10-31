//! Export actions for the meeting detail view: save as plain text and draft an
//! e-mail. PDF export needs no backend; the view prints itself through the
//! webview (`window.print()`), and macOS's print panel saves the PDF.

use minutes_core::config::Config;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

/// Body characters kept in a mailto draft. Mail clients and `open` handle long
/// URLs unevenly, so the e-mail carries the summary, not the transcript.
const EMAIL_BODY_MAX_CHARS: usize = 1800;

struct MeetingText {
    title: String,
    /// Markdown body without the YAML frontmatter.
    body: String,
}

fn load_meeting(path: &str) -> Result<(PathBuf, MeetingText), String> {
    let config = Config::load();
    let meeting_path = PathBuf::from(path);
    minutes_core::notes::validate_meeting_path(&meeting_path, &config.output_dir)?;
    let content = std::fs::read_to_string(&meeting_path).map_err(|e| e.to_string())?;
    let (frontmatter, body) = minutes_core::markdown::split_frontmatter(&content);
    let frontmatter: minutes_core::markdown::Frontmatter =
        serde_yaml::from_str(frontmatter.trim()).map_err(|e| e.to_string())?;
    Ok((
        meeting_path,
        MeetingText {
            title: frontmatter.title,
            body: body.trim().to_string(),
        },
    ))
}

/// Ask where to save, then write the meeting (title + body) as plain text.
/// Returns the saved path, or `None` when the save panel was cancelled.
#[tauri::command]
pub async fn cmd_export_meeting_text(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("Export meetings from the main Minutes window.".into());
    }
    let (meeting_path, meeting) = load_meeting(&path)?;
    let file_name = default_text_file_name(&meeting_path);
    // The save panel blocks until dismissed; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let Some(target) = app
            .dialog()
            .file()
            .set_file_name(&file_name)
            .add_filter("Text", &["txt"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let target = target.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&target, plain_text(&meeting)).map_err(|e| e.to_string())?;
        Ok(Some(target.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("Export failed: {e}"))?
}

/// Open a new e-mail draft with the meeting title and summary.
#[tauri::command]
pub fn cmd_email_meeting(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Share meetings from the main Minutes window.".into());
    }
    let (_, meeting) = load_meeting(&path)?;
    let url = mailto_url(&meeting.title, &email_body(&meeting.body));
    open_url(&url)
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<(), String> {
    // The shell plugin's open scope requires a recipient after `mailto:`; a
    // draft without one is still valid, so hand it to LaunchServices directly.
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|e| format!("Could not open your e-mail app: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open your e-mail app.".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn open_url(_url: &str) -> Result<(), String> {
    Err("E-mail drafts are only supported on macOS.".into())
}

fn default_text_file_name(meeting_path: &Path) -> String {
    let stem = meeting_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "meeting".into());
    format!("{stem}.txt")
}

fn plain_text(meeting: &MeetingText) -> String {
    format!("{}\n\n{}\n", meeting.title, meeting.body)
}

/// Everything before the transcript, trimmed to a mail-safe length.
fn email_body(body: &str) -> String {
    let summary = body.split("\n## Transcript").next().unwrap_or(body).trim();
    if summary.chars().count() <= EMAIL_BODY_MAX_CHARS {
        return summary.to_string();
    }
    let cut: String = summary.chars().take(EMAIL_BODY_MAX_CHARS).collect();
    format!("{}…", cut.trim_end())
}

fn mailto_url(subject: &str, body: &str) -> String {
    format!(
        "mailto:?subject={}&body={}",
        percent_encode(subject),
        percent_encode(body)
    )
}

/// RFC 3986 encoding: everything but unreserved characters. Spaces become
/// `%20` (not `+`, which mail clients show literally).
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_handles_spaces_newlines_and_accents() {
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("x\ny"), "x%0Ay");
        assert_eq!(percent_encode("ação"), "a%C3%A7%C3%A3o");
        assert_eq!(percent_encode("a&b=c?"), "a%26b%3Dc%3F");
    }

    #[test]
    fn email_body_stops_before_transcript() {
        let body = "## Summary\n\n- ok\n\n## Transcript\n\n[0:00] secret";
        assert_eq!(email_body(body), "## Summary\n\n- ok");
    }

    #[test]
    fn email_body_is_truncated_on_char_boundaries() {
        let body = "é".repeat(EMAIL_BODY_MAX_CHARS + 50);
        let out = email_body(&body);
        assert_eq!(out.chars().count(), EMAIL_BODY_MAX_CHARS + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn mailto_has_no_recipient_and_encoded_fields() {
        assert_eq!(
            mailto_url("Reunião 1", "oi"),
            "mailto:?subject=Reuni%C3%A3o%201&body=oi"
        );
    }

    #[test]
    fn text_file_name_follows_meeting_slug() {
        let name = default_text_file_name(Path::new("/m/2026-10-30-demo.md"));
        assert_eq!(name, "2026-10-30-demo.txt");
    }
}
