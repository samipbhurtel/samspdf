(function () {
  "use strict";

  // ── Configuration ──

  var CONFIG = {
    API_URL: "https://samspdf-api.onrender.com",
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    MAX_FILES: 20,
    SUPPORTED_EXTENSIONS: [".doc", ".docx"],
    SUPPORTED_MIME_TYPES: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    POLL_INTERVAL_MS: 750,
  };

  // ── DOM References ──

  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var chooseFilesBtn = document.getElementById("chooseFilesBtn");
  var fileList = document.getElementById("fileList");
  var queueSection = document.getElementById("queueSection");
  var clearAllBtn = document.getElementById("clearAllBtn");
  var convertBtn = document.getElementById("convertBtn");
  var messagesEl = document.getElementById("messages");

  // Batch progress elements
  var progressSection = document.getElementById("progressSection");
  var progressSummary = document.getElementById("progressSummary");
  var progressFiles = document.getElementById("progressFiles");
  var downloadBtn = document.getElementById("downloadBtn");
  var downloadSection = document.getElementById("downloadSection");
  var downloadMessage = document.getElementById("downloadMessage");

  // ── State ──

  var files = [];
  var messageTimeout = null;
  var isUploading = false;
  var currentJobId = null;
  var pollTimer = null;

  // ── Helpers ──

  function formatSize(bytes) {
    if (bytes === 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1).replace(/\.0$/, "") + " KB";
    return (bytes / 1048576).toFixed(1).replace(/\.0$/, "") + " MB";
  }

  function formatMaxSize() {
    return (CONFIG.MAX_FILE_SIZE / (1024 * 1024)) + " MB";
  }

  function getFileExtension(name) {
    var idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx).toLowerCase() : "";
  }

  function getBaseName(filename) {
    var ext = getFileExtension(filename);
    return ext ? filename.slice(0, filename.length - ext.length) : filename;
  }

  function fileKey(file) {
    return file.name + "|" + file.size + "|" + file.lastModified;
  }

  function isDuplicate(file) {
    var key = fileKey(file);
    for (var i = 0; i < files.length; i++) {
      if (fileKey(files[i]) === key) return true;
    }
    return false;
  }

  // ── Validation ──

  function validateFile(file) {
    var reasons = [];

    var ext = getFileExtension(file.name);
    var typeOk = CONFIG.SUPPORTED_MIME_TYPES.indexOf(file.type) !== -1;
    var extOk = CONFIG.SUPPORTED_EXTENSIONS.indexOf(ext) !== -1;
    if (!typeOk && !extOk) {
      reasons.push("Unsupported file type");
    }

    if (file.size === 0) {
      reasons.push("File is empty");
    } else if (file.size > CONFIG.MAX_FILE_SIZE) {
      reasons.push("File exceeds the " + formatMaxSize() + " limit");
    }

    if (isDuplicate(file)) {
      reasons.push("Already in the list");
    }

    return reasons;
  }

  // ── Message System ──

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function showMessage(html, type) {
    if (!type) type = "error";

    messagesEl.innerHTML = "";

    var msg = document.createElement("div");
    msg.className = "message message--" + type;

    var iconSvg = type === "error"
      ? '<svg class="message__icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v4a1 1 0 102 0V7zm-1 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg>'
      : '<svg class="message__icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';

    if (type === "success") {
      iconSvg = '<svg class="message__icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>';
    }

    msg.innerHTML = iconSvg + '<div class="message__body">' + html + '</div>';
    messagesEl.appendChild(msg);

    if (messageTimeout) clearTimeout(messageTimeout);
    messageTimeout = setTimeout(function () {
      if (msg.parentNode) msg.remove();
    }, 8000);
  }

  function clearMessages() {
    messagesEl.innerHTML = "";
    if (messageTimeout) {
      clearTimeout(messageTimeout);
      messageTimeout = null;
    }
  }

  // ── Validation Result Rendering ──

  function renderValidationErrors(result) {
    var rejected = result.rejected;
    if (rejected.length === 0) return;

    var totalCount = rejected.length;
    var maxCountRejections = 0;
    var otherRejections = [];

    for (var i = 0; i < rejected.length; i++) {
      if (rejected[i].reason === "max_files") {
        maxCountRejections++;
      } else {
        otherRejections.push(rejected[i]);
      }
    }

    var html = "";

    var totalFiles = totalCount;
    var summaryText = totalFiles + " file" + (totalFiles !== 1 ? "s" : "") + " could not be added.";
    html += '<p class="message__summary">' + escapeHtml(summaryText) + '</p>';

    if (otherRejections.length > 0 || maxCountRejections > 0) {
      html += '<ul class="message__list">';

      for (var j = 0; j < otherRejections.length; j++) {
        var item = otherRejections[j];
        html += '<li class="message__list-item">';
        html += '<span class="message__filename">' + escapeHtml(item.name) + '</span>';
        html += ' — ' + escapeHtml(item.reasonLabel);
        html += '</li>';
      }

      if (maxCountRejections > 0) {
        html += '<li class="message__list-item">';
        html += maxCountRejections + ' file' + (maxCountRejections !== 1 ? 's' : '');
        html += ' — Maximum of ' + CONFIG.MAX_FILES + ' files reached';
        html += '</li>';
      }

      html += '</ul>';
    }

    showMessage(html, "error");
  }

  // ── Rendering ──

  function renderFileItem(file, index) {
    var li = document.createElement("li");
    li.className = "file-item";
    li.setAttribute("role", "listitem");

    var icon = document.createElement("div");
    icon.className = "file-item__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

    var info = document.createElement("div");
    info.className = "file-item__info";

    var name = document.createElement("p");
    name.className = "file-item__name";
    name.textContent = file.name;
    name.title = file.name;

    var size = document.createElement("p");
    size.className = "file-item__size";
    size.textContent = formatSize(file.size);

    info.appendChild(name);
    info.appendChild(size);

    var remove = document.createElement("button");
    remove.className = "file-item__remove";
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove " + file.name);
    remove.innerHTML = "&times;";
    remove.addEventListener("click", function () {
      removeFile(index);
    });

    li.appendChild(icon);
    li.appendChild(info);
    li.appendChild(remove);

    return li;
  }

  function updateUI() {
    fileList.innerHTML = "";

    if (files.length === 0) {
      queueSection.hidden = true;
      convertBtn.disabled = true;
      convertBtn.setAttribute("aria-disabled", "true");
      return;
    }

    queueSection.hidden = false;
    convertBtn.disabled = isUploading;
    convertBtn.setAttribute("aria-disabled", isUploading ? "true" : "false");

    if (files.length === 1) {
      convertBtn.textContent = "Convert to PDF";
    } else {
      convertBtn.textContent = "Convert " + files.length + " Files to PDF";
    }

    for (var i = 0; i < files.length; i++) {
      fileList.appendChild(renderFileItem(files[i], i));
    }
  }

  // ── File Management ──

  function addFiles(newFiles) {
    var result = { accepted: [], rejected: [] };
    var remaining = CONFIG.MAX_FILES - files.length;

    for (var i = 0; i < newFiles.length; i++) {
      var file = newFiles[i];
      var reasons = validateFile(file);

      if (reasons.length > 0) {
        result.rejected.push({
          name: file.name,
          reason: reasons[0].toLowerCase().replace(/[^a-z]/g, "_"),
          reasonLabel: reasons[0],
        });
        continue;
      }

      if (remaining <= 0) {
        result.rejected.push({
          name: file.name,
          reason: "max_files",
          reasonLabel: "",
        });
        continue;
      }

      files.push(file);
      result.accepted.push(file);
      remaining--;
    }

    if (result.rejected.length > 0) {
      renderValidationErrors(result);
    } else {
      clearMessages();
    }

    updateUI();
  }

  function removeFile(index) {
    files.splice(index, 1);
    fileInput.value = "";
    updateUI();
  }

  function clearAll() {
    files = [];
    fileInput.value = "";
    clearMessages();
    currentJobId = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    progressSection.hidden = true;
    downloadSection.hidden = true;
    downloadBtn.textContent = "Download ZIP";
    downloadBtn.disabled = false;
    downloadMessage.textContent = "";
    queueSection.hidden = true;
    updateUI();
  }

  // ── Download Helper ──

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // ── Progress UI ──

  function showProgress() {
    progressSection.hidden = false;
    progressSummary.textContent = "Starting conversion...";
    progressFiles.innerHTML = "";
    downloadSection.hidden = true;
    downloadBtn.textContent = "Download ZIP";
    downloadBtn.disabled = false;
  }

  function updateProgress(job) {
    if (!job) return;

    var summary = "";
    if (job.status === "queued") {
      summary = "Queued... (" + job.totalCount + " files)";
    } else if (job.status === "processing") {
      summary = "Converting... " + job.completedCount + " of " + job.totalCount + " completed";
      if (job.failedCount > 0) {
        summary += ", " + job.failedCount + " failed";
      }
    } else if (job.status === "completed") {
      summary = "All " + job.completedCount + " files converted successfully.";
    } else if (job.status === "completed_with_errors") {
      summary = "Conversion completed with errors. " + job.completedCount + " PDFs created, " + job.failedCount + " file(s) failed.";
    } else if (job.status === "failed") {
      summary = "Conversion failed.";
      if (job.error) {
        summary += " " + job.error.message;
      }
    }

    progressSummary.textContent = summary;

    // Render file statuses
    progressFiles.innerHTML = "";
    for (var i = 0; i < job.files.length; i++) {
      var f = job.files[i];
      var li = document.createElement("li");
      li.className = "progress-file";

      var statusClass = "progress-file--" + f.status;
      li.className += " " + statusClass;

      var statusIcon = "";
      if (f.status === "completed") {
        statusIcon = "✓";
      } else if (f.status === "converting") {
        statusIcon = "⟳";
      } else if (f.status === "failed") {
        statusIcon = "✕";
      } else {
        statusIcon = "○";
      }

      var nameSpan = document.createElement("span");
      nameSpan.className = "progress-file__name";
      nameSpan.textContent = f.originalName;

      var statusSpan = document.createElement("span");
      statusSpan.className = "progress-file__status";
      statusSpan.textContent = statusIcon + " " + f.status.charAt(0).toUpperCase() + f.status.slice(1);

      if (f.status === "failed" && f.errorMessage) {
        statusSpan.title = f.errorMessage;
      }

      li.appendChild(nameSpan);
      li.appendChild(statusSpan);
      progressFiles.appendChild(li);
    }

    // Show download button when ready
    if (job.status === "completed" || job.status === "completed_with_errors") {
      downloadSection.hidden = false;
      if (job.status === "completed") {
        downloadMessage.textContent = "All files converted. Download your PDFs.";
      } else {
        downloadMessage.textContent = job.completedCount + " PDFs ready. " + job.failedCount + " file(s) failed.";
      }
    }
  }

  // ── Polling ──

  function startPolling(jobId) {
    currentJobId = jobId;
    showProgress();

    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(function () {
      fetch(CONFIG.API_URL + "/api/jobs/" + jobId)
        .then(function (response) {
          if (!response.ok) {
            throw new Error("Job not found");
          }
          return response.json();
        })
        .then(function (data) {
          if (data.success) {
            updateProgress(data);

            // Stop polling when done
            if (data.status === "completed" || data.status === "completed_with_errors" || data.status === "failed") {
              clearInterval(pollTimer);
              pollTimer = null;
              isUploading = false;
              convertBtn.disabled = false;
              convertBtn.textContent = "Convert to PDF";
              convertBtn.setAttribute("aria-disabled", "false");
            }
          }
        })
        .catch(function (err) {
          clearInterval(pollTimer);
          pollTimer = null;
          isUploading = false;
          convertBtn.disabled = false;
          convertBtn.textContent = "Convert to PDF";
          convertBtn.setAttribute("aria-disabled", "false");
          showMessage("Failed to get job status. Please try again.", "error");
        });
    }, CONFIG.POLL_INTERVAL_MS);
  }

  // ── Batch Upload & Convert ──

  function uploadBatch() {
    if (isUploading || files.length === 0) return;

    // Reset batch-specific state for new batch
    currentJobId = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    downloadSection.hidden = true;
    downloadBtn.textContent = "Download ZIP";
    downloadBtn.disabled = false;
    downloadMessage.textContent = "";

    isUploading = true;
    convertBtn.disabled = true;
    convertBtn.textContent = "Uploading...";
    convertBtn.setAttribute("aria-disabled", "true");
    clearMessages();

    var formData = new FormData();
    for (var i = 0; i < files.length; i++) {
      formData.append("files", files[i]);
    }

    fetch(CONFIG.API_URL + "/api/convert-batch", {
      method: "POST",
      body: formData,
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          isUploading = false;
          convertBtn.disabled = false;
          convertBtn.textContent = "Convert to PDF";
          convertBtn.setAttribute("aria-disabled", "false");

          var errMsg = "Upload failed.";
          if (result.data && result.data.error) {
            errMsg = result.data.error.message || errMsg;
          }
          showMessage(errMsg, "error");
          return;
        }

        // Job accepted, start polling
        convertBtn.textContent = "Converting...";
        startPolling(result.data.jobId);
      })
      .catch(function (err) {
        isUploading = false;
        convertBtn.disabled = false;
        convertBtn.textContent = "Convert to PDF";
        convertBtn.setAttribute("aria-disabled", "false");
        showMessage("Unable to connect to the server. Please try again.", "error");
      });
  }

  // ── Single File Upload (Phase 4) ──

  function uploadSingle() {
    if (isUploading || files.length === 0) return;

    isUploading = true;
    convertBtn.disabled = true;
    convertBtn.textContent = "Uploading...";
    convertBtn.setAttribute("aria-disabled", "true");
    clearMessages();

    var formData = new FormData();
    formData.append("file", files[0]);

    fetch(CONFIG.API_URL + "/api/convert", {
      method: "POST",
      body: formData,
    })
      .then(function (response) {
        var contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/pdf") !== -1) {
          convertBtn.textContent = "Converting...";
          return response.blob().then(function (blob) {
            return { ok: true, blob: blob, filename: files[0].name };
          });
        }

        return response.json().then(function (data) {
          return { ok: false, data: data };
        });
      })
      .then(function (result) {
        isUploading = false;
        convertBtn.textContent = "Convert to PDF";

        if (!result.ok) {
          var errMsg = "Conversion failed.";
          if (result.data && result.data.error) {
            errMsg = result.data.error.message || errMsg;
          }
          showMessage(errMsg, "error");
          updateUI();
          return;
        }

        convertBtn.textContent = "Preparing download...";
        var pdfName = getBaseName(result.filename) + ".pdf";
        downloadBlob(result.blob, pdfName);

        showMessage("PDF downloaded successfully: " + pdfName, "success");

        files = [];
        fileInput.value = "";
        convertBtn.textContent = "Convert to PDF";
        updateUI();
      })
      .catch(function (err) {
        isUploading = false;
        convertBtn.textContent = "Convert to PDF";
        showMessage("Unable to connect to the server. Please try again.", "error");
        updateUI();
      });
  }

  // ── Upload Handler ──

  function uploadFiles() {
    if (isUploading || files.length === 0) return;

    if (files.length === 1) {
      uploadSingle();
    } else {
      uploadBatch();
    }
  }

  // ── Download ZIP ──

  function downloadZip() {
    if (!currentJobId) return;

    downloadBtn.disabled = true;
    downloadBtn.textContent = "Downloading...";

    fetch(CONFIG.API_URL + "/api/jobs/" + currentJobId + "/download")
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(function (data) {
            throw new Error(data.error ? data.error.message : "Download failed");
          });
        }
        return response.blob();
      })
      .then(function (blob) {
        downloadBlob(blob, "converted-pdfs.zip");
        downloadBtn.textContent = "Downloaded";
        downloadBtn.disabled = true;
        downloadMessage.textContent = "ZIP downloaded successfully.";

        // Clear files after successful download
        setTimeout(function () {
          clearAll();
        }, 2000);
      })
      .catch(function (err) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = "Download ZIP";
        showMessage("Failed to download ZIP: " + err.message, "error");
      });
  }

  // ── Event Handlers ──

  chooseFilesBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener("click", function () {
    fileInput.click();
  });

  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files.length > 0) {
      addFiles(fileInput.files);
      fileInput.value = "";
    }
  });

  clearAllBtn.addEventListener("click", function () {
    clearAll();
  });

  convertBtn.addEventListener("click", function () {
    uploadFiles();
  });

  downloadBtn.addEventListener("click", function () {
    downloadZip();
  });

  // ── Drag & Drop ──

  var dragCounter = 0;

  dropzone.addEventListener("dragenter", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    dropzone.classList.add("dropzone--active");
  });

  dropzone.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.stopPropagation();
  });

  dropzone.addEventListener("dragleave", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter === 0) {
      dropzone.classList.remove("dropzone--active");
    }
  });

  dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    dropzone.classList.remove("dropzone--active");

    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  });

  // Prevent default drag behavior on document
  document.addEventListener("dragover", function (e) {
    e.preventDefault();
  });

  document.addEventListener("drop", function (e) {
    e.preventDefault();
  });
})();
