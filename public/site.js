const localPreview = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const previewNotice = document.querySelector('.preview-indicator');
if (localPreview && previewNotice) previewNotice.hidden = false;
if (localPreview) document.querySelectorAll('[data-local-preview]').forEach(element => { element.hidden = false; });

document.querySelectorAll('[data-reading-comparison]').forEach(group => {
  group.querySelectorAll('[data-reading-image]').forEach(button => button.addEventListener('click', () => {
    const after = button.dataset.readingImage === 'after';
    const still = group.closest('.reading-comparison').querySelector('[data-reading-still]');
    still.src = `/media/reading-${after ? 'after' : 'before'}.webp`;
    still.alt = after ? 'The handover with leading letters emphasized' : 'The same handover in standard text';
    group.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
});

const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('.nav');
function closeMenu() {
  navigation?.classList.remove('open');
  menuButton?.setAttribute('aria-expanded', 'false');
}
menuButton?.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});
navigation?.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navigation?.classList.contains('open')) { closeMenu(); menuButton.focus(); }
});

document.querySelectorAll('[data-choice-group]').forEach(group => {
  const buttons = group.querySelectorAll('[data-choice]');
  buttons.forEach(button => button.addEventListener('click', () => {
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    const panel = document.getElementById(group.dataset.target);
    const template = document.getElementById(button.dataset.choice);
    panel.replaceChildren(template.content.cloneNode(true));
  }));
});


document.querySelectorAll('.signup-form').forEach(form => {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const input = form.querySelector('input[type=email]');
    const button = form.querySelector('button[type=submit]');
    const note = form.querySelector('[role=status]');
    if (localPreview) {
      note.dataset.state = 'success';
      note.textContent = 'Preview only. Your email has not been submitted or saved.';
      return;
    }
    button.disabled = true;
    button.textContent = 'Submitting…';
    note.textContent = '';
    try {
      const response = await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: input.value.trim() }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'We could not save your signup. Please try again.');
      note.dataset.state = 'success';
      note.textContent = 'You’re on the list. We’ll be in touch when early access opens.';
      form.reset();
    } catch (error) {
      note.dataset.state = 'error';
      note.textContent = error.message || 'Connection interrupted. Please try again.';
    } finally {
      button.disabled = false;
      button.textContent = 'Notify me';
    }
  });
});

// The site assistant stays connected to its existing service after publication.
// Local design review never sends visitor prompts to that service.
if (!localPreview) {
  const assistant = document.createElement('script');
  assistant.src = '/chat-widget.js';
  assistant.defer = true;
  document.body.appendChild(assistant);
}
