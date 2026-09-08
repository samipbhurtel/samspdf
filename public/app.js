(function () {
  "use strict";

  // ── Configuration ──

  var CONFIG = {
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    MAX_FILES: 20,
    SUPPORTED_EXTENSIONS: [".doc", ".docx"],
    SUPPORTED_MIME_TYPES: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
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

  // ── State ──

  var files = [];
  var messageTimeout = null;

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

    // Summary line
    var totalFiles = totalCount;
    var summaryText = totalFiles + " file" + (totalFiles !== 1 ? "s" : "") + " could not be added.";
    html += '<p class="message__summary">' + escapeHtml(summaryText) + '</p>';

    // Detail list
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
    convertBtn.disabled = false;
    convertBtn.setAttribute("aria-disabled", "false");

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
    updateUI();
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
    alert("Conversion will be connected in the next phase.");
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
