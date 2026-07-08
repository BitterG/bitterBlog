const TARGET_START = 4;
const TARGET_LENGTH = 8;
const MAX_RENDER_BYTES = 4096;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

let fileName = '';
let bytes = null;

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileNameEl = document.getElementById('fileName');
const fileSizeEl = document.getElementById('fileSize');
const numberInput = document.getElementById('numberInput');
const applyBtn = document.getElementById('applyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');
const hexView = document.getElementById('hexView');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function formatOffset(offset) {
  return offset.toString(16).padStart(8, '0').toUpperCase();
}

function formatByte(value) {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

function renderBytes() {
  hexView.innerHTML = '';

  if (!bytes) {
    return;
  }

  const visibleLength = Math.min(bytes.length, MAX_RENDER_BYTES);
  const fragment = document.createDocumentFragment();

  for (let offset = 0; offset < visibleLength; offset += 16) {
    const row = document.createElement('div');
    row.className = 'hex-row';

    const offsetEl = document.createElement('span');
    offsetEl.className = 'offset';
    offsetEl.textContent = formatOffset(offset);

    const byteWrap = document.createElement('span');
    const rowEnd = Math.min(offset + 16, visibleLength);

    for (let index = offset; index < rowEnd; index++) {
      const byteEl = document.createElement('span');
      byteEl.className = 'byte';
      if (index >= TARGET_START && index < TARGET_START + TARGET_LENGTH) {
        byteEl.classList.add('target');
        byteEl.title = `第 ${index + 1} 字节`;
      }
      byteEl.textContent = formatByte(bytes[index]);
      byteWrap.appendChild(byteEl);
    }

    row.append(offsetEl, byteWrap);
    fragment.appendChild(row);
  }

  hexView.appendChild(fragment);

  if (bytes.length > MAX_RENDER_BYTES) {
    const note = document.createElement('div');
    note.className = 'hex-row';
    note.innerHTML = `<span class="offset">...</span><span>仅显示前 ${MAX_RENDER_BYTES} 字节，下载仍保存完整文件。</span>`;
    hexView.appendChild(note);
  }
}

async function loadFile(file) {
  fileName = file.name;
  bytes = new Uint8Array(await file.arrayBuffer());
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = `${bytes.length} bytes`;
  applyBtn.disabled = bytes.length < TARGET_START + TARGET_LENGTH;
  downloadBtn.disabled = false;
  setStatus(bytes.length < TARGET_START + TARGET_LENGTH ? '文件不足 12 字节，无法写入第 5-12 字节。' : '文件已打开，第 5-12 字节已高亮。', bytes.length < TARGET_START + TARGET_LENGTH);
  renderBytes();
}

function steamIdToBytes(rawValue) {
  if (!/^-?\d+$/.test(rawValue)) {
    throw new Error('请输入有效的数字格式的 Steam ID。');
  }

  const value = BigInt(rawValue);
  if (value < I64_MIN || value > I64_MAX) {
    throw new Error('Steam ID 超出 i64 范围。');
  }

  const output = new Uint8Array(TARGET_LENGTH);
  const view = new DataView(output.buffer);
  view.setBigInt64(0, value, true);
  return { value, output };
}

function writeNumber() {
  if (!bytes) {
    setStatus('请先打开文件。', true);
    return;
  }

  if (bytes.length < TARGET_START + TARGET_LENGTH) {
    setStatus('文件不足 12 字节，无法写入。', true);
    return;
  }

  const rawValue = numberInput.value.trim();
  let converted;
  try {
    converted = steamIdToBytes(rawValue);
  } catch (error) {
    setStatus(error.message, true);
    return;
  }

  bytes.set(converted.output, TARGET_START);
  setStatus(`已将 Steam ID ${converted.value} 按 gbfr-tool 逻辑写入第 5-12 字节：${Array.from(converted.output, formatByte).join(' ')}`);
  renderBytes();
}

function downloadFile() {
  if (!bytes) {
    return;
  }

  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName ? `modified-${fileName}` : 'modified.bin';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  if (file) {
    loadFile(file);
  }
});

['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.add('drag-over');
  });
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
  });
});

dropZone.addEventListener('drop', event => {
  const [file] = event.dataTransfer.files;
  if (file) {
    loadFile(file);
  }
});

applyBtn.addEventListener('click', writeNumber);
downloadBtn.addEventListener('click', downloadFile);
