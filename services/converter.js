const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── Configuration ──

const CONFIG = {
  CONVERSION_TIMEOUT_MS: 120 * 1000, // 120 seconds
  SUPPORTED_EXTENSIONS: [".doc", ".docx"],
};

// ── LibreOffice detection ──

function findLibreOffice() {
  const candidates = [
    "soffice",
    "libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "/usr/local/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/opt/homebrew/bin/soffice",
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // skip
    }
  }

  return null;
}

// ── Helpers ──

function getFileExtension(name) {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function getBaseName(filename) {
  const ext = getFileExtension(filename);
  return ext ? filename.slice(0, filename.length - ext.length) : filename;
}

function isSupportedFile(filename) {
  return CONFIG.SUPPORTED_EXTENSIONS.includes(getFileExtension(filename));
}

function rimrafSync(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (_) {
    // best-effort cleanup
  }
}

// ── PDF Validation ──

function validatePdf(pdfPath) {
  try {
    if (!fs.existsSync(pdfPath)) {
      return { valid: false, error: "PDF file was not created" };
    }

    const stat = fs.statSync(pdfPath);
    if (!stat.isFile()) {
      return { valid: false, error: "Output is not a file" };
    }

    if (stat.size === 0) {
      return { valid: false, error: "PDF file is empty" };
    }

    // Check PDF signature
    const fd = fs.openSync(pdfPath, "r");
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);

    const signature = buf.toString("ascii");
    if (signature !== "%PDF-") {
      return { valid: false, error: "File does not appear to be a valid PDF" };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: "Failed to validate PDF: " + err.message };
  }
}

// ── Conversion Queue (serialize LibreOffice calls) ──

let conversionQueue = Promise.resolve();

function enqueueConversion(fn) {
  conversionQueue = conversionQueue.then(fn).catch(() => {});
  return conversionQueue;
}

// ── Main conversion function ──

function convertWordToPdf(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    // Validate input
    if (!inputPath || typeof inputPath !== "string") {
      return reject(new Error("Invalid input path"));
    }

    if (!fs.existsSync(inputPath)) {
      return reject(new Error("Input file does not exist"));
    }

    const filename = path.basename(inputPath);
    if (!isSupportedFile(filename)) {
      return reject(new Error("Unsupported file type. Only DOC and DOCX are accepted."));
    }

    // Find LibreOffice
    const libreOfficePath = findLibreOffice();
    if (!libreOfficePath) {
      return reject(new Error("LibreOffice is not installed or not found"));
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Build arguments
    const args = [
      "--headless",
      "--norestore",
      "--convert-to", "pdf",
      "--outdir", outputDir,
      inputPath,
    ];

    // Execute LibreOffice (serialized to avoid conflicts)
    enqueueConversion(() => {
      return new Promise((innerResolve, innerReject) => {
        const child = execFile(
          libreOfficePath,
          args,
          {
            timeout: CONFIG.CONVERSION_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error) {
              if (error.killed) {
                return innerReject(new Error("Conversion timed out"));
              }
              return innerReject(new Error("Conversion failed"));
            }

            // Verify PDF was created
            const baseName = getBaseName(filename);
            const expectedPdf = path.join(outputDir, baseName + ".pdf");

            const validation = validatePdf(expectedPdf);
            if (!validation.valid) {
              return innerReject(new Error(validation.error));
            }

            innerResolve({
              pdfPath: expectedPdf,
              pdfName: baseName + ".pdf",
            });
          }
        );

        if (child) {
          child.on("error", (err) => {
            innerReject(new Error("Failed to start LibreOffice: " + err.message));
          });
        }
      });
    })
      .then(resolve)
      .catch(reject);
  });
}

// ── Exports ──

module.exports = {
  convertWordToPdf,
  findLibreOffice,
  isSupportedFile,
  validatePdf,
  rimrafSync,
  CONFIG,
};
