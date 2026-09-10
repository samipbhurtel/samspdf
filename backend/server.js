const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const { convertWordToPdf, findLibreOffice, rimrafSync } = require("./services/converter");
const { createZip, validateZip } = require("./services/zipService");
const jobStore = require("./services/jobStore");

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.length === 0) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    }
  })
);
// ── Configuration ──

const CONFIG = {
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  MAX_FILES: 20,
  SUPPORTED_EXTENSIONS: [".doc", ".docx"],
  TEMP_ROOT: path.join(__dirname, "temp"),
  STALE_MAX_AGE_MS: 60 * 60 * 1000, // 1 hour
};

// ── Ensure temp directory exists ──

if (!fs.existsSync(CONFIG.TEMP_ROOT)) {
  fs.mkdirSync(CONFIG.TEMP_ROOT, { recursive: true });
}

// ── Stale temp directory cleanup on startup ──

function cleanStaleTempDirs() {
  try {
    const now = Date.now();
    const entries = fs.readdirSync(CONFIG.TEMP_ROOT);
    for (const entry of entries) {
      const dirPath = path.join(CONFIG.TEMP_ROOT, entry);
      try {
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory() && (now - stat.mtimeMs) > CONFIG.STALE_MAX_AGE_MS) {
          console.log("[CLEANUP] removing stale directory:", entry);
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      } catch (_) {
        // skip entries we can't stat
      }
    }
  } catch (_) {
    // temp dir may not exist yet
  }
}

cleanStaleTempDirs();

// ── Stale job cleanup on startup ──

jobStore.cleanStaleJobs(CONFIG.TEMP_ROOT);

// Periodic stale job cleanup
setInterval(() => {
  jobStore.cleanStaleJobs(CONFIG.TEMP_ROOT);
}, jobStore.CONFIG.STALE_CHECK_INTERVAL_MS);

// ── Helpers ──

function getFileExtension(name) {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function safeFilename(name) {
  const ext = getFileExtension(name);
  const baseName = ext ? name.slice(0, name.length - ext.length) : name;
  const safeBase = baseName
    .replace(/[^\w\s.-]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 100);
  return safeBase + ext;
}

function createRequestId() {
  return crypto.randomBytes(16).toString("hex");
}

// ── Idempotent cleanup factory ──

function makeCleanup(dirPath, requestId) {
  let cleaned = false;
  return function cleanup() {
    if (cleaned) return;
    cleaned = true;
    console.log("[CLEANUP] starting for request:", requestId);
    rimrafSync(dirPath);
    console.log("[CLEANUP] completed for request:", requestId);
  };
}

// ── Multer Configuration ──

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Use the requestId already set on the request (set in the route handler)
    const uploadDir = path.join(CONFIG.TEMP_ROOT, req.requestId);
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
    } catch (_) {
      return cb(new Error("Failed to create upload directory"));
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, safeFilename(file.originalname));
  },
});

function fileFilter(req, file, cb) {
  const ext = getFileExtension(file.originalname);
  if (!CONFIG.SUPPORTED_EXTENSIONS.includes(ext)) {
    return cb(null, false);
  }
  cb(null, true);
}

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: 1, // Phase 4: single file only
  },
});

// ── Upload Middleware ──

const uploadMiddleware = upload.single("file");

// ── Batch Upload Middleware ──

const batchUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      const jobDir = path.join(CONFIG.TEMP_ROOT, req.jobId);
      const uploadDir = path.join(jobDir, "input");
      try {
        fs.mkdirSync(uploadDir, { recursive: true });
      } catch (_) {
        return cb(new Error("Failed to create upload directory"));
      }
      cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
      cb(null, jobStore.safeFilename(file.originalname));
    },
  }),
  fileFilter: fileFilter,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: CONFIG.MAX_FILES,
  },
});

const batchUploadMiddleware = batchUpload.array("files", CONFIG.MAX_FILES);

// ── Batch Conversion Processing ──

let activeBatchJobs = 0;
const MAX_ACTIVE_BATCH_JOBS = 1;
const batchQueue = [];

