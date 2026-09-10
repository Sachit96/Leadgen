/**
 * Hands a `tel:` URI to the operating system without navigating the page.
 *
 * The obvious implementations both strand the document. Assigning
 * `window.location.href`, and letting an `<a href="tel:">` navigate, each start
 * a navigation the browser can only finish by handing off to a protocol
 * handler. Where no handler is registered — a desktop browser with no
 * softphone, a headless one — the navigation never resolves, and every `fetch`
 * from that document is cancelled from then on.
 *
 * On the call screen that meant an operator could press dial and then be unable
 * to record what happened, which is the one thing they must do next.
 *
 * A detached iframe absorbs the navigation instead: the OS still receives the
 * URI, and the parent document is never navigated, so the page stays alive.
 */
export function openDialer(uri: string): void {
  if (typeof document === 'undefined') return;
  if (!uri.startsWith('tel:')) return;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.style.display = 'none';
  document.body.appendChild(frame);

  try {
    frame.contentWindow?.location.replace(uri);
  } catch {
    // A browser that refuses the scheme outright has simply not dialled. The
    // attempt is already recorded server-side either way, and the operator can
    // read the number off the screen.
  }

  // Long enough for the handoff, short enough not to accumulate frames.
  window.setTimeout(() => frame.remove(), 2_000);
}
