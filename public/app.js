(function () {
  "use strict";

  const ACCEPTED_TYPES = [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  const ACCEPTED_EXTENSIONS = [".doc", ".docx"];

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const chooseFilesBtn = document.getElementById("chooseFilesBtn");
  const fileList = document.getElementById("fileList");
  const queueSection = document.getElementById("queueSection");
  const clearAllBtn = document.getElementById("clearAllBtn");
  const convertBtn = document.getElementById("convertBtn");

  let files = [];

  // ── Helpers ──

  function formatSize(bytes) {
    if (bytes === 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1).replace(/\.0$/, "") + " KB";
    return (bytes / 1048576).toFixed(1).replace(/\.0$/, "") + " MB";
  }

  function getFileExtension(name) {
    var idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx).toLowerCase() : "";
  }

  function isAccepted(file) {
    if (ACCEPTED_TYPES.indexOf(file.type) !== -1) return true;
    return ACCEPTED_EXTENSIONS.indexOf(getFileExtension(file.name)) !== -1;
  }

  function fileKey(file) {
    return file.name + "|" + file.size + "|" + file.lastModified;
  }

  function fileExists(file) {
    var key = fileKey(file);
    for (var i = 0; i < files.length; i++) {
      if (fileKey(files[i]) === key) return true;
    }
    return false;
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

  function renderQueue() {
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
    for (var i = 0; i < newFiles.length; i++) {
      var file = newFiles[i];
      if (!isAccepted(file)) continue;
      if (!fileExists(file)) {
        files.push(file);
      }
    }
    renderQueue();
  }

  function removeFile(index) {
    files.splice(index, 1);
    renderQueue();
  }

  function clearAll() {
    files = [];
    fileInput.value = "";
    renderQueue();
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