function processBatchJob(jobId) {
  const job = jobStore.getJob(jobId);
  if (!job) return;

  if (activeBatchJobs >= MAX_ACTIVE_BATCH_JOBS) {
    batchQueue.push(jobId);
    return;
  }

  activeBatchJobs++;
  jobStore.updateJob(jobId, { status: "processing" });

  console.log("[BATCH] processing started:", jobId, "files:", job.totalCount);

  const outputDir = path.join(job.jobDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });

  // Find the first file that hasn't been processed yet
  const startIndex = job.files.findIndex((f) => f.status === "queued");
  if (startIndex === -1) {
    // All files already processed (e.g., all were pre-marked as failed)
    finishBatchJob(jobId);
    return;
  }

  processNextFile(jobId, startIndex, outputDir);
}

function processNextFile(jobId, fileIndex, outputDir) {
  const job = jobStore.getJob(jobId);
  if (!job) {
    console.log("[BATCH] job lost during processing:", jobId);
    activeBatchJobs--;
    processBatchQueue();
    return;
  }

  if (fileIndex >= job.files.length) {
    finishBatchJob(jobId);
    return;
  }

  const fileEntry = job.files[fileIndex];

  // Skip files that were already marked as failed (e.g., from validation)
  if (fileEntry.status === "failed") {
    processNextFile(jobId, fileIndex + 1, outputDir);
    return;
  }

  jobStore.updateFileStatus(jobId, fileIndex, { status: "converting" });

  console.log("[BATCH] File " + (fileIndex + 1) + "/" + job.totalCount + ": " + fileEntry.originalName + " → converting");

  convertWordToPdf(fileEntry.storedPath, outputDir)
    .then((result) => {
      const job = jobStore.getJob(jobId);
      if (!job) {
        console.log("[BATCH] job lost during conversion:", jobId);
        activeBatchJobs--;
        processBatchQueue();
        return;
      }

      jobStore.updateFileStatus(jobId, fileIndex, {
        status: "completed",
        outputName: result.pdfName,
        outputPath: result.pdfPath,
      });
      jobStore.incrementCompleted(jobId);

      console.log("[BATCH] File " + (fileIndex + 1) + "/" + job.totalCount + ": " + fileEntry.originalName + " → completed");

      try {
        processNextFile(jobId, fileIndex + 1, outputDir);
      } catch (err) {
        console.log("[BATCH] error processing next file:", jobId, err.message);
        activeBatchJobs--;
        processBatchQueue();
      }
    })
    .catch((error) => {
      const job = jobStore.getJob(jobId);
      if (!job) {
        console.log("[BATCH] job lost during error handling:", jobId);
        activeBatchJobs--;
        processBatchQueue();
        return;
      }

      let code = "CONVERSION_FAILED";
      let message = "Failed to convert the document.";

      if (error.message && error.message.includes("timed out")) {
        code = "CONVERSION_TIMEOUT";
        message = "The document took too long to convert.";
      } else if (error.message && error.message.includes("not installed")) {
        code = "LIBREOFFICE_NOT_FOUND";
        message = "Conversion service is not available.";
      } else if (error.message && error.message.includes("not found")) {
        code = "LIBREOFFICE_NOT_FOUND";
        message = "Conversion service is not available.";
      }

      jobStore.updateFileStatus(jobId, fileIndex, {
        status: "failed",
        errorCode: code,
        errorMessage: message,
      });
      jobStore.incrementFailed(jobId);

      console.log("[BATCH] File " + (fileIndex + 1) + "/" + job.totalCount + ": " + fileEntry.originalName + " → failed (" + code + ")");

      try {
        processNextFile(jobId, fileIndex + 1, outputDir);
      } catch (err) {
        console.log("[BATCH] error processing next file after failure:", jobId, err.message);
        activeBatchJobs--;
        processBatchQueue();
      }
    });
}

