// Desktop notifications, best effort on every platform.
//
// A notification is a courtesy, never a dependency. Every failure path here is
// swallowed: an ingest that worked must not be reported as failed because the
// machine had no way to show a bubble.

import { execFileSync } from 'node:child_process';
import { notifierKind, has } from './platform.mjs';

const TITLE = 'Agent history -> wiki';

/**
 * Ask the platform to show a notification. Returns the mechanism that accepted the
 * request, or null if none would take it. Never throws.
 *
 * A returned mechanism means the notifier accepted the request, NOT that anyone saw
 * a banner. `osascript display notification` exits zero whether or not the
 * notification is displayed: delivery depends on the host terminal holding
 * notification permission and on Focus not suppressing it, and neither is visible
 * from here. `notify-send` behaves the same way with no session bus.
 *
 * This is why every caller logs the headline before calling this, and why nothing
 * downstream depends on the return value. A notification is a courtesy; the log is
 * the record.
 */
export function notify(message, title = TITLE) {
  const kind = notifierKind();
  if (!kind) return null;

  try {
    switch (kind) {
      case 'osascript': {
        // AppleScript string literals escape with a backslash.
        const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        execFileSync(
          'osascript',
          ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`],
          { stdio: 'ignore', timeout: 10000 },
        );
        return 'osascript';
      }

      case 'notify-send': {
        execFileSync('notify-send', ['--app-name=obsidian-wiki', title, message], {
          stdio: 'ignore',
          timeout: 10000,
        });
        return 'notify-send';
      }

      case 'powershell': {
        const exe = has('pwsh') ? 'pwsh' : 'powershell';
        // BurntToast when present, otherwise a Windows Forms balloon. Single-quoted
        // PowerShell strings escape a quote by doubling it.
        const esc = (s) => s.replace(/'/g, "''");
        const script = [
          `$t='${esc(title)}'; $m='${esc(message)}'`,
          'if (Get-Module -ListAvailable -Name BurntToast) {',
          '  Import-Module BurntToast; New-BurntToastNotification -Text $t,$m; exit',
          '}',
          'Add-Type -AssemblyName System.Windows.Forms',
          '$i = New-Object System.Windows.Forms.NotifyIcon',
          '$i.Icon = [System.Drawing.SystemIcons]::Information',
          '$i.BalloonTipTitle = $t; $i.BalloonTipText = $m',
          '$i.Visible = $true; $i.ShowBalloonTip(10000)',
          'Start-Sleep -Seconds 1; $i.Dispose()',
        ].join('; ');
        execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: 'ignore',
          timeout: 15000,
        });
        return exe;
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}
