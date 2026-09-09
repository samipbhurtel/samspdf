const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

// ── Create ZIP from PDF files ──

function createZip(pdfFiles, zipPath) {
  return new Promise((resolve, reject) => {
    if (!pdfFiles || pdfFiles.length === 0) {
      return reject(new Error("No PDF files to zip"));
    }

    const output = fs.createWriteStream(zipPath);
    const archive = new archiver.ZipArchive({ zlib: { level: 6 } });

    output.on("close", () => {
      resolve({
        zipPath: zipPath,
        zipSize: archive.pointer(),
      });
    });

    archive.on("error", (err) => {
      reject(new Error("ZIP creation failed: " + err.message));
    });

    archive.pipe(output);

    for (const pdf of pdfFiles) {
      if (fs.existsSync(pdf.filePath)) {
        archive.file(pdf.filePath, { name: pdf.pdfName });
      }
    }

    archive.finalize();
  });
}

// ── Validate ZIP integrity ──

function validateZip(zipPath, expectedPdfNames) {
  try {
    if (!fs.existsSync(zipPath)) {
      return { valid: false, error: "ZIP file does not exist" };
    }

    const stat = fs.statSync(zipPath);
    if (stat.size === 0) {
      return { valid: false, error: "ZIP file is empty" };
    }

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    // Check for PDFs only
    const pdfEntries = entries.filter((e) => !e.isDirectory && e.entryName.endsWith(".pdf"));

    if (pdfEntries.length === 0) {
      return { valid: false, error: "ZIP contains no PDF files" };
    }

    // Check no Word documents leaked in
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const ext = path.extname(entry.entryName).toLowerCase();
      if (ext === ".doc" || ext === ".docx") {
        return { valid: false, error: "ZIP contains source Word documents" };
      }
    }

    // Check expected PDFs are present
    const entryNames = new Set(pdfEntries.map((e) => e.entryName));
    for (const name of expectedPdfNames) {
      if (!entryNames.has(name)) {
        return { valid: false, error: "ZIP missing expected PDF: " + name };
      }
    }

    return { valid: true, pdfCount: pdfEntries.length };
  } catch (err) {
    return { valid: false, error: "Failed to validate ZIP: " + err.message };
  }
}

module.exports = {
  createZip,
  validateZip,
};