function finishBatchJob(jobId) {
  const job = jobStore.getJob(jobId);
  if (!job) {
    console.log("[BATCH] job lost in finishBatchJob:", jobId);
    activeBatchJobs--;
    processBatchQueue();
    return;
  }

  // Validate counts
  const accountedFor = job.completedCount + job.failedCount;
  if (accountedFor !== job.totalCount) {
    console.log("[BATCH] COUNT MISMATCH:", jobId, "total:", job.totalCount, "completed:", job.completedCount, "failed:", job.failedCount);
  }

  console.log("[BATCH] FINAL:", jobId, "total=" + job.totalCount, "completed=" + job.completedCount, "failed=" + job.failedCount);

  if (job.completedCount === 0) {
    // All conversions failed
    jobStore.updateJob(jobId, {
      status: "failed",
      error: { code: "ALL_CONVERSIONS_FAILED", message: "All file conversions failed." },
    });
    activeBatchJobs--;
    processBatchQueue();
    return;
  }

  // Resolve duplicate names and collect successful PDFs
  const successFiles = job.files
    .filter((f) => f.status === "completed" && f.outputPath)
    .map((f) => ({ filePath: f.outputPath, pdfName: f.outputName }));

  const resolved = jobStore.resolveDuplicateNames(successFiles.map((f) => ({ pdfName: f.pdfName })));
  for (let i = 0; i < successFiles.length; i++) {
    successFiles[i].pdfName = resolved[i].pdfName;
  }

  // Create ZIP
  const zipPath = path.join(job.jobDir, "converted-pdfs.zip");

  createZip(successFiles, zipPath)
    .then((result) => {
      const job = jobStore.getJob(jobId);
      if (!job) {
        activeBatchJobs--;
        processBatchQueue();
        return;
      }

      // Validate ZIP
      const expectedNames = successFiles.map((f) => f.pdfName);
      const validation = validateZip(zipPath, expectedNames);

      if (!validation.valid) {
        jobStore.updateJob(jobId, {
          status: "failed",
          error: { code: "ZIP_VALIDATION_FAILED", message: validation.error },
        });
        activeBatchJobs--;
        processBatchQueue();
        return;
      }

      jobStore.updateJob(jobId, {
        zipPath: zipPath,
        zipSize: result.zipSize,
      });

      jobStore.finalizeJob(jobId);

      console.log("[BATCH] job completed:", jobId, "status:", job.status);

      activeBatchJobs--;
      processBatchQueue();
    })
    .catch((error) => {
      jobStore.updateJob(jobId, {
        status: "failed",
        error: { code: "ZIP_CREATION_FAILED", message: "Failed to create ZIP: " + error.message },
      });
      activeBatchJobs--;
      processBatchQueue();
    });
}

function processBatchQueue() {
  while (batchQueue.length > 0 && activeBatchJobs < MAX_ACTIVE_BATCH_JOBS) {
    const nextJobId = batchQueue.shift();
    processBatchJob(nextJobId);
  }
}

// ── Routes ──



app.get("/api/health", (req, res) => {
  const loInstalled = findLibreOffice() !== null;
  res.json({
    status: "ok",
    libreoffice: loInstalled ? "available" : "not found",
  });
});

