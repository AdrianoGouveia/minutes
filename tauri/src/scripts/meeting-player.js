/* Synced audio player for the meeting detail view.
 *
 * The detail view renders the transcript section as plain text. When the
 * meeting still has its recording on disk, this module rebuilds that section
 * as one row per `[LABEL m:ss] text` line: clicking a timestamp seeks the
 * audio, and the line being spoken is highlighted and kept in view while it
 * plays. Without audio the original text rendering is left untouched.
 *
 * Exposes window.MinutesMeetingPlayer = { attach, detach }. */
(() => {
  'use strict';
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const toSrc = (path) => window.__TAURI__.core.convertFileSrc(path);
  // `[SPEAKER_1 0:06]`, `[MICROPHONE 1:08]`, `[00:00]`, `[Ana 1:02:03]`.
  const LINE = /^\[(?:(.*?)\s+)?(\d{1,2}(?::\d{2}){1,2})\]\s?(.*)$/;
  const SPEEDS = [1, 1.25, 1.5, 2];
  // A manual scroll pauses auto-follow until playback is quiet for this long.
  const FOLLOW_RESUME_MS = 4000;

  let audio = null;
  let rows = [];
  let current = -1;
  let attachId = 0;
  let lastManualScroll = 0;
  let programmaticScroll = false;

  function seconds(stamp) {
    return stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }

  function clock(value) {
    const total = Math.max(0, Math.floor(value || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  /** Split transcript text into timed lines; untimed lines join the previous one. */
  function parseTranscript(text) {
    const lines = [];
    for (const raw of (text || '').split('\n')) {
      const match = LINE.exec(raw.trim());
      if (match) {
        lines.push({ speaker: match[1] || '', start: seconds(match[2]), stamp: match[2], text: match[3] });
      } else if (raw.trim() && lines.length) {
        lines[lines.length - 1].text += `\n${raw.trim()}`;
      }
    }
    return lines;
  }

  // The detail view tags the transcript body; the visible title may be translated.
  function findTranscriptSection(scroll) {
    return scroll.querySelector('.detail-section-body[data-transcript]')?.closest('.detail-section') || null;
  }

  const watchedScrolls = new WeakSet();
  function watchManualScroll(scroll) {
    if (watchedScrolls.has(scroll)) return;
    watchedScrolls.add(scroll);
    scroll.addEventListener('scroll', () => {
      if (!programmaticScroll) lastManualScroll = Date.now();
    }, { passive: true });
  }

  function playSafely() {
    audio?.play().catch((error) => console.warn('Meeting audio play:', error));
  }

  // Before metadata arrives the element has no timeline and drops seeks.
  function seekTo(time) {
    if (!audio) return;
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      audio.currentTime = time;
      return;
    }
    const target = audio;
    target.addEventListener('loadedmetadata', () => { target.currentTime = time; }, { once: true });
    if (target.preload === 'none') target.load();
  }

  function button(label, title, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn btn-secondary btn-sm meeting-player-btn';
    el.textContent = label;
    el.title = title;
    el.setAttribute('aria-label', title);
    el.addEventListener('click', onClick);
    return el;
  }

  function buildBar(lines) {
    const bar = document.createElement('div');
    bar.className = 'meeting-player';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Meeting audio player');

    const play = button('▶', 'Play', () => (audio.paused ? playSafely() : audio.pause()));
    const back = button('−15s', 'Back 15 seconds', () => seekTo(Math.max(0, audio.currentTime - 15)));
    const fwd = button('+15s', 'Forward 15 seconds', () => seekTo(Math.min(audio.duration || Infinity, audio.currentTime + 15)));

    const seek = document.createElement('input');
    seek.type = 'range';
    seek.className = 'meeting-player-seek';
    seek.min = '0';
    seek.step = '0.1';
    seek.value = '0';
    seek.setAttribute('aria-label', 'Seek');
    seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); });

    const time = document.createElement('span');
    time.className = 'meeting-player-time';
    time.textContent = `0:00 / ${clock(lines[lines.length - 1]?.start)}`;

    let speedIndex = 0;
    const speed = button('1×', 'Playback speed', () => {
      speedIndex = (speedIndex + 1) % SPEEDS.length;
      audio.playbackRate = SPEEDS[speedIndex];
      speed.textContent = `${SPEEDS[speedIndex]}×`;
    });

    audio.addEventListener('play', () => { play.textContent = '❚❚'; play.title = 'Pause'; play.setAttribute('aria-label', 'Pause'); });
    audio.addEventListener('pause', () => { play.textContent = '▶'; play.title = 'Play'; play.setAttribute('aria-label', 'Play'); });
    audio.addEventListener('loadedmetadata', () => { seek.max = String(audio.duration || 0); });
    audio.addEventListener('timeupdate', () => {
      if (document.activeElement !== seek) seek.value = String(audio.currentTime);
      time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration)}`;
      highlight(audio.currentTime);
    });
    audio.addEventListener('error', () => {
      bar.replaceChildren();
      bar.classList.add('is-error');
      bar.textContent = 'Could not play this recording.';
    });

    bar.append(play, back, fwd, seek, time, speed);
    return bar;
  }

  function buildRows(lines, highlightText) {
    const list = document.createElement('div');
    list.className = 'detail-section-body meeting-transcript';
    rows = lines.map((line, index) => {
      const row = document.createElement('div');
      row.className = 'meeting-line';

      const stamp = document.createElement('button');
      stamp.type = 'button';
      stamp.className = 'meeting-line-stamp';
      stamp.textContent = line.stamp;
      stamp.title = `Play from ${line.stamp}`;
      stamp.addEventListener('click', () => {
        seekTo(line.start);
        lastManualScroll = 0;
        highlight(line.start, index);
        playSafely();
      });

      const speaker = document.createElement('span');
      speaker.className = 'meeting-line-speaker';
      speaker.textContent = line.speaker;

      const text = document.createElement('span');
      text.className = 'meeting-line-text';
      text.textContent = line.text;
      highlightText?.(text);

      row.append(stamp, speaker, text);
      list.appendChild(row);
      return { el: row, start: line.start };
    });
    return list;
  }

  function highlight(time, forced) {
    let index = forced ?? -1;
    if (index < 0) {
      // Rows are in time order; the active row is the last one already started.
      for (let i = 0; i < rows.length && rows[i].start <= time + 0.05; i++) index = i;
    }
    if (index === current) return;
    rows[current]?.el.classList.remove('is-current');
    current = index;
    const row = rows[current]?.el;
    if (!row) return;
    row.classList.add('is-current');
    if (!audio.paused && Date.now() - lastManualScroll > FOLLOW_RESUME_MS) {
      programmaticScroll = true;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => { programmaticScroll = false; }, 600);
    }
  }

  function detach() {
    attachId++;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    audio = null;
    rows = [];
    current = -1;
  }

  /**
   * Upgrade the rendered transcript of `detail` inside `scroll`.
   * `options.highlightText(el)` re-applies search highlighting to a line.
   */
  async function attach(detail, scroll, options = {}) {
    detach();
    const id = attachId;
    const section = findTranscriptSection(scroll);
    if (!section || !detail?.path) return;
    const transcript = (detail.sections || []).find((s) => /^transcript$/i.test(s.heading || ''));
    const lines = parseTranscript(transcript?.content);
    if (!lines.length) return;

    let source = null;
    try {
      source = await invoke('cmd_meeting_audio_source', { path: detail.path });
    } catch (error) {
      console.warn('Meeting audio:', error);
    }
    // A newer meeting was opened (or the view closed) while we waited.
    if (id !== attachId || !source || !section.isConnected) return;

    audio = new Audio();
    audio.preload = 'metadata';
    audio.src = toSrc(source);

    const body = section.querySelector('.detail-section-body');
    const list = buildRows(lines, options.highlightText);
    section.insertBefore(buildBar(lines), body);
    body.replaceWith(list);
    watchManualScroll(scroll);
  }

  window.MinutesMeetingPlayer = { attach, detach, parseTranscript };
})();
