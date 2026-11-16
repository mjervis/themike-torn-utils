/**
 * Copying plain-text summaries to paste into Torn chat. Chat is plain text, so each summary is a few
 * short lines; blank and missing lines are dropped.
 */

/** Join summary lines, leaving out empty ones and anything that isn't text (so `n && '…'` can skip a line). */
export const summaryText = (lines) => lines.filter((l) => typeof l === 'string' && l.trim() !== '').join('\n');

/** Put `text` on the clipboard; true if it worked. Falls back to the old copy command where the Clipboard API is refused. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(el);
    try {
      el.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      el.remove();
    }
  }
}

/**
 * Copy the text `build()` returns when `btn` is clicked, flashing "Copied ✓" on the button.
 * `status(msg, isError)` reports the result; `build` returning nothing means there's nothing to copy yet.
 */
export async function copyFrom(btn, build, status) {
  const text = build();
  if (!text) return;
  if (!(await copyText(text))) {
    status('Your browser blocked the clipboard — copying didn\'t work.', true);
    return;
  }
  status('Summary copied — paste it into chat.');
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = 'Copied ✓';
  clearTimeout(btn._copied);
  btn._copied = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
}