app.post("/api/convert", (req, res) => {
  const requestId = createRequestId();
  req.requestId = requestId;

  const uploadDir = path.join(CONFIG.TEMP_ROOT, requestId);
  const outputDir = path.join(uploadDir, "output");

  console.log("[CONVERT] request started:", requestId);

  // Ensure output directory exists (upload dir is created by multer destination)
  fs.mkdirSync(outputDir, { recursive: true });

  const cleanup = makeCleanup(uploadDir, requestId);

  // Wrap all response endings in cleanup
  res.on("finish", cleanup);
  res.on("close", cleanup);

  uploadMiddleware(req, res, function (err) {
    if (err) {
      console.log("[CONVERT] upload error:", requestId, err.code || err.message);
      cleanup();

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            success: false,
            error: { code: "FILE_TOO_LARGE", message: "The file exceeds the 50 MB limit." },
          });
        }
        if (err.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({
            success: false,
            error: { code: "TOO_MANY_FILES", message: "Phase 4 supports single-file conversion only." },
          });
        }
        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({
            success: false,
            error: { code: "INVALID_REQUEST", message: "Invalid upload request." },
          });
        }
        return res.status(400).json({
          success: false,
          error: { code: "UPLOAD_FAILED", message: "Upload failed." },
        });
      }

      return res.status(500).json({
        success: false,
        error: { code: "UPLOAD_FAILED", message: "An unexpected upload error occurred." },
      });
    }

    if (!req.file) {
      console.log("[CONVERT] no file uploaded:", requestId);
      cleanup();
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "No file was uploaded. Please select a DOC or DOCX file." },
      });
    }

    const file = req.file;
    console.log("[CONVERT] file uploaded:", requestId, file.originalname, file.size + " bytes");

    // Validate file
    if (file.size === 0) {
      console.log("[CONVERT] empty file:", requestId);
      cleanup();
      return res.status(400).json({
        success: false,
        error: { code: "EMPTY_FILE", message: "The file appears to be empty." },
      });
    }

    if (file.size > CONFIG.MAX_FILE_SIZE) {
      console.log("[CONVERT] file too large:", requestId);
      cleanup();
      return res.status(400).json({
        success: false,
        error: { code: "FILE_TOO_LARGE", message: "The file exceeds the 50 MB limit." },
      });
    }

    const ext = getFileExtension(file.originalname);
    if (!CONFIG.SUPPORTED_EXTENSIONS.includes(ext)) {
      console.log("[CONVERT] invalid file type:", requestId, ext);
      cleanup();
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_FILE_TYPE", message: "Only DOC and DOCX files are accepted." },
      });
    }

    // Track if response is already done (client disconnect, etc.)
    let responseFinished = false;
    res.on("finish", () => { responseFinished = true; });
    res.on("close", () => { responseFinished = true; });

    // Convert to PDF
    console.log("[CONVERT] LibreOffice started:", requestId);
    convertWordToPdf(file.path, outputDir)
      .then((result) => {
        if (responseFinished) {
          console.log("[CONVERT] client disconnected, skipping response:", requestId);
          cleanup();
          return;
        }

        console.log("[CONVERT] PDF created:", requestId, result.pdfName);

        const pdfPath = result.pdfPath;
        const pdfName = result.pdfName;

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="' + pdfName + '"');

        console.log("[CONVERT] response started:", requestId);

        const fileStream = fs.createReadStream(pdfPath);
        fileStream.pipe(res);

        fileStream.on("error", (err) => {
          console.log("[CONVERT] stream error:", requestId, err.message);
          cleanup();
        });
      })
      .catch((error) => {
        console.log("[CONVERT] conversion error:", requestId, error.message);
        cleanup();

        if (responseFinished) return;

        let code = "CONVERSION_FAILED";
        let message = "Failed to convert the document.";

        if (error.message && error.message.includes("timed out")) {
          code = "CONVERSION_TIMEOUT";
          message = "The document took too long to convert.";
        } else if (error.message && error.message.includes("not installed")) {
          code = "LIBREOFFICE_NOT_FOUND";
          message = "Conversion service is not available.";
        } else if (error.message && error.message.includes("not found")) {
          code = "LIBREOFFICE_NOT_FOUND";
          message = "Conversion service is not available.";
        }

        return res.status(500).json({
          success: false,
          error: { code: code, message: message },
        });
      });
  });
});

// ── Batch Conversion Endpoint ──

