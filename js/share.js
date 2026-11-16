/**
 * Copying plain-text summaries to paste into Torn chat. Chat is plain text, so each summary is a few
 * short lines; blank and missing lines are dropped.
 */

/** Join summary lines, leaving out empty ones and anything that isn't text (so `n && '…'` can skip a line). */
export const summaryText = (lines) => lines.filter((l) => typeof l === 'string' && l.trim() !== '').join('\n');

const whole = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** Money for chat: millions and billions short ($12.36m), anything smaller in full ($8,634). */
export function chatMoney(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const f = a >= 1e9 ? `${+(a / 1e9).toFixed(2)}b` : a >= 1e6 ? `${+(a / 1e6).toFixed(2)}m` : whole.format(Math.round(a));
  return (n < 0 ? '-$' : '$') + f;
}

/** Signed money for chat: +$1.2m, -$40,000. */
export const chatSigned = (n) => (n > 0 ? `+${chatMoney(n)}` : chatMoney(n));

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
