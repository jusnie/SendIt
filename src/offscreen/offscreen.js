// Chrome only: copies text for the service worker, which has no DOM.
const b = globalThis.browser ?? globalThis.chrome;

b.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'copy') return;
  const ta = document.getElementById('clip');
  ta.value = msg.text;
  ta.select();
  sendResponse(document.execCommand('copy'));
});
