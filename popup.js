// Netflix Channel Surfer — Popup Script

const STORAGE_KEY = 'cs_settings';

const DEFAULT_SETTINGS = {
  seekMin: 0.15,
  seekMax: 0.80,
  contentType: 'both',
};

let settings = { ...DEFAULT_SETTINGS };
let saveTimer = null;

// ─── Load & render saved settings ─────────────────────────────────────────────

async function loadSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  if (result[STORAGE_KEY]) {
    settings = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEY] };
  }
  renderSettings();
}

function renderSettings() {
  // Content type pills
  document.querySelectorAll('.pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.type === settings.contentType);
  });

  // Sliders
  const minPct = Math.round(settings.seekMin * 100);
  const maxPct = Math.round(settings.seekMax * 100);

  document.getElementById('seek-min').value = minPct;
  document.getElementById('seek-max').value = maxPct;
  document.getElementById('min-label').textContent = `${minPct}%`;
  document.getElementById('max-label').textContent = `${maxPct}%`;
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function saveSettings() {
  chrome.storage.local.set({ [STORAGE_KEY]: settings });

  // Debounced "saved" flash
  clearTimeout(saveTimer);
  const status = document.getElementById('save-status');
  status.classList.remove('hidden');
  saveTimer = setTimeout(() => status.classList.add('hidden'), 1800);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.querySelectorAll('.pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    settings.contentType = pill.dataset.type;
    document.querySelectorAll('.pill').forEach((p) =>
      p.classList.toggle('active', p === pill)
    );
    saveSettings();
  });
});

document.getElementById('seek-min').addEventListener('input', (e) => {
  let val = parseInt(e.target.value, 10);
  const maxVal = parseInt(document.getElementById('seek-max').value, 10);

  // Clamp: min must be at least 5% below max
  if (val >= maxVal - 5) {
    val = maxVal - 5;
    e.target.value = val;
  }

  settings.seekMin = val / 100;
  document.getElementById('min-label').textContent = `${val}%`;
  saveSettings();
});

document.getElementById('seek-max').addEventListener('input', (e) => {
  let val = parseInt(e.target.value, 10);
  const minVal = parseInt(document.getElementById('seek-min').value, 10);

  // Clamp: max must be at least 5% above min
  if (val <= minVal + 5) {
    val = minVal + 5;
    e.target.value = val;
  }

  settings.seekMax = val / 100;
  document.getElementById('max-label').textContent = `${val}%`;
  saveSettings();
});

document.getElementById('open-netflix').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.netflix.com/browse' });
  window.close();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadSettings();
