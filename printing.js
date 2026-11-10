// Printing is isolated here. Replace printHtml with a native Bluetooth bridge later; callers stay unchanged.
export function printHtml(html) {
  document.getElementById('receipt').innerHTML = html;
  return new Promise(resolve => {
    const done = () => { window.removeEventListener('afterprint', done); resolve(); };
    window.addEventListener('afterprint', done);
    window.print(); // the bill is never cleared here, so a cancelled dialog loses nothing
  });
}
