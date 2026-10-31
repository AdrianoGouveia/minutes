/* Export actions for the meeting detail view's "More actions" menu.
 *
 * PDF: a print-only copy of the open meeting is placed in #meeting-print and
 * the webview prints it; macOS's print panel offers "Save as PDF". The copy
 * stays hidden on screen and is dropped when the detail view closes, because
 * the print operation outlives the invoke that starts it.
 * Text and e-mail go through cmd_export_meeting_text / cmd_email_meeting.
 *
 * Exposes window.MinutesMeetingExport = { menuItems, clearPrintView }. */
(() => {
  'use strict';
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const PRINT_ID = 'meeting-print';
  // Interactive chrome that means nothing on paper.
  const SCREEN_ONLY = '.meeting-player, .detail-bottom-cta, button:not(.meeting-line-stamp), input, select';

  function clearPrintView() {
    document.getElementById(PRINT_ID)?.remove();
  }

  function buildPrintView(title) {
    clearPrintView();
    const scroll = document.getElementById('detail-scroll');
    const meta = document.getElementById('detail-meta');
    const view = document.createElement('article');
    view.id = PRINT_ID;
    view.setAttribute('aria-hidden', 'true');

    const heading = document.createElement('h1');
    heading.textContent = title || 'Meeting';
    view.appendChild(heading);
    if (meta?.textContent.trim()) {
      const line = document.createElement('p');
      line.className = 'meeting-print-meta';
      line.textContent = [...meta.children].map((chip) => chip.textContent).join(' · ');
      view.appendChild(line);
    }
    const content = scroll.cloneNode(true);
    content.removeAttribute('id');
    content.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    content.querySelectorAll(SCREEN_ONLY).forEach((el) => el.remove());
    content.querySelectorAll('.is-current').forEach((el) => el.classList.remove('is-current'));
    view.appendChild(content);
    document.body.appendChild(view);
  }

  /**
   * Native menu items for `meeting` ({ path, title }). The shell passes its
   * own label translator and error-reporting wrapper so these behave like the
   * menu's other entries.
   */
  function menuItems(meeting, { menuLabel, action, showActionToast }) {
    return [
      {
        text: menuLabel('Export as PDF…'),
        action: action('Export as PDF', async () => {
          buildPrintView(meeting.title);
          await window.print();
        }),
      },
      {
        text: menuLabel('Save as Text…'),
        action: action('Save as Text', async () => {
          const saved = await invoke('cmd_export_meeting_text', { path: meeting.path });
          if (saved) showActionToast('Saved as text');
        }),
      },
      {
        text: menuLabel('Send by E-mail…'),
        action: action('Send by E-mail', () => invoke('cmd_email_meeting', { path: meeting.path })),
      },
    ];
  }

  window.MinutesMeetingExport = { menuItems, clearPrintView };
})();
