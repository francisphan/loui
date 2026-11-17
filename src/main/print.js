// Printing the tab on screen: the system's print dialog, or straight to a PDF
// file (the page as printed, with its backgrounds).
const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

// win(): the window a dialog belongs to (the one being served, see tabs.as()).
function createPrint({ win, active }) {
  const page = () => {
    const wc = active()?.wc;
    return wc && !wc.isDestroyed() ? wc : null;
  };
  const writePdf = async (wc, file) => fs.promises.writeFile(file, await wc.printToPDF({ printBackground: true }));

  function print() {
    page()?.print({}, () => {});
  }

  // Asks where to save, starting in Downloads with the page's title as the name.
  async function savePdf() {
    const wc = page();
    if (!wc) return;
    const name = (wc.getTitle() || 'Page').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 100) || 'Page';
    const { canceled, filePath } = await dialog.showSaveDialog(win(), {
      title: 'Save as PDF',
      defaultPath: path.join(app.getPath('downloads'), `${name}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return;
    await writePdf(wc, filePath).catch((e) => dialog.showErrorBox("Couldn't save the PDF", e.message));
  }

  return {
    print, savePdf,
    // For the tests: the PDF, saved without the dialog.
    probes: { 'print:pdf': (file) => writePdf(page(), file).then(() => 'ok') },
  };
}

module.exports = { createPrint };
