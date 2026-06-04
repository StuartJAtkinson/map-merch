// Global generation progress + status, rendered into the persistent bottom strip
// (`.app-status-bar`). This is the single home for SVG / 3D / STL progress so the
// indicator always lives in the same place. Leaf module — imported by app.ts and the
// lazily-loaded viewers; it imports nothing else, so there is no import cycle.

let barEl: HTMLElement | null = null;
let fillEl: HTMLElement | null = null;
let msgEl: HTMLElement | null = null;
let doneTimer: ReturnType<typeof setTimeout> | null = null;
let resolved = false;

function els(): { barEl: HTMLElement | null; fillEl: HTMLElement | null; msgEl: HTMLElement | null } {
  if (!resolved) {
    barEl  = document.querySelector('.app-status-bar');
    fillEl = (barEl?.querySelector('.status-fill') as HTMLElement) ?? null;
    msgEl  = (barEl?.querySelector('.status-msg')  as HTMLElement) ?? null;
    resolved = true;
  }
  return { barEl, fillEl, msgEl };
}

export const Status = {
  /** Enter the busy state, reset the bar to 0 and show an initial message. */
  begin(msg: string): void {
    const { barEl, fillEl, msgEl } = els();
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    barEl?.classList.add('busy');
    if (msgEl) msgEl.textContent = msg;
    if (fillEl) {
      fillEl.style.transition = 'none';
      fillEl.style.width = '0%';
      void fillEl.offsetWidth;          // force reflow so the next width animates
      fillEl.style.transition = '';
    }
  },

  /** Set progress (0–1) and optionally update the message. */
  set(prog: number, msg?: string): void {
    const { fillEl, msgEl } = els();
    const pct = Math.max(0, Math.min(1, prog)) * 100;
    if (fillEl) fillEl.style.width = pct.toFixed(1) + '%';
    if (msg !== undefined && msgEl) msgEl.textContent = msg;
  },

  /** Update only the message, leaving progress untouched. */
  message(msg: string): void {
    const { msgEl } = els();
    if (msgEl) msgEl.textContent = msg;
  },

  /** Fill to 100%, then fade back to the idle (attribution-only) state. */
  done(): void {
    const { barEl, fillEl, msgEl } = els();
    if (fillEl) fillEl.style.width = '100%';
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      barEl?.classList.remove('busy');
      if (msgEl) msgEl.textContent = '';
      if (fillEl) {
        fillEl.style.transition = 'none';
        fillEl.style.width = '0%';
        void fillEl.offsetWidth;
        fillEl.style.transition = '';
      }
      doneTimer = null;
    }, 400);
  },
};
