/** Scrolls to a message and flashes it, so the eye finds it. */
export function showMessage(id: string) {
  const target = document.getElementById('message-' + id);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.dataset.flash = 'true';
  setTimeout(() => {
    delete target.dataset.flash;
  }, 1600);
}
