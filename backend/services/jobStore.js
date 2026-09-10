const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── In-memory job store ──

const jobs = new Map();

// ── Configuration ──

const CONFIG = {
  JOB_TTL_MS: 60 * 60 * 1000, // 1 hour
  STALE_CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
};

// ── Helpers ──

function generateJobId() {
  return crypto.randomBytes(16).toString("hex");
}

function getFileExtension(name) {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function getBaseName(filename) {
  const ext = getFileExtension(filename);
  return ext ? filename.slice(0, filename.length - ext.length) : filename;
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

function rimrafSync(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (_) {
    // best-effort cleanup
  }
}

// ── Resolve duplicate PDF names ──

function resolveDuplicateNames(entries) {
  const nameCount = {};
  for (const entry of entries) {
    const name = entry.pdfName;
    if (nameCount[name] === undefined) {
      nameCount[name] = 1;
    } else {
      nameCount[name]++;
    }
  }

  const duplicates = {};
  for (const name in nameCount) {
    if (nameCount[name] > 1) {
      duplicates[name] = 1;
    }
  }

  if (Object.keys(duplicates).length === 0) return entries;

  const seen = {};
  for (const entry of entries) {
    const name = entry.pdfName;
    if (duplicates[name] !== undefined) {
      seen[name] = (seen[name] || 0) + 1;
      if (seen[name] > 1) {
        const base = getBaseName(name);
        entry.pdfName = base + " (" + seen[name] + ").pdf";
      }
    }
  }

  return entries;
}

// ── Job CRUD ──

function createJob(jobDir, files, overrideJobId) {
  const jobId = overrideJobId || generateJobId();

  const fileEntries = files.map((f) => ({
    originalName: f.originalname,
    safeName: safeFilename(f.originalname),
    storedPath: f.path,
    status: f._rejected ? "failed" : "queued",
    outputName: null,
    errorCode: f._rejected ? f._errorCode : null,
    errorMessage: f._rejected ? f._errorMessage : null,
    _rejected: !!f._rejected,
  }));

  const job = {
    jobId: jobId,
    status: "queued",
    jobDir: jobDir,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    files: fileEntries,
    completedCount: 0,
    failedCount: 0,
    totalCount: fileEntries.length,
    zipPath: null,
    zipSize: null,
    error: null,
  };

  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, updates, { updatedAt: Date.now() });
  return job;
}

function updateFileStatus(jobId, fileIndex, updates) {
  const job = jobs.get(jobId);
  if (!job || !job.files[fileIndex]) return null;
  Object.assign(job.files[fileIndex], updates);
  job.updatedAt = Date.now();
  return job;
}

function incrementCompleted(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.completedCount++;
  job.updatedAt = Date.now();
  return job;
}

function incrementFailed(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.failedCount++;
  job.updatedAt = Date.now();
  return job;
}

function finalizeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;

  if (job.completedCount === job.totalCount) {
    job.status = "completed";
  } else if (job.failedCount === job.totalCount) {
    job.status = "failed";
  } else {
    job.status = "completed_with_errors";
  }

  job.updatedAt = Date.now();
  return job;
}

function deleteJob(jobId) {
  const job = jobs.get(jobId);
  if (job) {
    rimrafSync(job.jobDir);
    jobs.delete(jobId);
  }
}

// ── Stale job cleanup ──

function cleanStaleJobs(tempRoot) {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    if (now - job.createdAt > CONFIG.JOB_TTL_MS) {
      console.log("[JOB-CLEANUP] removing stale job:", jobId);
      deleteJob(jobId);
    }
  }

  // Also clean orphaned directories in temp root
  try {
    if (!fs.existsSync(tempRoot)) return;
    const entries = fs.readdirSync(tempRoot);
    for (const entry of entries) {
      const dirPath = path.join(tempRoot, entry);
      try {
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory() && (now - stat.mtimeMs) > CONFIG.JOB_TTL_MS) {
          // Check if this dir belongs to a known job
          let isJobDir = false;
          for (const [, job] of jobs) {
            if (job.jobDir === dirPath) {
              isJobDir = true;
              break;
            }
          }
          if (!isJobDir) {
            console.log("[JOB-CLEANUP] removing orphaned directory:", entry);
            rimrafSync(dirPath);
          }
        }
      } catch (_) {
        // skip
      }
    }
  } catch (_) {
    // temp dir may not exist
  }
}

// ── Expose unique name resolver ──

module.exports = {
  CONFIG,
  generateJobId,
  getFileExtension,
  getBaseName,
  safeFilename,
  rimrafSync,
  resolveDuplicateNames,
  createJob,
  getJob,
  updateJob,
  updateFileStatus,
  incrementCompleted,
  incrementFailed,
  finalizeJob,
  deleteJob,
  cleanStaleJobs,
};