app.post("/api/convert-batch", (req, res) => {
  const jobId = jobStore.generateJobId();
  req.jobId = jobId;

  const jobDir = path.join(CONFIG.TEMP_ROOT, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log("[BATCH] request started:", jobId);

  function cleanupJob() {
    console.log("[BATCH] cleaning up job:", jobId);
    jobStore.deleteJob(jobId);
  }

  // Don't clean up on response finish - job is needed for download
  // Only clean up on client disconnect (error)
  res.on("close", () => {
    if (!res.writableFinished) {
      console.log("[BATCH] client disconnected, cleaning up:", jobId);
      cleanupJob();
    }
  });

  batchUploadMiddleware(req, res, function (err) {
    if (err) {
      console.log("[BATCH] upload error:", jobId, err.code || err.message);

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            success: false,
            error: { code: "FILE_TOO_LARGE", message: "One or more files exceed the 50 MB limit." },
          });
        }
        if (err.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({
            success: false,
            error: { code: "TOO_MANY_FILES", message: "Maximum of 20 files allowed per batch." },
          });
        }
        return res.status(400).json({
          success: false,
          error: { code: "UPLOAD_FAILED", message: "Upload failed." },
        });
      }

      return res.status(500).json({
        success: false,
        error: { code: "UPLOAD_FAILED", message: "An unexpected upload error occurred." },
      });
    }

    if (!req.files || req.files.length === 0) {
      console.log("[BATCH] no files uploaded:", jobId);
      cleanupJob();
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "No files were uploaded. Please select DOC or DOCX files." },
      });
    }

    console.log("[BATCH] files uploaded:", jobId, req.files.length);
    console.log("[BATCH] filenames:", req.files.map(f => f.originalname).join(", "));

    // Server-side validation of each file
    // ALL files go into the job; invalid ones are marked failed immediately
    const validFiles = [];
    const invalidFiles = [];
    for (const file of req.files) {
      let rejectCode = null;
      let rejectMessage = null;

      if (file.size === 0) {
        rejectCode = "EMPTY_FILE";
        rejectMessage = "The file appears to be empty.";
      } else if (file.size > CONFIG.MAX_FILE_SIZE) {
        rejectCode = "FILE_TOO_LARGE";
        rejectMessage = "The file exceeds the 50 MB limit.";
      } else {
        const ext = jobStore.getFileExtension(file.originalname);
        if (!CONFIG.SUPPORTED_EXTENSIONS.includes(ext)) {
          rejectCode = "INVALID_FILE_TYPE";
          rejectMessage = "Only DOC and DOCX files are accepted.";
        }
      }

      if (rejectCode) {
        invalidFiles.push({ file, code: rejectCode, message: rejectMessage });
      } else {
        validFiles.push(file);
      }
    }

    if (validFiles.length === 0 && invalidFiles.length === 0) {
      console.log("[BATCH] no files uploaded:", jobId);
      cleanupJob();
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "No files were uploaded. Please select DOC or DOCX files." },
      });
    }

    if (validFiles.length === 0) {
      console.log("[BATCH] no valid files:", jobId, "all", invalidFiles.length, "rejected");
    }

    // Create job with ALL files (valid + invalid)
    const allFilesForJob = req.files.map((f) => {
      const invalid = invalidFiles.find((inv) => inv.file === f);
      if (invalid) {
        return { ...f, _rejected: true, _errorCode: invalid.code, _errorMessage: invalid.message };
      }
      return f;
    });

    const job = jobStore.createJob(jobDir, allFilesForJob, jobId);
    console.log("[BATCH] job created:", job.jobId, "files:", job.totalCount);
    console.log("[BATCH] indexed files:", job.files.map((f, i) => (i + 1) + ". " + f.originalName).join(", "));

    // Mark invalid files as failed immediately
    for (let i = 0; i < job.files.length; i++) {
      const fileEntry = job.files[i];
      if (fileEntry.status === "failed" && fileEntry.errorCode) {
        jobStore.incrementFailed(jobId);
        console.log("[BATCH] File " + (i + 1) + "/" + job.totalCount + ": " + fileEntry.originalName + " → failed (" + fileEntry.errorCode + ")");
      }
    }

    // Start processing valid files
    processBatchJob(job.jobId);

    return res.status(202).json({
      success: true,
      jobId: job.jobId,
      status: "queued",
      totalCount: job.totalCount,
    });
  });
});

// ── Job Status Endpoint ──

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobStore.getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: { code: "JOB_NOT_FOUND", message: "Job not found." },
    });
  }

  const fileStatuses = job.files.map((f) => ({
    originalName: f.originalName,
    status: f.status,
    outputName: f.outputName,
    errorCode: f.errorCode,
    errorMessage: f.errorMessage,
  }));

  return res.json({
    success: true,
    jobId: job.jobId,
    status: job.status,
    totalCount: job.totalCount,
    completedCount: job.completedCount,
    failedCount: job.failedCount,
    files: fileStatuses,
    error: job.error,
  });
});

// ── Job Download Endpoint ──

app.get("/api/jobs/:jobId/download", (req, res) => {
  const job = jobStore.getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: { code: "JOB_NOT_FOUND", message: "Job not found." },
    });
  }

  if (job.status !== "completed" && job.status !== "completed_with_errors") {
    return res.status(400).json({
      success: false,
      error: { code: "NOT_READY", message: "Job is not ready for download." },
    });
  }

  console.log("[DOWNLOAD] job:", req.params.jobId, "zipPath:", job.zipPath, "exists:", fs.existsSync(job.zipPath));

  if (!job.zipPath || !fs.existsSync(job.zipPath)) {
    console.log("[DOWNLOAD] ZIP missing for job:", req.params.jobId, "zipPath:", job.zipPath);
    return res.status(500).json({
      success: false,
      error: { code: "ZIP_MISSING", message: "ZIP file not found." },
    });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="converted-pdfs.zip"');

  const fileStream = fs.createReadStream(job.zipPath);
  fileStream.pipe(res);

  fileStream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: { code: "DOWNLOAD_FAILED", message: "Failed to download ZIP." },
      });
    }
  });

  // Cleanup after download completes
  res.on("finish", () => {
    setTimeout(() => {
      jobStore.deleteJob(job.jobId);
    }, 1000);
  });

  res.on("close", () => {
    if (!res.writableFinished) {
      // Client disconnected, but don't delete yet - let stale cleanup handle it
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
