//! Playback source for the meeting detail view's synced player.
//!
//! The pipeline keeps the mixed recording next to the meeting markdown
//! (`<slug>.md` → `<slug>.wav`). Meetings are long, so the audio is streamed
//! through the asset protocol instead of being inlined as a data URL. The
//! protocol's static scope is empty; each file is allowed individually, only
//! after its meeting path has passed the same output-dir validation the
//! detail view uses.

use minutes_core::config::Config;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Audio containers the pipeline writes or imports, in preference order.
const AUDIO_EXTENSIONS: &[&str] = &["wav", "m4a", "mp3", "ogg", "webm"];

/// Return the playable recording for a meeting, or `None` when the audio was
/// never captured, was cleaned up by retention, or the meeting is
/// no-capture.
#[tauri::command]
pub fn cmd_meeting_audio_source(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("Play meeting audio in the main Minutes window.".into());
    }
    let config = Config::load();
    let meeting_path = PathBuf::from(&path);
    minutes_core::notes::validate_meeting_path(&meeting_path, &config.output_dir)?;
    if is_no_capture(&meeting_path)? {
        return Ok(None);
    }
    let Some(audio) = sibling_audio(&meeting_path) else {
        return Ok(None);
    };
    app.asset_protocol_scope()
        .allow_file(&audio)
        .map_err(|e| format!("Could not open meeting audio: {e}"))?;
    Ok(Some(audio.to_string_lossy().into_owned()))
}

fn is_no_capture(meeting_path: &Path) -> Result<bool, String> {
    let content = std::fs::read_to_string(meeting_path).map_err(|e| e.to_string())?;
    let (frontmatter, _) = minutes_core::markdown::split_frontmatter(&content);
    let frontmatter: minutes_core::markdown::Frontmatter =
        serde_yaml::from_str(frontmatter.trim()).map_err(|e| e.to_string())?;
    Ok(frontmatter.capture.is_some())
}

/// Find `<stem>.<ext>` beside the meeting file. Per-source stems
/// (`<stem>.voice.wav`, `<stem>.system.wav`) are never chosen: the mixed
/// file is the one that matches the transcript's timeline for both sides.
fn sibling_audio(meeting_path: &Path) -> Option<PathBuf> {
    let canonical = meeting_path.canonicalize().ok()?;
    AUDIO_EXTENSIONS
        .iter()
        .map(|ext| canonical.with_extension(ext))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn sibling_audio_prefers_mixed_wav_over_stems() {
        let dir = TempDir::new().unwrap();
        let meeting = dir.path().join("2026-10-30-demo.md");
        std::fs::write(&meeting, "---\ntitle: Demo\n---\n").unwrap();
        std::fs::write(dir.path().join("2026-10-30-demo.voice.wav"), b"x").unwrap();
        std::fs::write(dir.path().join("2026-10-30-demo.wav"), b"x").unwrap();

        let found = sibling_audio(&meeting).unwrap();
        assert_eq!(found.file_name().unwrap(), "2026-10-30-demo.wav");
    }

    #[test]
    fn sibling_audio_ignores_stem_only_meetings() {
        let dir = TempDir::new().unwrap();
        let meeting = dir.path().join("memo.md");
        std::fs::write(&meeting, "---\ntitle: Memo\n---\n").unwrap();
        std::fs::write(dir.path().join("memo.system.wav"), b"x").unwrap();

        assert!(sibling_audio(&meeting).is_none());
    }

    #[test]
    fn sibling_audio_falls_back_to_imported_container() {
        let dir = TempDir::new().unwrap();
        let meeting = dir.path().join("import.md");
        std::fs::write(&meeting, "---\ntitle: Import\n---\n").unwrap();
        std::fs::write(dir.path().join("import.m4a"), b"x").unwrap();

        let found = sibling_audio(&meeting).unwrap();
        assert_eq!(found.extension().unwrap(), "m4a");
    }
}
