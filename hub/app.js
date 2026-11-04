// =====================================================================
// СТУДЕНЧЕСКИЙ ДИСК — ПЕРСОНАЛЬНОЕ ОБЛАКО ПО ПРЕДМЕТАМ
// =====================================================================
// ПРИНЦИП ЗАЩИТЫ: Весь исполняемый контекст, алгоритмы проверки ключей,
// криптографические соли, хэши и база данных файлов изолированы
// внутри приватного замыкания (IIFE).
// Никакие системные функции (unlockDisk, getWeeklyCodeInfo, filesDb)
// НЕ экспортируются в глобальный объект window и недоступны из консоли F12.
// =====================================================================

(function(window, document) {
  'use strict';

  // Private Isolated State
  let foldersDb = typeof DEFAULT_SUBJECTS !== "undefined" ? [...DEFAULT_SUBJECTS] : [];
  let filesDb = [];
  let currentSubjectId = "ALL";
  let currentSubfolderId = null;
  let createSubfolderTargetSubjId = null;
  let viewMode = localStorage.getItem("disk_view_mode") || "grid";
  let currentSortMode = localStorage.getItem("disk_sort_mode") || "date_desc";
  let searchQuery = "";
  let isUnlocked = false;
  let isAuthenticating = false;
  let isPinMasked = true;
  let pendingUploadFiles = null;
  let syncIntervalId = null;
  let activeFocusTrap = null;

  // Session & Remote Device Management State (Master vs College)
  const SESSIONS_STORAGE_PATH = "sessions_db.json";
  let currentSessionId = localStorage.getItem("disk_session_id") || "";
  let currentDeviceRole = localStorage.getItem("disk_device_role") || "college";
  let selectedLoginRole = localStorage.getItem("disk_is_master_device") === "true" ? "master" : "college";
  let cachedSessionsList = [];

  // Caches for smart background sync
  let lastFoldersSyncCache = "";
  let lastFilesSyncCache = "";

  const MAX_STORAGE_MB = 1000;

  // Salted Cryptographic Master Hash (Salt + Pin + Pepper)
  // В исходном коде НЕТ открытого числа. Радужные таблицы бесполезны из-за уникальной соли.
  const MASTER_SALT = "DanteZkiy_Vault_Secure_Salt_2026_";
  const MASTER_PEPPER = "_College_Secure";
  const MASTER_PIN_SALTED_HASH = "4438ddeb650f3e2c652e94807b48fdaada16f3a975645a4ec222c27b358ed642";

  // Focus Trapping for Accessible Dialogs (WCAG 2.1)
  function trapFocus(modalEl) {
    if (!modalEl) return;
    releaseFocus();

    const focusableSelectors = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const rawElements = Array.from(modalEl.querySelectorAll(focusableSelectors));
    const focusableElements = rawElements.filter(el => {
      return el.offsetParent !== null && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    });
    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    function handleTabKey(e) {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          lastElement.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          e.preventDefault();
        }
      }
    }

    modalEl.addEventListener('keydown', handleTabKey);
    activeFocusTrap = { modalEl, handleTabKey };
  }

  function releaseFocus() {
    if (activeFocusTrap) {
      activeFocusTrap.modalEl.removeEventListener('keydown', activeFocusTrap.handleTabKey);
      activeFocusTrap = null;
    }
  }

  // Lazy Script Loader for high performance
  const loadedScriptsCache = new Map();
  function loadScript(src) {
    if (loadedScriptsCache.has(src)) return loadedScriptsCache.get(src);
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      const p = Promise.resolve();
      loadedScriptsCache.set(src, p);
      return p;
    }
    const p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = (err) => reject(new Error(`Не удалось загрузить модуль: ${src}`));
      document.head.appendChild(s);
    });
    loadedScriptsCache.set(src, p);
    return p;
  }

  // Debounce utility to prevent UI lag on search
  function debounce(func, wait = 180) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // ================= 1. NATIVE BULLETPROOF STORAGE SERVICE =================
  const StorageService = {
    getHeaders(contentType = null) {
      const headers = {
        "Authorization": `Bearer ${SUPABASE_CONFIG.key}`,
        "apikey": SUPABASE_CONFIG.key
      };
      if (contentType) {
        headers["Content-Type"] = contentType;
      }
      return headers;
    },

    getPublicUrl(path, downloadName = null) {
      const base = `${SUPABASE_CONFIG.url}/storage/v1/object/public/${SUPABASE_CONFIG.bucket}/${path}`;
      if (downloadName) {
        return `${base}?download=${encodeURIComponent(downloadName)}`;
      }
      return base;
    },

    async upload(path, fileOrBlob, isJson = false) {
      const url = `${SUPABASE_CONFIG.url}/storage/v1/object/${SUPABASE_CONFIG.bucket}/${path}`;
      const contentType = isJson 
        ? "application/json; charset=utf-8" 
        : (fileOrBlob.type || "application/octet-stream");

      const headers = this.getHeaders(contentType);
      headers["x-upsert"] = "true";

      const res = await fetch(url, {
        method: "POST",
        headers: headers,
        body: fileOrBlob
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ошибка загрузки (${res.status}): ${errText}`);
      }
      return await res.json();
    },

    async remove(paths) {
      if (!paths || paths.length === 0) return true;
      const url = `${SUPABASE_CONFIG.url}/storage/v1/object/${SUPABASE_CONFIG.bucket}`;
      const prefixes = Array.isArray(paths) ? paths : [paths];

      try {
        const res = await fetch(url, {
          method: "DELETE",
          headers: this.getHeaders("application/json"),
          body: JSON.stringify({ prefixes })
        });
        return res.ok;
      } catch (e) {
        console.warn("Storage remove note:", e);
        return false;
      }
    },

    async fetchJson(path) {
      try {
        const url = this.getPublicUrl(path) + "?t=" + Date.now();
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return null;
        return await res.json();
      } catch (e) {
        console.warn("fetchJson note:", path, e);
        return null;
      }
    },

    async saveJson(path, data) {
      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      return await this.upload(path, blob, true);
    }
  };

  // ================= TOAST NOTIFICATIONS & CUSTOM DIALOGS =================
  function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    const bgClass = type === "success" 
      ? "bg-[#161616] border-emerald-500/50 text-emerald-300 shadow-emerald-950/30"
      : type === "error"
      ? "bg-[#161616] border-rose-500/50 text-rose-300 shadow-rose-950/30"
      : type === "warning"
      ? "bg-[#161616] border-amber-500/50 text-amber-300 shadow-amber-950/30"
      : "bg-[#161616] border-[#850000]/60 text-white shadow-red-950/30";

    toast.className = `pointer-events-auto px-4 py-3 rounded-xl border text-xs font-semibold shadow-2xl flex items-center space-x-2.5 transition-all duration-300 transform translate-y-2 opacity-0 ${bgClass}`;
    
    const iconName = type === "success" ? "check-circle-2" : (type === "error" || type === "warning") ? "alert-circle" : "info";
    toast.innerHTML = `
      <i data-lucide="${iconName}" class="w-4 h-4 flex-shrink-0" aria-hidden="true"></i>
      <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    initIcons();

    requestAnimationFrame(() => {
      toast.classList.remove("translate-y-2", "opacity-0");
    });

    setTimeout(() => {
      toast.classList.add("opacity-0", "translate-y-2");
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function customAlert({ title = "Уведомление", message = "", type = "info", confirmText = "Понятно" }) {
    return new Promise((resolve) => {
      const modal = document.getElementById("customDialogModal");
      const box = document.getElementById("customDialogBox");
      const titleEl = document.getElementById("dialogTitle");
      const msgEl = document.getElementById("dialogMessage");
      const iconContainer = document.getElementById("dialogIconContainer");
      const confirmBtn = document.getElementById("dialogConfirmBtn");
      const cancelBtn = document.getElementById("dialogCancelBtn");

      if (!modal || !box) {
        showToast(message, type);
        resolve();
        return;
      }

      titleEl.innerText = title;
      msgEl.innerText = message;
      confirmBtn.innerText = confirmText;
      cancelBtn?.classList.add("hidden");

      if (type === "warning") {
        iconContainer.className = "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-amber-500/10 border-amber-500/30 text-amber-400";
        iconContainer.innerHTML = '<i data-lucide="alert-triangle" class="w-5 h-5" aria-hidden="true"></i>';
      } else if (type === "error") {
        iconContainer.className = "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-rose-500/10 border-rose-500/30 text-rose-400";
        iconContainer.innerHTML = '<i data-lucide="alert-circle" class="w-5 h-5" aria-hidden="true"></i>';
      } else if (type === "success") {
        iconContainer.className = "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-emerald-500/10 border-emerald-500/30 text-emerald-400";
        iconContainer.innerHTML = '<i data-lucide="check-circle-2" class="w-5 h-5" aria-hidden="true"></i>';
      } else {
        iconContainer.className = "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-[#850000]/15 border-[#850000]/30 text-[#f87171]";
        iconContainer.innerHTML = '<i data-lucide="info" class="w-5 h-5" aria-hidden="true"></i>';
      }

      initIcons();

      function cleanup() {
        releaseFocus();
        box.classList.remove("scale-100", "opacity-100");
        box.classList.add("scale-95", "opacity-0");
        setTimeout(() => modal.classList.add("hidden"), 180);
        confirmBtn.onclick = null;
        document.removeEventListener("keydown", keyHandler);
      }

      function keyHandler(e) {
        if (e.key === "Enter" || e.key === "Escape") {
          cleanup();
          resolve();
        }
      }

      confirmBtn.onclick = () => {
        cleanup();
        resolve();
      };

      document.addEventListener("keydown", keyHandler);

      modal.classList.remove("hidden");
      trapFocus(modal);
      requestAnimationFrame(() => {
        box.classList.remove("scale-95", "opacity-0");
        box.classList.add("scale-100", "opacity-100");
        confirmBtn.focus();
      });
    });
  }

  function customConfirm({ title = "Подтверждение", message = "", type = "warning", confirmText = "Да, подтвердить", cancelText = "Отмена" }) {
    return new Promise((resolve) => {
      const modal = document.getElementById("customDialogModal");
      const box = document.getElementById("customDialogBox");
      const titleEl = document.getElementById("dialogTitle");
      const msgEl = document.getElementById("dialogMessage");
      const iconContainer = document.getElementById("dialogIconContainer");
      const confirmBtn = document.getElementById("dialogConfirmBtn");
      const cancelBtn = document.getElementById("dialogCancelBtn");

      if (!modal || !box) {
        resolve(confirm(message));
        return;
      }

      titleEl.innerText = title;
      msgEl.innerText = message;
      confirmBtn.innerText = confirmText;
      if (cancelBtn) {
        cancelBtn.innerText = cancelText;
        cancelBtn.classList.remove("hidden");
      }

      iconContainer.className = "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-[#850000]/15 border-[#850000]/30 text-[#f87171]";
      iconContainer.innerHTML = '<i data-lucide="help-circle" class="w-5 h-5" aria-hidden="true"></i>';
      initIcons();

      function cleanup(res) {
        releaseFocus();
        box.classList.remove("scale-100", "opacity-100");
        box.classList.add("scale-95", "opacity-0");
        setTimeout(() => modal.classList.add("hidden"), 180);
        confirmBtn.onclick = null;
        if (cancelBtn) cancelBtn.onclick = null;
        document.removeEventListener("keydown", keyHandler);
        resolve(res);
      }

      function keyHandler(e) {
        if (e.key === "Escape") {
          cleanup(false);
        } else if (e.key === "Enter") {
          cleanup(true);
        }
      }

      confirmBtn.onclick = () => cleanup(true);
      if (cancelBtn) cancelBtn.onclick = () => cleanup(false);
      document.addEventListener("keydown", keyHandler);

      modal.classList.remove("hidden");
      trapFocus(modal);
      requestAnimationFrame(() => {
        box.classList.remove("scale-95", "opacity-0");
        box.classList.add("scale-100", "opacity-100");
        confirmBtn.focus();
      });
    });
  }

  // Override global window.alert
  window.alert = (msg) => customAlert({ message: String(msg) });

  // ================= INITIALIZATION =================
  window.addEventListener("DOMContentLoaded", async () => {
    setupPinInputs();
    setupDragAndDrop();
    setupGlobalShortcuts();
    updateWeekBadge();

    // Initialize device role UI based on saved preference or default
    setDeviceRoleUI(localStorage.getItem("disk_is_master_device") === "true" ? "master" : "college");

    // Check if session is already saved
    const savedPin = localStorage.getItem("disk_auth_pin");
    const savedSessionId = localStorage.getItem("disk_session_id");
    const savedRole = localStorage.getItem("disk_device_role") || "college";

    if (savedPin) {
      const isMasterValid = await isMasterPinValid(savedPin);
      const isWeeklyValid = await isWeeklyPinValid(savedPin);

      if (isMasterValid || isWeeklyValid) {
        // Enforce strict security: only genuine Master PIN can hold "master" role
        if (savedRole === "master" && isMasterValid) {
          currentDeviceRole = "master";
        } else {
          currentDeviceRole = "college";
          localStorage.setItem("disk_device_role", "college");
          localStorage.removeItem("disk_is_master_device");
        }

        // If it's a college session, check if it was revoked remotely
        if (currentDeviceRole === "college" && savedSessionId) {
          const isRevoked = await isSessionRevokedInCloud(savedSessionId);
          if (isRevoked) {
            localStorage.removeItem("disk_auth_pin");
            localStorage.removeItem("disk_session_id");
            localStorage.removeItem("disk_device_role");
            showPinScreen();
            customAlert({
              title: "Доступ закрыт",
              message: "Предыдущая сессия на этом ПК была завершена удаленно с вашего основного устройства.",
              type: "warning"
            });
            startBackgroundSync();
            return;
          }
        }
        await registerCurrentSession();
        await unlockDisk();
      } else {
        localStorage.removeItem("disk_auth_pin");
        showPinScreen();
      }
    } else {
      showPinScreen();
    }

    startBackgroundSync();
  });

  function startBackgroundSync() {
    if (syncIntervalId) clearInterval(syncIntervalId);
    
    // Background sync every 30s only when tab is visible
    syncIntervalId = setInterval(async () => {
      if (isUnlocked && !document.hidden) {
        const foldersChanged = await syncFoldersFromCloud();
        const filesChanged = await syncFilesFromCloud();
        if (foldersChanged) renderSubjectsNav();
        if (filesChanged || foldersChanged) renderFiles();
        await checkSessionsStatus();
      }
    }, 30000);
  }

  // Immediate sync when tab becomes visible after being backgrounded
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden && isUnlocked) {
      const foldersChanged = await syncFoldersFromCloud();
      const filesChanged = await syncFilesFromCloud();
      if (foldersChanged) renderSubjectsNav();
      if (filesChanged || foldersChanged) renderFiles();
      await checkSessionsStatus();
    }
  });

  function initIcons(root = document) {
    if (window.lucide) {
      window.lucide.createIcons({ root });
    }
  }

  // Global keyboard shortcuts (Escape to close any open modal)
  function setupGlobalShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const previewModal = document.getElementById("previewModal");
        const createModal = document.getElementById("createSubjectModal");
        const renameModal = document.getElementById("renameSubjectModal");
        const uploadSelectModal = document.getElementById("selectUploadSubjectModal");
        const devicesModal = document.getElementById("devicesModal");
        const weeklyCodeModal = document.getElementById("weeklyCodeModal");

        if (previewModal && !previewModal.classList.contains("hidden")) {
          closePreviewModal();
        } else if (createModal && !createModal.classList.contains("hidden")) {
          closeCreateSubjectModal();
        } else if (renameModal && !renameModal.classList.contains("hidden")) {
          closeRenameSubjectModal();
        } else if (uploadSelectModal && !uploadSelectModal.classList.contains("hidden")) {
          closeSelectUploadSubjectModal();
        } else if (devicesModal && !devicesModal.classList.contains("hidden")) {
          closeDevicesModal();
        } else if (weeklyCodeModal && !weeklyCodeModal.classList.contains("hidden")) {
          closeWeeklyCodeModal();
        }
      }
    });
  }

  // ================= WEEKLY PIN & AUTHENTICATION =================
  // Pure JS Synchronous SHA-256 implementation (Fallback for file:// protocol, non-HTTPS and environments without crypto.subtle)
  function sha256Sync(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    const mathPow = Math.pow;
    const lengthProperty = 'length';
    let i, j;
    let result = '';
    const words = [];
    const hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    const utf8 = unescape(encodeURIComponent(ascii));
    const len = utf8.length;
    for (i = 0; i < len; i++) {
      words[i >> 2] = (words[i >> 2] || 0) | ((utf8.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8));
    }
    words[len >> 2] = (words[len >> 2] || 0) | (0x80 << (24 - (len % 4) * 8));
    const totalWords = (((len + 8) >> 6) + 1) * 16;
    for (i = (len >> 2) + 1; i < totalWords; i++) {
      words[i] = 0;
    }
    words[totalWords - 1] = len * 8;

    for (j = 0; j < totalWords; j += 16) {
      const w = [];
      for (i = 0; i < 16; i++) {
        w[i] = words[j + i] | 0;
      }
      for (i = 16; i < 64; i++) {
        const gamma0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const gamma1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = ((w[i - 16] + gamma0 + w[i - 7] + gamma1) | 0);
      }

      let [a, b, c, d, e, f, g, h] = hash;

      for (i = 0; i < 64; i++) {
        const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
        const ch = (e & f) ^ ((~e) & g);
        const temp1 = ((h + s1 + ch + k[i] + w[i]) | 0);
        const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = ((s0 + maj) | 0);

        h = g;
        g = f;
        f = e;
        e = ((d + temp1) | 0);
        d = c;
        c = b;
        b = a;
        a = ((temp1 + temp2) | 0);
      }

      hash[0] = (hash[0] + a) | 0;
      hash[1] = (hash[1] + b) | 0;
      hash[2] = (hash[2] + c) | 0;
      hash[3] = (hash[3] + d) | 0;
      hash[4] = (hash[4] + e) | 0;
      hash[5] = (hash[5] + f) | 0;
      hash[6] = (hash[7] ? hash[6] + g : hash[6] + g) | 0;
      hash[7] = (hash[7] + h) | 0;
    }

    for (i = 0; i < 8; i++) {
      result += ('00000000' + (hash[i] >>> 0).toString(16)).slice(-8);
    }
    return result.toLowerCase();
  }

  // Private helper — NOT accessible on window
  function getWeeklyCodeInfo() {
    const now = new Date();
    
    // Strict local calendar calculation to avoid UTC+3 (MSK) night lag
    const localYear = now.getFullYear();
    const localMonth = now.getMonth();
    const localDate = now.getDate();
    const localDay = now.getDay(); // 0 is Sun, 1 is Mon...
    
    // Find Monday of current calendar week in local time
    const diffToMonday = (localDay === 0 ? -6 : 1) - localDay;
    const currentMonday = new Date(localYear, localMonth, localDate + diffToMonday, 0, 0, 0, 0);

    // Base epoch: Monday, Jan 5, 2026 (00:00:00 local time)
    const baseEpoch = new Date(2026, 0, 5, 0, 0, 0, 0).getTime();
    const diffWeeks = Math.max(0, Math.floor((currentMonday.getTime() - baseEpoch) / (7 * 24 * 60 * 60 * 1000)));
    const weekNum = diffWeeks + 1;

    // Deterministic 4-digit PIN: 1000 - 9999
    const code = (((weekNum * 3721 + 9482) % 9000) + 1000).toString();

    // Next Monday date in Russian format
    const daysUntilNextMon = ((8 - localDay) % 7) || 7;
    const nextMonday = new Date(localYear, localMonth, localDate + daysUntilNextMon);
    const nextMonFormatted = nextMonday.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

    return { weekNum, code, nextMonFormatted };
  }

  function updateWeekBadge() {
    const badge = document.getElementById("pinWeekBadge");
    if (!badge) return;
    const info = getWeeklyCodeInfo();
    badge.innerText = `НЕДЕЛЯ ${info.weekNum} • ДО ${info.nextMonFormatted.toUpperCase()}`;
  }

  async function sha256Hex(str) {
    try {
      if (window.crypto && crypto.subtle && window.TextEncoder) {
        const buffer = new TextEncoder().encode(str);
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (e) {
      console.warn("crypto.subtle fallback to sha256Sync:", e);
    }
    // Reliable fallback for file:// protocol, local execution and older browsers
    return sha256Sync(str);
  }

  async function isMasterPinValid(inputPin) {
    if (!inputPin) return false;
    const trimmed = inputPin.toString().trim();
    const saltedString = MASTER_SALT + trimmed + MASTER_PEPPER;
    const computedSaltedHash = await sha256Hex(saltedString);
    return computedSaltedHash && computedSaltedHash === MASTER_PIN_SALTED_HASH;
  }

  async function isWeeklyPinValid(inputPin) {
    if (!inputPin) return false;
    const trimmed = inputPin.toString().trim();
    const { code } = getWeeklyCodeInfo();
    return trimmed === code;
  }

  // Private PIN verification function — NOT accessible on window
  async function isPinValid(inputPin) {
    if (!inputPin) return false;
    if (await isWeeklyPinValid(inputPin)) return true;
    if (await isMasterPinValid(inputPin)) return true;
    return false;
  }

  function showPinScreen() {
    isUnlocked = false;
    document.getElementById("pinScreen")?.classList.remove("hidden");
    document.getElementById("mainApp")?.classList.add("hidden");
    clearPinInputs();
    setTimeout(() => {
      document.getElementById("pin0")?.focus();
    }, 100);
  }

  // Private unlock function — NOT accessible on window
  async function unlockDisk() {
    isUnlocked = true;
    document.getElementById("pinScreen")?.classList.add("hidden");
    document.getElementById("mainApp")?.classList.remove("hidden");
    
    // Toggle devices manager & weekly code widget strictly for master device
    const devicesBtn = document.getElementById("devicesManagerBtn");
    const weeklyCodeWidget = document.getElementById("masterWeeklyCodeWidget");

    if (currentDeviceRole === "master") {
      devicesBtn?.classList.remove("hidden");
      devicesBtn?.classList.add("inline-flex");

      weeklyCodeWidget?.classList.remove("hidden");
      weeklyCodeWidget?.classList.add("inline-flex");
      checkAndNotifyWeeklyCodeOnMaster();
    } else {
      devicesBtn?.classList.add("hidden");
      devicesBtn?.classList.remove("inline-flex");

      weeklyCodeWidget?.classList.add("hidden");
      weeklyCodeWidget?.classList.remove("inline-flex");
    }

    initIcons();

    // Only load data after private authentication succeeds
    await syncFoldersFromCloud();
    await syncFilesFromCloud();
    updateZipButtonVisibility();
    renderSubjectsNav();
    renderFiles();
    updateSessionsUI();
  }

  function handleLock() {
    localStorage.removeItem("disk_auth_pin");
    isUnlocked = false;
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
      syncIntervalId = null;
    }
    filesDb = [];
    lastFilesSyncCache = "";
    lastFoldersSyncCache = "";
    searchQuery = "";
    const filesContainer = document.getElementById("filesContainer");
    if (filesContainer) filesContainer.innerHTML = "";
    const previewBody = document.getElementById("previewBody");
    if (previewBody) previewBody.innerHTML = "";
    closePreviewModal();
    closeCreateSubjectModal();
    closeRenameSubjectModal();
    closeSelectUploadSubjectModal();
    closeDevicesModal();
    closeWeeklyCodeModal();
    isWeeklyCodeRevealed = false;
    if (weeklyCodeAutoHideTimer) {
      clearTimeout(weeklyCodeAutoHideTimer);
      weeklyCodeAutoHideTimer = null;
    }
    showPinScreen();
    showToast("Хранилище заблокировано", "info");
  }

  function togglePinVisibility() {
    isPinMasked = !isPinMasked;
    const inputs = [
      document.getElementById("pin0"),
      document.getElementById("pin1"),
      document.getElementById("pin2"),
      document.getElementById("pin3")
    ];

    inputs.forEach(input => {
      if (input) {
        input.type = isPinMasked ? "password" : "text";
        if (isPinMasked) {
          input.classList.add("pin-masked");
        } else {
          input.classList.remove("pin-masked");
        }
      }
    });

    const eyeIcon = document.getElementById("pinEyeIcon");
    if (eyeIcon) {
      eyeIcon.setAttribute("data-lucide", isPinMasked ? "eye" : "eye-off");
      initIcons(eyeIcon.parentElement);
    }
  }

  function setupPinInputs() {
    const inputs = [
      document.getElementById("pin0"),
      document.getElementById("pin1"),
      document.getElementById("pin2"),
      document.getElementById("pin3")
    ];

    inputs.forEach((input, index) => {
      if (!input) return;

      input.addEventListener("input", (e) => {
        document.getElementById("pinError")?.classList.add("hidden");

        const val = e.target.value.replace(/[^0-9]/g, "");
        e.target.value = val ? val[val.length - 1] : "";

        if (val && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" || e.keyCode === 8) {
          if (!input.value && index > 0) {
            inputs[index - 1].focus();
            inputs[index - 1].value = "";
            e.preventDefault();
          }
        } else if (e.key === "Enter") {
          e.preventDefault();
          handlePinSubmit(e);
        }
      });

      // Android Gboard / virtual keyboard Backspace support (handles keyCode 229)
      input.addEventListener("beforeinput", (e) => {
        if (e.inputType === "deleteContentBackward" && !input.value && index > 0) {
          inputs[index - 1].focus();
          inputs[index - 1].value = "";
          e.preventDefault();
        }
      });

      input.addEventListener("paste", (e) => {
        e.preventDefault();
        document.getElementById("pinError")?.classList.add("hidden");
        const paste = (e.clipboardData || window.clipboardData).getData("text").replace(/[^0-9]/g, "");
        if (paste.length > 0) {
          for (let i = 0; i < 4; i++) {
            if (i < paste.length) {
              inputs[i].value = paste[i];
            }
          }
          if (paste.length >= 4) {
            inputs[3].focus();
          } else {
            inputs[Math.min(3, paste.length)].focus();
          }
        }
      });
    });
  }

  function clearPinInputs() {
    ["pin0", "pin1", "pin2", "pin3"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
  }

  function handlePinSubmit(e) {
    if (e) e.preventDefault();
    const inputs = ["pin0", "pin1", "pin2", "pin3"].map(id => document.getElementById(id)?.value || "");
    const fullPin = inputs.join("");

    if (fullPin.length < 4) {
      const errorEl = document.getElementById("pinError");
      if (errorEl) {
        errorEl.innerText = "Пожалуйста, введите все 4 цифры кода доступа.";
        errorEl.classList.remove("hidden");
      }
      const container = document.getElementById("pinInputsContainer");
      if (container) {
        container.classList.add("animate-pulse");
        setTimeout(() => container.classList.remove("animate-pulse"), 600);
      }
      const emptyIdx = inputs.findIndex(v => !v);
      if (emptyIdx >= 0) {
        document.getElementById(`pin${emptyIdx}`)?.focus();
      }
      return;
    }

    processPinAttempt(fullPin);
  }

  async function processPinAttempt(pin) {
    if (isAuthenticating) return;
    isAuthenticating = true;

    const submitBtn = document.getElementById("pinSubmitBtn");
    const originalBtnHtml = submitBtn ? submitBtn.innerHTML : "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span class="animate-spin text-white mr-2" aria-hidden="true">⏳</span><span>Проверка доступа...</span>`;
    }

    try {
      const errorEl = document.getElementById("pinError");
      const rememberCheckbox = document.getElementById("rememberPinCheckbox");

      const isMasterPin = await isMasterPinValid(pin);
      const isWeeklyPin = await isWeeklyPinValid(pin);

      if (!isMasterPin && !isWeeklyPin) {
        if (errorEl) {
          errorEl.innerText = "Неверный код доступа! Попробуйте снова.";
          errorEl.classList.remove("hidden");
        }
        const container = document.getElementById("pinInputsContainer");
        if (container) {
          container.classList.add("animate-pulse");
          setTimeout(() => container.classList.remove("animate-pulse"), 600);
        }
        clearPinInputs();
        document.getElementById("pin0")?.focus();
        return;
      }

      // Check role enforcement
      if (selectedLoginRole === "master") {
        if (!isMasterPin) {
          // Weekly PIN used with Master mode selected
          if (errorEl) {
            errorEl.innerText = "Еженедельный код предназначен для режима «ПК в колледже». Для Основного ПК требуется постоянный Мастер-код.";
            errorEl.classList.remove("hidden");
          }
          showToast("Для Основного ПК требуется Мастер-код", "warning");
          clearPinInputs();
          document.getElementById("pin0")?.focus();
          return;
        }
        currentDeviceRole = "master";
        localStorage.setItem("disk_is_master_device", "true");
      } else {
        currentDeviceRole = "college";
        localStorage.removeItem("disk_is_master_device");
      }

      localStorage.setItem("disk_device_role", currentDeviceRole);

      if (rememberCheckbox && rememberCheckbox.checked) {
        localStorage.setItem("disk_auth_pin", pin);
      } else {
        localStorage.removeItem("disk_auth_pin");
      }

      errorEl?.classList.add("hidden");

      // Register session in cloud registry
      await registerCurrentSession();

      await unlockDisk();
      showToast(currentDeviceRole === "master" ? "Вход выполнен: Основное устройство (Владелец)" : "Вход выполнен: ПК в колледже (Учебная сессия)", "success");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnHtml;
        initIcons(submitBtn);
      }
      isAuthenticating = false;
    }
  }

  // ================= SUBJECTS (FOLDERS) MANAGEMENT =================
  function normalizeFolders(list) {
    if (!Array.isArray(list)) return [];
    return list.map(f => ({
      id: f.id,
      name: f.name,
      createdAt: f.createdAt || new Date().toISOString(),
      subfolders: Array.isArray(f.subfolders) ? f.subfolders.map(s => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt || new Date().toISOString()
      })) : []
    }));
  }

  function formatFolderSize(files) {
    const bytes = (files || []).reduce((acc, f) => acc + (f.size || 0), 0);
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
    return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
  }

  async function syncFoldersFromCloud() {
    const data = await StorageService.fetchJson("folders_db.json");
    
    // Strict safety check: If network hiccup, do not corrupt local or cloud data
    if (data === null || data === undefined) {
      return false;
    }

    const dataStr = JSON.stringify(data);
    if (dataStr === lastFoldersSyncCache) {
      return false;
    }
    lastFoldersSyncCache = dataStr;

    if (Array.isArray(data) && data.length > 0) {
      foldersDb = normalizeFolders(data);
      return true;
    }

    if (Array.isArray(data) && data.length === 0 && foldersDb.length === 0 && typeof DEFAULT_SUBJECTS !== "undefined") {
      foldersDb = normalizeFolders(DEFAULT_SUBJECTS);
      await saveFoldersToCloud();
      return true;
    }
    return false;
  }

  async function saveFoldersToCloud() {
    try {
      lastFoldersSyncCache = JSON.stringify(foldersDb);
      await StorageService.saveJson("folders_db.json", foldersDb);
    } catch (e) {
      console.warn("Failed to save folders:", e);
      showToast("Не удалось синхронизировать папки с облаком", "error");
    }
  }

  function renderSubjectsNav() {
    const container = document.getElementById("subjectsNavList");
    if (!container) return;

    const totalFiles = filesDb.length;

    let html = `
      <!-- ALL SUBJECTS BUTTON -->
      <div 
        role="button"
        tabindex="0"
        aria-current="${currentSubjectId === 'ALL' ? 'true' : 'false'}"
        onclick="selectSubject('ALL')"
        onkeydown="if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSubject('ALL'); }"
        class="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold cursor-pointer select-none transition-all active:scale-[0.99] ${
          currentSubjectId === 'ALL'
            ? 'bg-[#181111] text-white border-l-[3px] border-[#ef4444] shadow-sm'
            : 'text-[#cccccc] hover:text-white hover:bg-[#161616]'
        }"
      >
        <div class="flex items-center space-x-2.5 min-w-0 flex-1 truncate pointer-events-none">
          <i data-lucide="layers" class="w-4 h-4 flex-shrink-0 ${currentSubjectId === 'ALL' ? 'text-[#ef4444]' : 'text-[#a3a3a3]'}" aria-hidden="true"></i>
          <span class="truncate">Все предметы</span>
        </div>
        <span class="px-2 py-0.5 rounded text-[11px] font-mono pointer-events-none ml-2 ${
          currentSubjectId === 'ALL' ? 'bg-[#850000]/40 text-[#f87171] border border-[#850000]/50' : 'bg-[#141414] text-[#a3a3a3] border border-[#222222]'
        }">${totalFiles}</span>
      </div>
    `;

    foldersDb.forEach(folder => {
      const folderFiles = filesDb.filter(f => f.folderId === folder.id);
      const count = folderFiles.length;
      const isSelected = currentSubjectId === folder.id;
      const safeFolderId = escapeHtml(folder.id);
      const subfolders = folder.subfolders || [];
      const hasSubfolders = subfolders.length > 0;

      html += `
        <div class="space-y-0.5">
          <div 
            role="button"
            tabindex="0"
            aria-current="${isSelected && !currentSubfolderId ? 'true' : 'false'}"
            onclick="selectSubject('${safeFolderId}')"
            onkeydown="if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSubject('${safeFolderId}'); }"
            class="group w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs cursor-pointer select-none transition-all active:scale-[0.99] ${
              isSelected && !currentSubfolderId
                ? 'bg-[#181111] text-white font-bold border-l-[3px] border-[#ef4444] shadow-sm'
                : isSelected
                  ? 'bg-[#151212] text-white font-medium'
                  : 'text-[#cccccc] hover:text-white hover:bg-[#161616]'
            }"
          >
            <div class="flex items-center space-x-2.5 min-w-0 flex-1 truncate pointer-events-none">
              <i data-lucide="${isSelected ? 'folder-open' : 'folder'}" class="w-4 h-4 flex-shrink-0 ${isSelected ? 'text-[#ef4444]' : 'text-amber-500/80'}" aria-hidden="true"></i>
              <span class="truncate font-medium">${escapeHtml(folder.name)}</span>
            </div>

            <div class="flex items-center space-x-1.5 flex-shrink-0 ml-2" onclick="event.stopPropagation()">
              <span class="px-2 py-0.5 rounded text-[11px] font-mono text-[#a3a3a3] bg-[#141414] border border-[#222222]">${count}</span>
              
              <!-- Actions on hover / tap -->
              <div class="flex items-center opacity-70 group-hover:opacity-100 transition-opacity space-x-0.5">
                <button 
                  type="button"
                  onclick="event.stopPropagation(); openCreateSubfolderModal('${safeFolderId}')"
                  title="Создать подпапку"
                  aria-label="Создать подпапку в ${escapeHtml(folder.name)}"
                  class="w-7 h-7 flex items-center justify-center text-[#a3a3a3] hover:text-amber-400 hover:bg-amber-500/15 rounded-lg transition-all"
                >
                  <i data-lucide="folder-plus" class="w-3.5 h-3.5" aria-hidden="true"></i>
                </button>
                <button 
                  type="button"
                  onclick="event.stopPropagation(); openRenameSubjectModal('${safeFolderId}')"
                  title="Переименовать предмет"
                  aria-label="Переименовать предмет ${escapeHtml(folder.name)}"
                  class="w-7 h-7 flex items-center justify-center text-[#a3a3a3] hover:text-[#f87171] hover:bg-[#850000]/15 rounded-lg transition-all"
                >
                  <i data-lucide="edit-2" class="w-3.5 h-3.5" aria-hidden="true"></i>
                </button>
                <button 
                  type="button"
                  onclick="event.stopPropagation(); deleteSubject('${safeFolderId}')"
                  title="Удалить предмет"
                  aria-label="Удалить предмет ${escapeHtml(folder.name)}"
                  class="w-7 h-7 flex items-center justify-center text-[#a3a3a3] hover:text-rose-400 hover:bg-rose-500/15 rounded-lg transition-all"
                >
                  <i data-lucide="trash-2" class="w-3.5 h-3.5" aria-hidden="true"></i>
                </button>
              </div>
            </div>
          </div>
      `;

      // Render subfolders list indented under subject
      if (hasSubfolders) {
        html += `<div class="ml-4 pl-2.5 border-l border-[#242424] my-1 space-y-0.5">`;
        subfolders.forEach(sub => {
          const subCount = filesDb.filter(f => f.folderId === folder.id && f.subfolderId === sub.id).length;
          const isSubSelected = isSelected && currentSubfolderId === sub.id;
          const safeSubId = escapeHtml(sub.id);

          html += `
            <div 
              role="button"
              tabindex="0"
              onclick="event.stopPropagation(); selectSubjectAndSubfolder('${safeFolderId}', '${safeSubId}')"
              class="group/sub w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer select-none transition-all ${
                isSubSelected
                  ? 'bg-[#850000]/25 text-[#f87171] font-bold border-l-2 border-[#ef4444]'
                  : 'text-[#888888] hover:text-white hover:bg-[#161616]'
              }"
            >
              <div class="flex items-center space-x-2 min-w-0 flex-1 truncate pointer-events-none">
                <i data-lucide="corner-down-right" class="w-3 h-3 flex-shrink-0 ${isSubSelected ? 'text-[#ef4444]' : 'text-amber-500/70'}" aria-hidden="true"></i>
                <span class="truncate">${escapeHtml(sub.name)}</span>
              </div>
              <span class="text-[10px] font-mono text-[#666666] ml-1.5 flex-shrink-0 pointer-events-none">${subCount}</span>
            </div>
          `;
        });
        html += `</div>`;
      }

      html += `</div>`;
    });

    container.innerHTML = html;
    initIcons(container);
  }

  function selectSubject(id) {
    currentSubjectId = String(id || "ALL");
    currentSubfolderId = null;
    updateHeaderBreadcrumbs();
    updateZipButtonVisibility();
    updateDropZonePrompt();
    renderSubjectsNav();
    renderFiles();
  }

  function selectSubfolder(subId) {
    currentSubfolderId = subId ? String(subId) : null;
    updateHeaderBreadcrumbs();
    updateZipButtonVisibility();
    updateDropZonePrompt();
    renderSubjectsNav();
    renderFiles();
  }

  function selectSubjectAndSubfolder(subjId, subId) {
    currentSubjectId = String(subjId || "ALL");
    currentSubfolderId = subId ? String(subId) : null;
    updateHeaderBreadcrumbs();
    updateZipButtonVisibility();
    updateDropZonePrompt();
    renderSubjectsNav();
    renderFiles();
  }

  function updateDropZonePrompt() {
    const promptEl = document.getElementById("dropZoneTextPrompt");
    if (!promptEl) return;
    if (currentSubjectId === "ALL") {
      promptEl.innerText = "Перетащите файлы сюда или нажмите для выбора";
    } else {
      const folder = foldersDb.find(f => f.id === currentSubjectId);
      const folderName = folder ? folder.name : "Предмет";
      if (currentSubfolderId) {
        const sub = folder?.subfolders?.find(s => s.id === currentSubfolderId);
        const subName = sub ? sub.name : "Папка";
        promptEl.innerText = `Перетащите файлы для загрузки в папку «${subName}»`;
      } else {
        promptEl.innerText = `Перетащите файлы для загрузки в «${folderName}»`;
      }
    }
  }

  function updateZipButtonVisibility() {
    const zipBtn = document.getElementById("btnDownloadZip");
    const zipBtnText = document.getElementById("btnDownloadZipText");
    const createSubBtn = document.getElementById("btnCreateSubfolder");

    if (currentSubjectId === "ALL") {
      if (zipBtn) {
        zipBtn.classList.add("hidden");
        zipBtn.classList.remove("inline-flex");
      }
      if (createSubBtn) {
        createSubBtn.classList.add("hidden");
        createSubBtn.classList.remove("inline-flex");
      }
    } else {
      if (zipBtn) {
        zipBtn.classList.remove("hidden");
        zipBtn.classList.add("inline-flex");
        if (zipBtnText) {
          if (currentSubfolderId) {
            zipBtnText.innerText = "Скачать папку (ZIP)";
          } else {
            zipBtnText.innerText = "Скачать предмет (ZIP)";
          }
        }
      }
      if (createSubBtn) {
        createSubBtn.classList.remove("hidden");
        createSubBtn.classList.add("inline-flex");
      }
    }
  }

  function updateHeaderBreadcrumbs() {
    const slash1 = document.getElementById("breadcrumbSlash1");
    const subjBreadcrumb = document.getElementById("breadcrumbSubject");
    const slash2 = document.getElementById("breadcrumbSlash2");
    const titleEl = document.getElementById("currentSubjectTitle");
    const subEl = document.getElementById("currentSubjectSubtitle");

    if (!titleEl || !subEl) return;

    if (currentSubjectId === "ALL") {
      if (slash1) slash1.classList.remove("hidden");
      if (subjBreadcrumb) subjBreadcrumb.classList.add("hidden");
      if (slash2) slash2.classList.add("hidden");
      titleEl.innerText = "Все предметы";
      subEl.innerText = "Отображаются все сохранённые файлы диска";
    } else {
      const folder = foldersDb.find(f => f.id === currentSubjectId);
      const folderName = folder ? folder.name : "Предмет";

      if (currentSubfolderId) {
        const sub = folder?.subfolders?.find(s => s.id === currentSubfolderId);
        const subName = sub ? sub.name : "Подпапка";

        if (slash1) slash1.classList.remove("hidden");
        if (subjBreadcrumb) {
          subjBreadcrumb.classList.remove("hidden");
          subjBreadcrumb.innerText = folderName;
        }
        if (slash2) slash2.classList.remove("hidden");
        titleEl.innerText = subName;

        const filesCount = filesDb.filter(f => f.folderId === currentSubjectId && f.subfolderId === currentSubfolderId).length;
        subEl.innerText = `Подпапка предмета «${folderName}» • ${formatFilesCount(filesCount)}`;
      } else {
        if (slash1) slash1.classList.remove("hidden");
        if (subjBreadcrumb) subjBreadcrumb.classList.add("hidden");
        if (slash2) slash2.classList.add("hidden");
        titleEl.innerText = folderName;
        const subCount = (folder?.subfolders || []).length;
        const fileCount = filesDb.filter(f => f.folderId === currentSubjectId).length;
        subEl.innerText = `Папок: ${subCount} • Всего файлов: ${fileCount}`;
      }
    }
  }

  // Subject Modals
  function openCreateSubjectModal() {
    const modal = document.getElementById("createSubjectModal");
    const input = document.getElementById("newSubjectNameInput");
    if (!modal || !input) return;
    input.value = "";
    modal.classList.remove("hidden");
    trapFocus(modal);
    setTimeout(() => input.focus(), 50);
    initIcons(modal);
  }

  function closeCreateSubjectModal() {
    releaseFocus();
    document.getElementById("createSubjectModal")?.classList.add("hidden");
  }

  async function submitCreateSubject() {
    const input = document.getElementById("newSubjectNameInput");
    const name = (input ? input.value : "").trim();
    
    if (!name) {
      showToast("Введите название предмета", "error");
      input?.focus();
      return;
    }

    if (name.length > 60) {
      showToast("Название предмета не должно превышать 60 символов", "error");
      input?.focus();
      return;
    }

    const exists = foldersDb.some(f => f.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      showToast(`Предмет «${name}» уже существует`, "error");
      input?.focus();
      return;
    }

    const newSubject = {
      id: "subj_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      name: name,
      createdAt: new Date().toISOString(),
      subfolders: []
    };

    foldersDb.push(newSubject);
    await saveFoldersToCloud();
    closeCreateSubjectModal();
    selectSubject(newSubject.id);
    showToast(`Предмет «${name}» успешно создан!`, "success");
  }

  function openRenameSubjectModal(id) {
    const folder = foldersDb.find(f => f.id === id);
    if (!folder) return;
    const modal = document.getElementById("renameSubjectModal");
    const input = document.getElementById("renameSubjectInput");
    const idHolder = document.getElementById("renameSubjectId");
    if (!modal || !input || !idHolder) return;

    idHolder.value = id;
    input.value = folder.name;
    modal.classList.remove("hidden");
    trapFocus(modal);
    setTimeout(() => input.focus(), 50);
    initIcons(modal);
  }

  function closeRenameSubjectModal() {
    releaseFocus();
    document.getElementById("renameSubjectModal")?.classList.add("hidden");
  }

  async function submitRenameSubject() {
    const id = document.getElementById("renameSubjectId")?.value;
    const input = document.getElementById("renameSubjectInput");
    const newName = (input ? input.value : "").trim();
    
    if (!newName) {
      showToast("Название предмета не может быть пустым", "error");
      input?.focus();
      return;
    }

    if (newName.length > 60) {
      showToast("Название предмета не должно превышать 60 символов", "error");
      input?.focus();
      return;
    }

    const folder = foldersDb.find(f => f.id === id);
    if (folder) {
      folder.name = newName;
      await saveFoldersToCloud();
      closeRenameSubjectModal();
      updateHeaderBreadcrumbs();
      renderSubjectsNav();
      showToast(`Предмет переименован в «${newName}»`, "success");
    }
  }

  async function deleteSubject(id) {
    const folder = foldersDb.find(f => f.id === id);
    if (!folder) return;

    const count = filesDb.filter(f => f.folderId === id).length;
    let confirmMsg = `Вы действительно хотите удалить предмет «${folder.name}»?`;
    if (count > 0) {
      confirmMsg += `\n\n⚠️ ВНИМАНИЕ: Все находящиеся в нём файлы (${count} шт.) также будут безвозвратно удалены из облака!`;
    }

    const confirmed = await customConfirm({
      title: "Удаление предмета",
      message: confirmMsg,
      type: "warning",
      confirmText: "Удалить предмет",
      cancelText: "Отмена"
    });
    if (!confirmed) return;

    const subjectFiles = filesDb.filter(f => f.folderId === id);
    const keys = subjectFiles.map(f => f.storageKey).filter(Boolean);
    if (keys.length > 0) {
      const ok = await StorageService.remove(keys);
      if (!ok) {
        showToast("Предупреждение: некоторые файлы предмета не удалось удалить из бакета", "warning");
      }
    }

    filesDb = filesDb.filter(f => f.folderId !== id);
    foldersDb = foldersDb.filter(f => f.id !== id);

    await saveFoldersToCloud();
    await saveFilesToCloud();

    if (currentSubjectId === id) {
      selectSubject("ALL");
    } else {
      renderSubjectsNav();
      renderFiles();
    }

    showToast(`Предмет «${folder.name}» удалён`, "info");
  }

  // ================= SUBFOLDERS MANAGEMENT =================
  function openCreateSubfolderModal(targetSubjectId = null) {
    const subjId = targetSubjectId || (currentSubjectId !== "ALL" ? currentSubjectId : null);
    if (!subjId) {
      showToast("Сначала выберите предмет, в котором хотите создать папку", "info");
      return;
    }
    const folder = foldersDb.find(f => f.id === subjId);
    if (!folder) return;

    createSubfolderTargetSubjId = subjId;
    const modal = document.getElementById("createSubfolderModal");
    const input = document.getElementById("newSubfolderNameInput");
    const parentNameEl = document.getElementById("createSubfolderParentName");
    if (!modal || !input) return;

    if (parentNameEl) {
      parentNameEl.innerText = `В предмете: «${folder.name}»`;
    }
    input.value = "";
    modal.classList.remove("hidden");
    trapFocus(modal);
    setTimeout(() => input.focus(), 50);
    initIcons(modal);
  }

  function closeCreateSubfolderModal() {
    releaseFocus();
    document.getElementById("createSubfolderModal")?.classList.add("hidden");
    createSubfolderTargetSubjId = null;
  }

  async function submitCreateSubfolder() {
    const subjId = createSubfolderTargetSubjId || (currentSubjectId !== "ALL" ? currentSubjectId : null);
    const folder = foldersDb.find(f => f.id === subjId);
    if (!folder) return;

    const input = document.getElementById("newSubfolderNameInput");
    const name = (input ? input.value : "").trim();

    if (!name) {
      showToast("Введите название папки", "error");
      input?.focus();
      return;
    }

    if (name.length > 60) {
      showToast("Название папки не должно превышать 60 символов", "error");
      input?.focus();
      return;
    }

    folder.subfolders = folder.subfolders || [];
    const exists = folder.subfolders.some(s => s.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      showToast(`Папка «${name}» уже существует в этом предмете`, "error");
      input?.focus();
      return;
    }

    const newSubfolder = {
      id: "sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      name: name,
      createdAt: new Date().toISOString()
    };

    folder.subfolders.push(newSubfolder);
    await saveFoldersToCloud();
    closeCreateSubfolderModal();
    selectSubjectAndSubfolder(folder.id, newSubfolder.id);
    showToast(`Папка «${name}» успешно создана!`, "success");
  }

  function openRenameSubfolderModal(subId) {
    const folder = foldersDb.find(f => f.id === currentSubjectId);
    if (!folder || !folder.subfolders) return;
    const sub = folder.subfolders.find(s => s.id === subId);
    if (!sub) return;

    const modal = document.getElementById("renameSubfolderModal");
    const input = document.getElementById("renameSubfolderInput");
    const idHolder = document.getElementById("renameSubfolderId");
    if (!modal || !input || !idHolder) return;

    idHolder.value = subId;
    input.value = sub.name;
    modal.classList.remove("hidden");
    trapFocus(modal);
    setTimeout(() => input.focus(), 50);
    initIcons(modal);
  }

  function closeRenameSubfolderModal() {
    releaseFocus();
    document.getElementById("renameSubfolderModal")?.classList.add("hidden");
  }

  async function submitRenameSubfolder() {
    const id = document.getElementById("renameSubfolderId")?.value;
    const input = document.getElementById("renameSubfolderInput");
    const newName = (input ? input.value : "").trim();

    if (!newName) {
      showToast("Название папки не может быть пустым", "error");
      input?.focus();
      return;
    }

    if (newName.length > 60) {
      showToast("Название папки не должно превышать 60 символов", "error");
      input?.focus();
      return;
    }

    const folder = foldersDb.find(f => f.id === currentSubjectId);
    if (!folder || !folder.subfolders) return;
    const sub = folder.subfolders.find(s => s.id === id);
    if (sub) {
      sub.name = newName;
      await saveFoldersToCloud();
      closeRenameSubfolderModal();
      updateHeaderBreadcrumbs();
      renderSubjectsNav();
      renderFiles();
      showToast(`Папка переименована в «${newName}»`, "success");
    }
  }

  async function deleteSubfolder(subId) {
    const folder = foldersDb.find(f => f.id === currentSubjectId);
    if (!folder || !folder.subfolders) return;
    const sub = folder.subfolders.find(s => s.id === subId);
    if (!sub) return;

    const subFiles = filesDb.filter(f => f.folderId === currentSubjectId && f.subfolderId === subId);
    const count = subFiles.length;

    let confirmMsg = `Вы действительно хотите удалить папку «${sub.name}»?`;
    if (count > 0) {
      confirmMsg += `\n\n⚠️ ВНИМАНИЕ: Все находящиеся в ней файлы (${count} шт.) также будут безвозвратно удалены из облака!`;
    }

    const confirmed = await customConfirm({
      title: "Удаление папки",
      message: confirmMsg,
      type: "warning",
      confirmText: "Удалить папку",
      cancelText: "Отмена"
    });
    if (!confirmed) return;

    if (count > 0) {
      const keys = subFiles.map(f => f.storageKey).filter(Boolean);
      if (keys.length > 0) {
        await StorageService.remove(keys);
      }
      filesDb = filesDb.filter(f => !(f.folderId === currentSubjectId && f.subfolderId === subId));
      await saveFilesToCloud();
    }

    folder.subfolders = folder.subfolders.filter(s => s.id !== subId);
    await saveFoldersToCloud();

    if (currentSubfolderId === subId) {
      selectSubfolder(null);
    } else {
      renderSubjectsNav();
      renderFiles();
    }

    showToast(`Папка «${sub.name}» удалена`, "info");
  }

  // ================= MOVE FILE TO SUBFOLDER/SUBJECT =================
  function openMoveFileModal(fileId) {
    const file = filesDb.find(f => f.id === fileId);
    if (!file) return;

    const modal = document.getElementById("moveFileModal");
    const fileNameDisplay = document.getElementById("moveFileNameDisplay");
    const targetIdInput = document.getElementById("moveFileTargetFileId");
    const listContainer = document.getElementById("moveFileDestinationsList");
    if (!modal || !listContainer) return;

    targetIdInput.value = fileId;
    fileNameDisplay.innerText = file.name;

    let html = "";
    foldersDb.forEach((folder) => {
      const isSubject = file.folderId === folder.id;
      const isRoot = isSubject && (!file.subfolderId || file.subfolderId === null);
      const folderSafeId = escapeHtml(folder.id);

      html += `
        <div class="p-2.5 rounded-xl bg-[#161616] border border-[#262626] space-y-1.5">
          <label class="flex items-center space-x-2.5 cursor-pointer">
            <input type="radio" name="moveTargetRadio" value="${folderSafeId}:ROOT" ${isRoot ? 'checked' : ''} class="text-[#ef4444] focus:ring-0">
            <i data-lucide="folder" class="w-4 h-4 text-amber-500/80" aria-hidden="true"></i>
            <span class="text-xs font-bold text-white truncate">${escapeHtml(folder.name)} (Корень)</span>
          </label>
      `;

      if (folder.subfolders && folder.subfolders.length > 0) {
        html += `<div class="ml-6 space-y-1 border-l border-[#262626] pl-2.5">`;
        folder.subfolders.forEach(sub => {
          const isSub = isSubject && file.subfolderId === sub.id;
          html += `
            <label class="flex items-center space-x-2.5 cursor-pointer py-1 text-[#a3a3a3] hover:text-white transition-colors">
              <input type="radio" name="moveTargetRadio" value="${folderSafeId}:${escapeHtml(sub.id)}" ${isSub ? 'checked' : ''} class="text-[#ef4444] focus:ring-0">
              <i data-lucide="corner-down-right" class="w-3.5 h-3.5 text-[#ef4444]" aria-hidden="true"></i>
              <span class="text-xs truncate">${escapeHtml(sub.name)}</span>
            </label>
          `;
        });
        html += `</div>`;
      }

      html += `</div>`;
    });

    listContainer.innerHTML = html;
    modal.classList.remove("hidden");
    trapFocus(modal);
    initIcons(modal);
  }

  function closeMoveFileModal() {
    releaseFocus();
    document.getElementById("moveFileModal")?.classList.add("hidden");
  }

  async function submitMoveFile() {
    const fileId = document.getElementById("moveFileTargetFileId")?.value;
    const radios = document.getElementsByName("moveTargetRadio");
    let selectedVal = null;
    for (const r of radios) {
      if (r.checked) {
        selectedVal = r.value;
        break;
      }
    }

    if (!fileId || !selectedVal) {
      closeMoveFileModal();
      return;
    }

    const [targetFolderId, targetSubId] = selectedVal.split(":");
    const finalSubId = targetSubId === "ROOT" ? null : targetSubId;

    const file = filesDb.find(f => f.id === fileId);
    if (file) {
      file.folderId = targetFolderId;
      file.subfolderId = finalSubId;
      await saveFilesToCloud();
      closeMoveFileModal();
      renderSubjectsNav();
      renderFiles();
      showToast(`Файл «${file.name}» перемещён!`, "success");
    }
  }

  // ================= FILES MANAGEMENT & SORTING =================
  async function syncFilesFromCloud() {
    const data = await StorageService.fetchJson("cloud_index.json");
    if (data === null || data === undefined) {
      return false;
    }

    const dataStr = JSON.stringify(data);
    if (dataStr === lastFilesSyncCache) {
      return false;
    }
    lastFilesSyncCache = dataStr;

    if (Array.isArray(data)) {
      filesDb = data;
      return true;
    }
    return false;
  }

  async function saveFilesToCloud() {
    try {
      lastFilesSyncCache = JSON.stringify(filesDb);
      await StorageService.saveJson("cloud_index.json", filesDb);
    } catch (e) {
      console.warn("Failed to save files index:", e);
      showToast("Ошибка сохранения списка файлов", "error");
    }
  }

  const debouncedRenderFiles = debounce(() => {
    renderFiles();
  }, 180);

  function handleSearchInput(e) {
    searchQuery = (e.target.value || "").trim().toLowerCase();
    
    const mobileInput = document.getElementById("mobileFileSearchInput");
    if (mobileInput && mobileInput.value !== e.target.value) {
      mobileInput.value = e.target.value;
    }

    const clearBtn = document.getElementById("clearSearchBtn");
    if (clearBtn) {
      if (searchQuery) clearBtn.classList.remove("hidden");
      else clearBtn.classList.add("hidden");
    }
    debouncedRenderFiles();
  }

  function handleMobileSearchInput(e) {
    searchQuery = (e.target.value || "").trim().toLowerCase();

    const desktopInput = document.getElementById("fileSearchInput");
    if (desktopInput && desktopInput.value !== e.target.value) {
      desktopInput.value = e.target.value;
    }

    const clearMobileBtn = document.getElementById("clearMobileSearchBtn");
    if (clearMobileBtn) {
      if (searchQuery) clearMobileBtn.classList.remove("hidden");
      else clearMobileBtn.classList.add("hidden");
    }
    debouncedRenderFiles();
  }

  function toggleMobileSearch() {
    const container = document.getElementById("mobileSearchContainer");
    const input = document.getElementById("mobileFileSearchInput");
    if (!container) return;

    const isHidden = container.classList.contains("hidden");
    if (isHidden) {
      container.classList.remove("hidden");
      setTimeout(() => input?.focus(), 50);
    } else {
      container.classList.add("hidden");
    }
  }

  function clearSearch() {
    const input = document.getElementById("fileSearchInput");
    const mobileInput = document.getElementById("mobileFileSearchInput");
    if (input) input.value = "";
    if (mobileInput) mobileInput.value = "";
    searchQuery = "";
    document.getElementById("clearSearchBtn")?.classList.add("hidden");
    document.getElementById("clearMobileSearchBtn")?.classList.add("hidden");
    renderFiles();
  }

  function clearMobileSearch() {
    clearSearch();
  }

  function switchViewMode(mode) {
    viewMode = mode;
    localStorage.setItem("disk_view_mode", mode);

    const btnGrid = document.getElementById("viewBtnGrid");
    const btnList = document.getElementById("viewBtnList");

    if (mode === "grid") {
      if (btnGrid) btnGrid.className = "h-7 w-7 flex items-center justify-center rounded text-[#f87171] bg-[#222222] transition-all";
      if (btnList) btnList.className = "h-7 w-7 flex items-center justify-center rounded text-[#a3a3a3] hover:text-white transition-all ml-0.5";
    } else {
      if (btnList) btnList.className = "h-7 w-7 flex items-center justify-center rounded text-[#f87171] bg-[#222222] transition-all ml-0.5";
      if (btnGrid) btnGrid.className = "h-7 w-7 flex items-center justify-center rounded text-[#a3a3a3] hover:text-white transition-all";
    }

    renderFiles();
  }

  function changeSortMode(mode) {
    currentSortMode = mode || "date_desc";
    localStorage.setItem("disk_sort_mode", currentSortMode);
    renderFiles();
  }

  function sortFileList(list) {
    return [...list].sort((a, b) => {
      if (currentSortMode === "name_asc") {
        return a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" });
      }
      if (currentSortMode === "name_desc") {
        return b.name.localeCompare(a.name, "ru", { numeric: true, sensitivity: "base" });
      }
      if (currentSortMode === "size_desc") {
        return (b.size || 0) - (a.size || 0);
      }
      if (currentSortMode === "size_asc") {
        return (a.size || 0) - (b.size || 0);
      }
      if (currentSortMode === "date_asc") {
        return (a.id || "").localeCompare(b.id || "");
      }
      // default: date_desc (newest first)
      return (b.id || "").localeCompare(a.id || "");
    });
  }

  function renderSubfolderCard(folder, sub) {
    const subFiles = filesDb.filter(f => f.folderId === folder.id && f.subfolderId === sub.id);
    const safeSubId = escapeHtml(sub.id);
    const safeFolderId = escapeHtml(folder.id);

    return `
      <div 
        role="button"
        tabindex="0"
        onclick="selectSubjectAndSubfolder('${safeFolderId}', '${safeSubId}')"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); selectSubjectAndSubfolder('${safeFolderId}', '${safeSubId}');}"
        class="vault-card rounded-xl p-3.5 flex items-center justify-between cursor-pointer group transition-all select-none hover:border-[#850000]/60"
      >
        <div class="flex items-center space-x-3 min-w-0 flex-1 pointer-events-none">
          <div class="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 text-amber-400 group-hover:text-[#ef4444] group-hover:bg-[#850000]/20 group-hover:border-[#850000]/40 transition-all">
            <i data-lucide="folder" class="w-5 h-5" aria-hidden="true"></i>
          </div>
          <div class="min-w-0 flex-1">
            <h4 class="text-xs font-bold text-white truncate group-hover:text-[#f87171] transition-colors">${escapeHtml(sub.name)}</h4>
            <p class="text-[10px] text-[#a3a3a3] mt-0.5 truncate">${formatFilesCount(subFiles.length)} • ${formatFolderSize(subFiles)}</p>
          </div>
        </div>

        <div class="flex items-center space-x-0.5 ml-2 flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity" onclick="event.stopPropagation()">
          <button 
            type="button"
            onclick="event.stopPropagation(); openRenameSubfolderModal('${safeSubId}')" 
            title="Переименовать папку"
            aria-label="Переименовать папку ${escapeHtml(sub.name)}"
            class="w-7 h-7 flex items-center justify-center text-[#a3a3a3] hover:text-[#f87171] hover:bg-[#850000]/15 rounded-lg transition-all"
          >
            <i data-lucide="edit-2" class="w-3.5 h-3.5" aria-hidden="true"></i>
          </button>
          <button 
            type="button"
            onclick="event.stopPropagation(); deleteSubfolder('${safeSubId}')" 
            title="Удалить папку"
            aria-label="Удалить папку ${escapeHtml(sub.name)}"
            class="w-7 h-7 flex items-center justify-center text-[#a3a3a3] hover:text-rose-400 hover:bg-rose-500/15 rounded-lg transition-all"
          >
            <i data-lucide="trash-2" class="w-3.5 h-3.5" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    `;
  }

  function renderFiles() {
    const container = document.getElementById("filesContainer");
    if (!container) return;

    updateStorageMetrics();

    // Sync sort dropdown if present
    const sortSelect = document.getElementById("fileSortSelect");
    if (sortSelect && sortSelect.value !== currentSortMode) {
      sortSelect.value = currentSortMode;
    }

    // CASE 1: Inside a Subfolder (e.g. "1 практическая")
    if (currentSubjectId !== "ALL" && currentSubfolderId) {
      const folder = foldersDb.find(f => f.id === currentSubjectId);
      const sub = folder?.subfolders?.find(s => s.id === currentSubfolderId);

      if (!folder || !sub) {
        currentSubfolderId = null;
        renderFiles();
        return;
      }

      let subFiles = filesDb.filter(f => f.folderId === currentSubjectId && f.subfolderId === currentSubfolderId);
      if (searchQuery) {
        subFiles = subFiles.filter(f => f.name.toLowerCase().includes(searchQuery));
      }
      subFiles = sortFileList(subFiles);

      const safeSubId = escapeHtml(sub.id);

      let html = `
        <!-- Subfolder Back Navigation Pill -->
        <div class="flex items-center justify-between bg-[#141414] border border-[#242424] rounded-xl px-3.5 py-2.5 mb-4 shadow-sm">
          <button 
            type="button"
            onclick="selectSubfolder(null)" 
            class="inline-flex items-center space-x-2 text-xs font-bold text-[#cccccc] hover:text-[#f87171] transition-colors"
          >
            <i data-lucide="arrow-left" class="w-4 h-4 text-[#ef4444]" aria-hidden="true"></i>
            <span>Назад к предмету «${escapeHtml(folder.name)}»</span>
          </button>
          
          <div class="flex items-center space-x-1.5">
            <button 
              type="button"
              onclick="openRenameSubfolderModal('${safeSubId}')" 
              class="inline-flex items-center space-x-1 px-2.5 py-1 text-xs text-[#a3a3a3] hover:text-white bg-[#1a1a1a] hover:bg-[#222222] rounded-lg border border-[#2a2a2a] transition-all"
              title="Переименовать эту папку"
            >
              <i data-lucide="edit-2" class="w-3.5 h-3.5" aria-hidden="true"></i>
              <span class="hidden sm:inline">Переименовать</span>
            </button>
            <button 
              type="button"
              onclick="deleteSubfolder('${safeSubId}')" 
              class="inline-flex items-center space-x-1 px-2.5 py-1 text-xs text-rose-400 hover:text-white bg-rose-500/10 hover:bg-rose-500/30 rounded-lg border border-rose-500/20 transition-all"
              title="Удалить эту папку"
            >
              <i data-lucide="trash-2" class="w-3.5 h-3.5" aria-hidden="true"></i>
              <span class="hidden sm:inline">Удалить папку</span>
            </button>
          </div>
        </div>
      `;

      if (subFiles.length === 0) {
        html += `
          <div class="py-14 px-4 text-center border-2 border-dashed border-[#222222] rounded-2xl bg-[#101010]/60">
            <div class="w-14 h-14 mx-auto rounded-2xl bg-[#161616] border border-[#242424] text-[#a3a3a3] flex items-center justify-center mb-3">
              <i data-lucide="folder-open" class="w-7 h-7 text-amber-500" aria-hidden="true"></i>
            </div>
            <h3 class="text-sm font-bold text-white uppercase tracking-wider">Папка «${escapeHtml(sub.name)}» пуста</h3>
            <p class="text-xs text-[#a3a3a3] mt-1 max-w-sm mx-auto leading-relaxed">
              ${searchQuery ? 'Ничего не найдено по вашему запросу.' : `В этой папке пока нет файлов. Нажмите «Загрузить» или просто перетащите файлы сюда.`}
            </p>
            ${!searchQuery ? `
              <button 
                onclick="triggerFileInput()" 
                class="mt-4 px-4 py-2.5 btn-tactile-primary text-white rounded-xl text-xs font-bold uppercase tracking-wider inline-flex items-center space-x-1.5"
              >
                <i data-lucide="upload" class="w-3.5 h-3.5" aria-hidden="true"></i>
                <span>Загрузить файлы в «${escapeHtml(sub.name)}»</span>
              </button>
            ` : ''}
          </div>
        `;
      } else {
        if (viewMode === "grid") {
          html += `
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3.5">
              ${subFiles.map(file => renderFileCard(file)).join("")}
            </div>
          `;
        } else {
          html += `
            <div class="bg-[#121212] border border-[#222222] rounded-xl overflow-hidden divide-y divide-[#1e1e1e]">
              ${subFiles.map(file => renderFileRow(file)).join("")}
            </div>
          `;
        }
      }

      container.innerHTML = html;
      initIcons(container);
      return;
    }

    // CASE 2: Inside a Subject Root (`currentSubjectId !== "ALL"` and `currentSubfolderId === null`)
    if (currentSubjectId !== "ALL") {
      const folder = foldersDb.find(f => f.id === currentSubjectId);
      const subfolders = (folder && folder.subfolders) || [];

      // If user is searching, search all files in this subject
      if (searchQuery) {
        let searchedFiles = filesDb.filter(f => f.folderId === currentSubjectId && f.name.toLowerCase().includes(searchQuery));
        searchedFiles = sortFileList(searchedFiles);

        if (searchedFiles.length === 0) {
          container.innerHTML = `
            <div class="py-14 px-4 text-center border-2 border-dashed border-[#222222] rounded-2xl bg-[#101010]/60">
              <div class="w-14 h-14 mx-auto rounded-2xl bg-[#161616] border border-[#242424] text-[#a3a3a3] flex items-center justify-center mb-3">
                <i data-lucide="search" class="w-7 h-7 text-[#f87171]" aria-hidden="true"></i>
              </div>
              <h3 class="text-sm font-bold text-white uppercase tracking-wider">Ничего не найдено</h3>
              <p class="text-xs text-[#a3a3a3] mt-1 max-w-sm mx-auto">
                По запросу «${escapeHtml(searchQuery)}» в предмете «${escapeHtml(folder ? folder.name : '')}» файлов не найдено.
              </p>
            </div>
          `;
          initIcons(container);
          return;
        }

        container.innerHTML = viewMode === "grid"
          ? `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3.5">${searchedFiles.map(file => renderFileCard(file)).join("")}</div>`
          : `<div class="bg-[#121212] border border-[#222222] rounded-xl overflow-hidden divide-y divide-[#1e1e1e]">${searchedFiles.map(file => renderFileRow(file)).join("")}</div>`;
        initIcons(container);
        return;
      }

      // Normal display in Subject Root: Subfolders + Root files
      const rootFiles = sortFileList(filesDb.filter(f => f.folderId === currentSubjectId && (!f.subfolderId || f.subfolderId === null)));
      const hasSubfolders = subfolders.length > 0;
      const hasRootFiles = rootFiles.length > 0;

      if (!hasSubfolders && !hasRootFiles) {
        container.innerHTML = `
          <div class="py-16 px-4 text-center border-2 border-dashed border-[#222222] rounded-2xl bg-[#101010]/60">
            <div class="w-16 h-16 mx-auto rounded-2xl bg-[#161616] border border-[#242424] text-[#a3a3a3] flex items-center justify-center mb-4">
              <i data-lucide="folder-open" class="w-8 h-8 text-[#f87171]" aria-hidden="true"></i>
            </div>
            <h3 class="text-sm font-bold text-white uppercase tracking-wider">Предмет пока пуст</h3>
            <p class="text-xs text-[#a3a3a3] mt-1 max-w-sm mx-auto leading-relaxed">
              Создайте подпапку (например, «1 практическая») или сразу загрузите материалы.
            </p>
            <div class="mt-4 flex items-center justify-center gap-2.5 flex-wrap">
              <button 
                onclick="openCreateSubfolderModal()" 
                class="px-4 py-2.5 btn-tactile-primary text-white rounded-xl text-xs font-bold uppercase tracking-wider inline-flex items-center space-x-1.5"
              >
                <i data-lucide="folder-plus" class="w-3.5 h-3.5" aria-hidden="true"></i>
                <span>Создать папку</span>
              </button>
              <button 
                onclick="triggerFileInput()" 
                class="px-4 py-2.5 btn-tactile-secondary text-[#cccccc] hover:text-white rounded-xl text-xs font-bold uppercase tracking-wider inline-flex items-center space-x-1.5"
              >
                <i data-lucide="upload" class="w-3.5 h-3.5" aria-hidden="true"></i>
                <span>Загрузить файл</span>
              </button>
            </div>
          </div>
        `;
        initIcons(container);
        return;
      }

      let html = "";

      // 1. Subfolders Section
      if (hasSubfolders) {
        html += `
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center space-x-2">
                <i data-lucide="folder-tree" class="w-4 h-4 text-amber-500" aria-hidden="true"></i>
                <h3 class="text-xs font-bold text-white uppercase tracking-wider">Подпапки</h3>
                <span class="px-2 py-0.5 rounded text-[11px] font-mono text-[#a3a3a3] bg-[#161616] border border-[#262626]">${subfolders.length}</span>
              </div>
              <button 
                onclick="openCreateSubfolderModal()" 
                class="inline-flex items-center space-x-1 px-2.5 py-1 text-xs font-bold text-[#f87171] hover:text-white bg-[#850000]/15 hover:bg-[#970000] rounded-lg border border-[#850000]/30 transition-all"
              >
                <i data-lucide="folder-plus" class="w-3.5 h-3.5" aria-hidden="true"></i>
                <span>Создать папку</span>
              </button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              ${subfolders.map(sub => renderSubfolderCard(folder, sub)).join("")}
            </div>
          </div>
        `;
      }

      // 2. Root Files Section
      if (hasRootFiles) {
        html += `
          <div>
            <div class="flex items-center justify-between mb-3 ${hasSubfolders ? 'pt-4 border-t border-[#1e1e1e]' : ''}">
              <div class="flex items-center space-x-2">
                <i data-lucide="files" class="w-4 h-4 text-[#a3a3a3]" aria-hidden="true"></i>
                <h3 class="text-xs font-bold text-white uppercase tracking-wider">${hasSubfolders ? 'Файлы без подпапки' : 'Файлы предмета'}</h3>
                <span class="px-2 py-0.5 rounded text-[11px] font-mono text-[#a3a3a3] bg-[#161616] border border-[#262626]">${rootFiles.length}</span>
              </div>
            </div>
            ${viewMode === "grid" 
              ? `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3.5">${rootFiles.map(file => renderFileCard(file)).join("")}</div>`
              : `<div class="bg-[#121212] border border-[#222222] rounded-xl overflow-hidden divide-y divide-[#1e1e1e]">${rootFiles.map(file => renderFileRow(file)).join("")}</div>`
            }
          </div>
        `;
      } else if (hasSubfolders) {
        html += `
          <div class="p-5 text-center border border-dashed border-[#242424] rounded-xl bg-[#121212]/50 mt-2">
            <p class="text-xs text-[#a3a3a3]">В корне предмета нет отдельных файлов — все материалы распределены по папкам выше.</p>
            <button onclick="triggerFileInput()" class="mt-2.5 px-3.5 py-1.5 btn-tactile-secondary text-xs text-[#cccccc] hover:text-white rounded-lg inline-flex items-center space-x-1.5 font-medium">
              <i data-lucide="upload" class="w-3.5 h-3.5" aria-hidden="true"></i>
              <span>Загрузить файл в корень</span>
            </button>
          </div>
        `;
      }

      container.innerHTML = html;
      initIcons(container);
      return;
    }

    // CASE 3: "ALL" View
    let filtered = [...filesDb];
    if (searchQuery) {
      filtered = filtered.filter(f => f.name.toLowerCase().includes(searchQuery));
    }
    filtered = sortFileList(filtered);

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="py-16 px-4 text-center border-2 border-dashed border-[#222222] rounded-2xl bg-[#101010]/60">
          <div class="w-16 h-16 mx-auto rounded-2xl bg-[#161616] border border-[#242424] text-[#a3a3a3] flex items-center justify-center mb-4">
            <i data-lucide="folder-open" class="w-8 h-8 text-[#f87171]" aria-hidden="true"></i>
          </div>
          <h3 class="text-sm font-bold text-white uppercase tracking-wider">Файлов пока нет</h3>
          <p class="text-xs text-[#a3a3a3] mt-1 max-w-sm mx-auto leading-relaxed">
            ${searchQuery ? 'Ничего не найдено по вашему поисковому запросу.' : 'Здесь пока пусто. Нажмите кнопку «Загрузить» или просто перетащите файлы на диск.'}
          </p>
          ${!searchQuery ? `
            <button 
              onclick="triggerFileInput()" 
              class="mt-4 px-4 py-2.5 btn-tactile-primary text-white rounded-xl text-xs font-bold uppercase tracking-wider inline-flex items-center space-x-1.5"
            >
              <i data-lucide="upload" class="w-3.5 h-3.5" aria-hidden="true"></i>
              <span>Загрузить первый файл</span>
            </button>
          ` : ''}
        </div>
      `;
      initIcons(container);
      return;
    }

    if (viewMode === "grid") {
      container.innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3.5">
          ${filtered.map(file => renderFileCard(file)).join("")}
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="bg-[#121212] border border-[#222222] rounded-xl overflow-hidden divide-y divide-[#1e1e1e]">
          ${filtered.map(file => renderFileRow(file)).join("")}
        </div>
      `;
    }

    initIcons(container);
  }

  function getFileMeta(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    
    if (['doc', 'docx'].includes(ext)) {
      return { type: 'DOCX', badge: 'bg-blue-500/10 text-blue-400 border-blue-500/30', icon: 'file-text' };
    }
    if (['pdf'].includes(ext)) {
      return { type: 'PDF', badge: 'bg-rose-500/10 text-rose-400 border-rose-500/30', icon: 'file-text' };
    }
    if (['xls', 'xlsx', 'csv'].includes(ext)) {
      return { type: 'TABLE', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', icon: 'table' };
    }
    if (['ppt', 'pptx'].includes(ext)) {
      return { type: 'SLIDES', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30', icon: 'presentation' };
    }
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
      return { type: 'ARCHIVE', badge: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30', icon: 'archive' };
    }
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) {
      return { type: 'IMAGE', badge: 'bg-purple-500/10 text-purple-400 border-purple-500/30', icon: 'image' };
    }
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) {
      return { type: 'AUDIO', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30', icon: 'headphones' };
    }
    if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) {
      return { type: 'VIDEO', badge: 'bg-pink-500/10 text-pink-400 border-pink-500/30', icon: 'video' };
    }
    if (['py', 'js', 'html', 'css', 'cs', 'cpp', 'java', 'json', 'sql', 'md', 'ts'].includes(ext)) {
      return { type: 'CODE', badge: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30', icon: 'code' };
    }
    return { type: 'FILE', badge: 'bg-[#181818] text-[#cccccc] border-[#292929]', icon: 'file' };
  }

  function renderFileCard(file) {
    const meta = getFileMeta(file.name);
    const folder = foldersDb.find(f => f.id === file.folderId);
    const subjectName = folder ? folder.name : "Общие";
    const sub = file.subfolderId && folder?.subfolders ? folder.subfolders.find(s => s.id === file.subfolderId) : null;
    const subfolderName = sub ? sub.name : "";
    const safeId = escapeHtml(file.id);

    return `
      <div class="vault-card rounded-xl p-4 flex flex-col justify-between space-y-3 shadow-sm group">
        
        <!-- Top info -->
        <div class="flex items-start justify-between gap-2.5">
          <div class="flex items-center space-x-3 min-w-0 flex-1">
            <div class="w-10 h-10 rounded-lg border flex items-center justify-center font-bold text-xs flex-shrink-0 ${meta.badge}">
              <i data-lucide="${meta.icon}" class="w-5 h-5" aria-hidden="true"></i>
            </div>
            <div class="min-w-0 flex-1">
              <h3 
                tabindex="0"
                role="button"
                aria-label="Предпросмотр файла ${escapeHtml(file.name)}"
                class="text-xs font-bold text-white truncate group-hover:text-[#f87171] focus:text-[#f87171] focus:outline-none transition-colors cursor-pointer"
                onclick="openPreview('${safeId}')"
                onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); openPreview('${safeId}');}"
                title="${escapeHtml(file.name)}"
              >
                ${escapeHtml(file.name)}
              </h3>
              <span class="text-[10px] text-[#a3a3a3] flex items-center space-x-1 mt-0.5 min-w-0">
                <i data-lucide="folder" class="w-3 h-3 text-[#a3a3a3] flex-shrink-0" aria-hidden="true"></i>
                <span class="truncate block min-w-0">${escapeHtml(subjectName)}${subfolderName ? ' › ' + escapeHtml(subfolderName) : ''}</span>
              </span>
            </div>
          </div>
        </div>

        <!-- Bottom Meta & Actions -->
        <div class="pt-2.5 border-t border-[#1e1e1e] flex items-center justify-between text-[11px] text-[#a3a3a3]">
          <span class="font-mono text-[#a3a3a3]">${escapeHtml(file.sizeText || '0 КБ')}</span>
          
          <div class="flex items-center space-x-1">
            <button 
              onclick="openPreview('${safeId}')"
              title="Предпросмотр файла"
              aria-label="Предпросмотр файла ${escapeHtml(file.name)}"
              class="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center text-[#a3a3a3] hover:text-[#f87171] hover:bg-[#850000]/15 rounded-lg transition-all"
            >
              <i data-lucide="eye" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button 
              onclick="openMoveFileModal('${safeId}')"
              title="Переместить в другую папку"
              aria-label="Переместить файл ${escapeHtml(file.name)}"
              class="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center text-[#a3a3a3] hover:text-amber-400 hover:bg-amber-500/15 rounded-lg transition-all"
            >
              <i data-lucide="folder-input" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button 
              onclick="downloadFile('${safeId}')"
              title="Скачать файл"
              aria-label="Скачать файл ${escapeHtml(file.name)}"
              class="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center text-[#a3a3a3] hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-all"
            >
              <i data-lucide="download" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button 
              onclick="deleteFile('${safeId}')"
              title="Удалить файл"
              aria-label="Удалить файл ${escapeHtml(file.name)}"
              class="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center text-[#a3a3a3] hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all"
            >
              <i data-lucide="trash-2" class="w-4 h-4" aria-hidden="true"></i>
            </button>
          </div>
        </div>

      </div>
    `;
  }

  function renderFileRow(file) {
    const meta = getFileMeta(file.name);
    const folder = foldersDb.find(f => f.id === file.folderId);
    const subjectName = folder ? folder.name : "Общие";
    const sub = file.subfolderId && folder?.subfolders ? folder.subfolders.find(s => s.id === file.subfolderId) : null;
    const subfolderName = sub ? sub.name : "";
    const safeId = escapeHtml(file.id);

    return `
      <div class="p-3.5 flex items-center justify-between hover:bg-[#161616] transition-all text-xs gap-3">
        <div class="flex items-center space-x-3 min-w-0 flex-1">
          <div class="w-8 h-8 rounded-lg border flex items-center justify-center font-bold text-xs flex-shrink-0 ${meta.badge}">
            <i data-lucide="${meta.icon}" class="w-4 h-4" aria-hidden="true"></i>
          </div>
          <div class="min-w-0 flex-1">
            <h3 
              tabindex="0"
              role="button"
              aria-label="Предпросмотр файла ${escapeHtml(file.name)}"
              class="font-semibold text-white truncate cursor-pointer hover:text-[#f87171] focus:text-[#f87171] focus:outline-none transition-colors"
              onclick="openPreview('${safeId}')"
              onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); openPreview('${safeId}');}"
              title="${escapeHtml(file.name)}"
            >
              ${escapeHtml(file.name)}
            </h3>
            <p class="text-[10px] text-[#a3a3a3] mt-0.5 truncate flex items-center space-x-1">
              <i data-lucide="folder" class="w-3 h-3 text-[#a3a3a3] flex-shrink-0" aria-hidden="true"></i>
              <span class="truncate">${escapeHtml(subjectName)}${subfolderName ? ' › ' + escapeHtml(subfolderName) : ''}</span>
            </p>
          </div>
        </div>

        <div class="flex items-center space-x-3 sm:space-x-4 flex-shrink-0 text-[#a3a3a3]">
          <span class="font-mono text-[11px]">${escapeHtml(file.sizeText || '')}</span>
          <span class="text-[11px] hidden sm:inline">${escapeHtml(file.uploadedAt || '')}</span>
          
          <div class="flex items-center space-x-1">
            <button 
              onclick="openPreview('${safeId}')"
              title="Предпросмотр файла"
              aria-label="Предпросмотр ${escapeHtml(file.name)}"
              class="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center text-[#a3a3a3] hover:text-[#f87171] hover:bg-[#850000]/15 rounded-lg transition-all"
            >
              <i data-lucide="eye" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button 
              onclick="openMoveFileModal('${safeId}')"
              title="Переместить в другую папку"
              aria-label="Переместить ${escapeHtml(file.name)}"
              class="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center text-[#a3a3a3] hover:text-amber-400 hover:bg-amber-500/15 rounded-lg transition-all"
            >
              <i data-lucide="folder-input" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button 
              onclick="downloadFile('${safeId}')"
              title="Скачать файл"
              aria-label="Скачать ${escapeHtml(file.name)}"
              class="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center text-[#a3a3a3] hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-all"
            >
              <i data-lucide="download" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button 
              onclick="deleteFile('${safeId}')"
              title="Удалить файл"
              aria-label="Удалить ${escapeHtml(file.name)}"
              class="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center text-[#a3a3a3] hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all"
            >
              <i data-lucide="trash-2" class="w-4 h-4" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function formatFilesCount(count) {
    const n = Math.abs(count) % 100;
    const n1 = n % 10;
    let word = "файлов";
    if (n > 10 && n < 20) word = "файлов";
    else if (n1 > 1 && n1 < 5) word = "файла";
    else if (n1 === 1) word = "файл";
    return `${count} ${word}`;
  }

  function updateStorageMetrics() {
    const totalBytes = filesDb.reduce((acc, f) => acc + (f.size || 0), 0);
    const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
    const percent = Math.min(100, ((totalMb / MAX_STORAGE_MB) * 100)).toFixed(1);

    const usageText = document.getElementById("storageUsageText");
    const percentText = document.getElementById("storagePercentText");
    const progressBar = document.getElementById("storageProgressBar");
    const totalFilesText = document.getElementById("filesCountTotal");

    if (usageText) usageText.innerText = `${totalMb} МБ / 1 000 МБ`;
    if (percentText) percentText.innerText = `${percent}%`;
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (totalFilesText) totalFilesText.innerText = formatFilesCount(filesDb.length);
  }

  // ================= UPLOAD LOGIC =================
  function triggerFileInput() {
    document.getElementById("filePickerInput")?.click();
  }

  function setupDragAndDrop() {
    const dropZone = document.getElementById("dropZone");
    if (!dropZone) return;

    ['dragenter', 'dragover'].forEach(name => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add("border-[#ef4444]", "bg-[#850000]/10");
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove("border-[#ef4444]", "bg-[#850000]/10");
      });
    });

    dropZone.addEventListener("drop", (e) => {
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleFilesForUpload(files);
      }
    });
  }

  function handleFileInputChange(e) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    if (files.length > 0) {
      handleFilesForUpload(files);
    }
  }

  function handleFilesForUpload(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;

    if (currentSubjectId !== "ALL" && currentSubfolderId) {
      executeUploadFilesList(files, currentSubjectId, currentSubfolderId);
      return;
    }

    if (currentSubjectId !== "ALL") {
      const folder = foldersDb.find(f => f.id === currentSubjectId);
      if (folder && folder.subfolders && folder.subfolders.length > 0) {
        openSelectUploadSubjectModal(files, currentSubjectId);
        return;
      }
      executeUploadFilesList(files, currentSubjectId, null);
      return;
    }

    if (foldersDb.length > 0) {
      openSelectUploadSubjectModal(files, null);
    } else {
      const fallbackId = (foldersDb[0] && foldersDb[0].id) || "subj_applied_dev";
      executeUploadFilesList(files, fallbackId, null);
    }
  }

  function openSelectUploadSubjectModal(fileList, preselectedSubjectId = null) {
    pendingUploadFiles = Array.from(fileList);
    const modal = document.getElementById("selectUploadSubjectModal");
    const listContainer = document.getElementById("uploadSubjectOptionsList");
    if (!modal || !listContainer) {
      const targetId = preselectedSubjectId || (foldersDb[0] && foldersDb[0].id) || "subj_applied_dev";
      executeUploadFilesList(fileList, targetId, null);
      return;
    }

    let targetSubjects = foldersDb;
    if (preselectedSubjectId) {
      targetSubjects = foldersDb.filter(f => f.id === preselectedSubjectId);
    }

    let html = "";
    targetSubjects.forEach((folder, idx) => {
      const isDefault = idx === 0;
      const folderSafeId = escapeHtml(folder.id);

      html += `
        <div class="p-2.5 rounded-xl bg-[#161616] border border-[#262626] space-y-1.5">
          <label class="flex items-center space-x-2.5 cursor-pointer">
            <input type="radio" name="uploadTargetRadio" value="${folderSafeId}:ROOT" ${isDefault ? 'checked' : ''} class="text-[#ef4444] focus:ring-0">
            <i data-lucide="folder" class="w-4 h-4 text-amber-500/80" aria-hidden="true"></i>
            <span class="text-xs font-bold text-white truncate">${escapeHtml(folder.name)} (Корень)</span>
          </label>
      `;

      if (folder.subfolders && folder.subfolders.length > 0) {
        html += `<div class="ml-6 space-y-1 border-l border-[#262626] pl-2.5">`;
        folder.subfolders.forEach(sub => {
          html += `
            <label class="flex items-center space-x-2.5 cursor-pointer py-1 text-[#a3a3a3] hover:text-white transition-colors">
              <input type="radio" name="uploadTargetRadio" value="${folderSafeId}:${escapeHtml(sub.id)}" class="text-[#ef4444] focus:ring-0">
              <i data-lucide="corner-down-right" class="w-3.5 h-3.5 text-[#ef4444]" aria-hidden="true"></i>
              <span class="text-xs truncate">${escapeHtml(sub.name)}</span>
            </label>
          `;
        });
        html += `</div>`;
      }

      html += `</div>`;
    });

    listContainer.innerHTML = html;
    modal.classList.remove("hidden");
    trapFocus(modal);
    initIcons(modal);
  }

  function closeSelectUploadSubjectModal() {
    releaseFocus();
    document.getElementById("selectUploadSubjectModal")?.classList.add("hidden");
    pendingUploadFiles = null;
  }

  function confirmUploadWithSelectedSubject() {
    const radios = document.getElementsByName("uploadTargetRadio");
    let selectedVal = null;
    for (const r of radios) {
      if (r.checked) {
        selectedVal = r.value;
        break;
      }
    }

    if (!selectedVal && foldersDb.length > 0) {
      selectedVal = `${foldersDb[0].id}:ROOT`;
    }

    const files = pendingUploadFiles ? Array.from(pendingUploadFiles) : [];
    closeSelectUploadSubjectModal();

    if (files && files.length > 0 && selectedVal) {
      const [targetFolderId, targetSubId] = selectedVal.split(":");
      const finalSubId = targetSubId === "ROOT" ? null : targetSubId;
      executeUploadFilesList(files, targetFolderId, finalSubId);
    }
  }

  async function executeUploadFilesList(fileList, targetFolderId, targetSubfolderId = null) {
    if (!fileList || fileList.length === 0) return;

    const currentFolder = foldersDb.find(f => f.id === targetFolderId);
    let targetFolderName = currentFolder ? currentFolder.name : "Общие";
    if (targetSubfolderId && currentFolder?.subfolders) {
      const sub = currentFolder.subfolders.find(s => s.id === targetSubfolderId);
      if (sub) targetFolderName += ` › ${sub.name}`;
    }

    let currentTotalBytes = filesDb.reduce((acc, f) => acc + (f.size || 0), 0);
    const maxStorageBytes = MAX_STORAGE_MB * 1024 * 1024;

    const banner = document.getElementById("uploadProgressBanner");
    const progressText = document.getElementById("uploadProgressText");
    const progressBar = document.getElementById("uploadProgressBar");
    const progressPercent = document.getElementById("uploadProgressPercent");

    if (banner) banner.classList.remove("hidden");

    const filesArray = Array.from(fileList);
    const totalCount = filesArray.length;
    let successCount = 0;

    for (let i = 0; i < totalCount; i++) {
      const file = filesArray[i];
      const pct = Math.round(((i + 1) / totalCount) * 100);

      if (progressText) {
        progressText.innerHTML = `<span class="animate-spin text-[#f87171]" aria-hidden="true">⏳</span><span>Загрузка в «${escapeHtml(targetFolderName)}»: ${escapeHtml(file.name)} (${i + 1}/${totalCount})...</span>`;
      }
      if (progressBar) progressBar.style.width = `${pct}%`;
      if (progressPercent) progressPercent.innerText = `${pct}%`;

      if (currentTotalBytes + file.size > maxStorageBytes) {
        showToast(`Превышена квота диска (1 000 МБ)! Пропущен «${file.name}»`, "error");
        await customAlert({
          title: "Память диска заполнена",
          message: `Файл «${file.name}» не может быть загружен: достигнут общий лимит хранилища в 1 000 МБ.\n\nПожалуйста, удалите ненужные файлы для освобождения места.`,
          type: "warning",
          confirmText: "Понятно"
        });
        continue;
      }

      const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE_BYTES) {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        showToast(`Файл «${file.name}» (${mb} МБ) превышает лимит 50 МБ!`, "error");
        await customAlert({
          title: "Превышен лимит размера файла",
          message: `Файл «${file.name}» весит ${mb} МБ.\n\nВ облаке установлен лимит: до 50 МБ на один файл.\n\nРекомендация:\n• Разбейте файл на части через архиватор (ZIP по 45 МБ).\n• Либо сожмите файл перед загрузкой.`,
          type: "warning",
          confirmText: "Понятно"
        });
        continue;
      }

      // Safe robust extension parsing: handles Cyrillic & no-extension files gracefully
      const lastDot = file.name.lastIndexOf('.');
      const rawExt = lastDot > 0 ? file.name.slice(lastDot + 1) : '';
      const cleanExt = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '');
      const ext = cleanExt || 'bin';
      const fileId = "f_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const storageKey = `files/${fileId}.${ext}`;

      try {
        await StorageService.upload(storageKey, file);

        const pubUrl = StorageService.getPublicUrl(storageKey);
        const sizeBytes = file.size || 0;
        let sizeText = (sizeBytes / 1024).toFixed(1) + " КБ";
        if (sizeBytes > 1024 * 1024) {
          sizeText = (sizeBytes / (1024 * 1024)).toFixed(1) + " МБ";
        }

        const fileEntry = {
          id: fileId,
          name: file.name,
          folderId: targetFolderId,
          subfolderId: targetSubfolderId || null,
          size: sizeBytes,
          sizeText: sizeText,
          storageKey: storageKey,
          url: pubUrl,
          uploadedAt: new Date().toLocaleDateString("ru-RU") + " " + new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        };

        currentTotalBytes += sizeBytes;
        filesDb.unshift(fileEntry);
        successCount++;
        // Immediately persist index after each file so partial uploads are never orphaned/lost
        await saveFilesToCloud();
      } catch (err) {
        console.error("Upload failed for file:", file.name, err);
        const isSizeLimit = err.message && (err.message.includes("413") || err.message.includes("Payload too large") || err.message.includes("EntityTooLarge"));
        if (isSizeLimit) {
          showToast(`Файл «${file.name}» превышает лимит хранилища (50 МБ)`, "error");
          await customAlert({
            title: "Превышен лимит облака",
            message: `Не удалось загрузить «${file.name}»: файл превышает максимальный лимит хранилища (50 МБ на файл).`,
            type: "error",
            confirmText: "Закрыть"
          });
        } else {
          showToast(`Ошибка загрузки: ${file.name}`, "error");
        }
      }
    }

    await saveFilesToCloud();

    if (banner) {
      if (progressText) {
        progressText.innerHTML = `<span>Готово! Загружено в «${escapeHtml(targetFolderName)}»: ${successCount} из ${totalCount} файлов.</span>`;
      }
      setTimeout(() => {
        banner.classList.add("hidden");
      }, 2200);
    }

    renderSubjectsNav();
    renderFiles();
    showToast(`Загружено в «${targetFolderName}»: ${formatFilesCount(successCount)}`, "success");
  }

  // ================= DOWNLOAD & ZIP (WITH BATCH CONCURRENCY) =================
  async function downloadFile(fileId) {
    const file = filesDb.find(f => f.id === fileId);
    if (!file || !file.url) return;

    showToast(`Скачивание: ${file.name}...`, "info");

    const downloadUrl = file.url.includes("?") 
      ? `${file.url}&download=${encodeURIComponent(file.name)}`
      : `${file.url}?download=${encodeURIComponent(file.name)}`;

    try {
      const resp = await fetch(downloadUrl);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const blob = await resp.blob();

      if (window.saveAs) {
        window.saveAs(blob, file.name);
      } else {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      }
    } catch (err) {
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = file.name;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  async function downloadCurrentSubjectZip() {
    if (currentSubjectId === "ALL") {
      showToast("Скачивание всех файлов сразу отключено. Выберите конкретный предмет для скачивания архива.", "warning");
      return;
    }

    let targetFiles = filesDb.filter(f => f.folderId === currentSubjectId);
    const folder = foldersDb.find(f => f.id === currentSubjectId);
    let zipName = "Архив.zip";

    if (currentSubfolderId) {
      targetFiles = targetFiles.filter(f => f.subfolderId === currentSubfolderId);
      const sub = folder?.subfolders?.find(s => s.id === currentSubfolderId);
      const safeSubName = sub ? sub.name.replace(/[^\w\s\u0400-\u04FF-]/g, "_") : "Папка";
      zipName = `${safeSubName}.zip`;
    } else {
      const safeSubjName = folder ? folder.name.replace(/[^\w\s\u0400-\u04FF-]/g, "_") : "Предмет";
      zipName = `${safeSubjName}.zip`;
    }

    if (targetFiles.length === 0) {
      showToast("В этой папке нет файлов для создания архива", "error");
      return;
    }

    const totalZipBytes = targetFiles.reduce((acc, f) => acc + (f.size || 0), 0);
    if (totalZipBytes > 150 * 1024 * 1024) {
      const mb = (totalZipBytes / (1024 * 1024)).toFixed(0);
      const ok = await customConfirm({
        title: "Большой размер архива",
        message: `Общий размер файлов для создания ZIP составляет ${mb} МБ.\n\nАрхивация в браузере может занять некоторое время и задействовать память устройства. Продолжить?`,
        type: "warning",
        confirmText: "Да, создать архив",
        cancelText: "Отмена"
      });
      if (!ok) return;
    }

    const btn = document.getElementById("btnDownloadZip");
    const btnText = document.getElementById("btnDownloadZipText");
    const origHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
    }

    // Lazy load JSZip and FileSaver on demand
    if (typeof JSZip === "undefined" || !window.saveAs) {
      if (btnText) btnText.innerText = "Загрузка архиватора...";
      try {
        await Promise.all([
          loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"),
          loadScript("https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js")
        ]);
      } catch (err) {
        showToast("Не удалось загрузить модуль архивации", "error");
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = origHtml;
          initIcons(btn);
        }
        return;
      }
    }

    try {
      const zip = new JSZip();
      const nameOccurrences = new Map();
      let completedCount = 0;
      const totalCount = targetFiles.length;

      // Parallel download worker pool (concurrency: 4)
      const CONCURRENCY = 4;
      let currentIndex = 0;

      async function worker() {
        while (currentIndex < totalCount) {
          const idx = currentIndex++;
          const f = targetFiles[idx];
          if (!f.url) continue;

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            const resp = await fetch(f.url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (resp.ok) {
              const blob = await resp.blob();
              let archiveFileName = f.name;
              const count = nameOccurrences.get(archiveFileName) || 0;
              nameOccurrences.set(archiveFileName, count + 1);

              if (count > 0) {
                const dotIdx = archiveFileName.lastIndexOf(".");
                if (dotIdx > 0) {
                  archiveFileName = `${archiveFileName.slice(0, dotIdx)} (${count})${archiveFileName.slice(dotIdx)}`;
                } else {
                  archiveFileName = `${archiveFileName} (${count})`;
                }
              }

              if (!currentSubfolderId && f.subfolderId) {
                const fileSub = folder?.subfolders?.find(s => s.id === f.subfolderId);
                if (fileSub) {
                  const safeSubDir = fileSub.name.replace(/[^\w\s\u0400-\u04FF-]/g, "_");
                  zip.folder(safeSubDir).file(archiveFileName, blob);
                } else {
                  zip.file(archiveFileName, blob);
                }
              } else {
                zip.file(archiveFileName, blob);
              }
            }
          } catch (e) {
            console.warn("Could not fetch file for zip:", f.name, e);
          } finally {
            completedCount++;
            if (btnText) {
              btnText.innerText = `Сжатие (${completedCount}/${totalCount})...`;
            }
          }
        }
      }

      const workers = [];
      for (let w = 0; w < Math.min(CONCURRENCY, totalCount); w++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (btnText) {
        btnText.innerText = "Формирование ZIP...";
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      if (window.saveAs) {
        window.saveAs(zipBlob, zipName);
      } else {
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = zipName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      showToast(`Архив «${zipName}» успешно сформирован!`, "success");
    } catch (err) {
      showToast("Ошибка создания архива: " + err.message, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        initIcons();
      }
    }
  }

  // ================= DELETE FILE =================
  async function deleteFile(fileId) {
    const file = filesDb.find(f => f.id === fileId);
    if (!file) return;

    const confirmed = await customConfirm({
      title: "Удаление файла",
      message: `Вы действительно хотите безвозвратно удалить файл «${file.name}» из хранилища?`,
      type: "warning",
      confirmText: "Да, удалить",
      cancelText: "Отмена"
    });
    if (!confirmed) return;

    if (file.storageKey) {
      const removed = await StorageService.remove([file.storageKey]);
      if (!removed) {
        showToast("Не удалось удалить файл из облачного бакета", "error");
        return;
      }
    }

    filesDb = filesDb.filter(f => f.id !== fileId);
    await saveFilesToCloud();

    renderSubjectsNav();
    renderFiles();
    showToast(`Файл «${file.name}» удалён`, "info");
  }

  // ================= FILE PREVIEW & SANITIZATION =================
  function sanitizeHtml(dirtyHtml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(dirtyHtml || "", "text/html");

    const allowedTags = new Set([
      "p", "span", "div", "h1", "h2", "h3", "h4", "h5", "h6",
      "b", "strong", "i", "em", "u", "s", "strike", "small", "sub", "sup",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
      "ul", "ol", "li", "dl", "dt", "dd",
      "blockquote", "pre", "code", "br", "hr", "img"
    ]);

    const allowedAttrs = new Set(["class", "style", "title", "alt", "src", "width", "height", "colspan", "rowspan"]);

    function cleanNode(node) {
      if (node.nodeType === 3) return; // Text node
      if (node.nodeType !== 1) {
        node.remove();
        return;
      }

      const tagName = node.tagName.toLowerCase();
      if (!allowedTags.has(tagName)) {
        if (["script", "iframe", "object", "embed", "svg", "math", "details", "summary", "style", "link", "meta", "base", "form", "input", "button", "textarea", "select"].includes(tagName)) {
          node.remove();
          return;
        } else {
          while (node.firstChild) {
            node.parentNode.insertBefore(node.firstChild, node);
          }
          node.remove();
          return;
        }
      }

      // Filter attributes
      Array.from(node.attributes).forEach(attr => {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();

        if (!allowedAttrs.has(name) || name.startsWith("on")) {
          node.removeAttribute(attr.name);
          return;
        }

        if (name === "src") {
          if (!/^https?:\/\/|^blob:|^data:image\/(png|jpe?g|gif|webp);base64,/i.test(val)) {
            node.removeAttribute(attr.name);
          }
        }

        if (name === "style") {
          if (/expression|javascript:|behavior|binding|-moz-binding/i.test(val)) {
            node.removeAttribute(attr.name);
          }
        }
      });

      Array.from(node.childNodes).forEach(child => cleanNode(child));
    }

    Array.from(doc.body.childNodes).forEach(child => cleanNode(child));
    return doc.body.innerHTML;
  }

  async function openPreview(fileId) {
    const file = filesDb.find(f => f.id === fileId);
    if (!file) return;

    const modal = document.getElementById("previewModal");
    const fileNameEl = document.getElementById("previewFileName");
    const fileInfoEl = document.getElementById("previewFileInfo");
    const bodyEl = document.getElementById("previewBody");
    const dlBtn = document.getElementById("previewDownloadBtn");
    const previewIconEl = document.getElementById("previewIcon");

    if (!modal || !fileNameEl || !bodyEl) return;

    const meta = getFileMeta(file.name);
    fileNameEl.innerText = file.name;
    const folder = foldersDb.find(f => f.id === file.folderId);
    fileInfoEl.innerText = `${file.sizeText || ''} • ${folder ? folder.name : 'Раздел'}`;

    if (previewIconEl) {
      previewIconEl.className = `w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${meta.badge}`;
      previewIconEl.innerHTML = `<i data-lucide="${meta.icon}" class="w-4 h-4" aria-hidden="true"></i>`;
    }

    if (dlBtn) {
      dlBtn.onclick = () => downloadFile(file.id);
    }

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    bodyEl.innerHTML = `<div class="text-xs text-[#a3a3a3] flex items-center space-x-2"><span class="animate-spin text-[#f87171]" aria-hidden="true">⏳</span><span>Загрузка предпросмотра...</span></div>`;

    modal.classList.remove("hidden");
    trapFocus(modal);
    initIcons();

    try {
      // 1. IMAGES
      if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) {
        bodyEl.innerHTML = `
          <div class="max-h-[75vh] flex items-center justify-center p-2">
            <img src="${file.url}" alt="${escapeHtml(file.name)}" class="max-h-[70vh] max-w-full rounded-xl object-contain shadow-2xl" />
          </div>
        `;
        return;
      }

      // 2. VIDEO (WITH PLAYINLINE FOR IOS SAFARI)
      if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) {
        bodyEl.innerHTML = `
          <div class="w-full max-w-3xl flex flex-col items-center space-y-3">
            <div class="w-full rounded-xl overflow-hidden bg-black shadow-2xl">
              <video src="${file.url}" controls playsinline webkit-playsinline class="w-full max-h-[68vh]"></video>
            </div>
            <p class="text-center text-[11px] text-[#a3a3a3]">
              Если видео не воспроизводится в вашем браузере, 
              <a href="${file.url}?download=${encodeURIComponent(file.name)}" class="underline text-[#f87171] hover:text-white transition-colors">скачайте файл напрямую</a>.
            </p>
          </div>
        `;
        return;
      }

      // 3. AUDIO (NATIVE HTML5 PLAYER)
      if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) {
        bodyEl.innerHTML = `
          <div class="w-full max-w-lg p-6 bg-[#141414] border border-[#262626] rounded-2xl flex flex-col items-center space-y-4 shadow-xl">
            <div class="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center shadow-lg">
              <i data-lucide="headphones" class="w-8 h-8" aria-hidden="true"></i>
            </div>
            <div class="text-center">
              <h4 class="text-sm font-bold text-white">${escapeHtml(file.name)}</h4>
              <p class="text-xs text-[#a3a3a3] mt-1">Аудиозапись лекции / материала</p>
            </div>
            <audio src="${file.url}" controls class="w-full mt-2 focus:outline-none" preload="metadata"></audio>
            <div class="pt-2 text-center">
              <a href="${file.url}?download=${encodeURIComponent(file.name)}" class="text-xs text-[#f87171] hover:text-white underline transition-colors">
                Скачать аудиофайл напрямую
              </a>
            </div>
          </div>
        `;
        initIcons(bodyEl);
        return;
      }

      // 4. PDF
      if (ext === 'pdf') {
        bodyEl.innerHTML = `
          <div class="w-full flex flex-col items-center space-y-2">
            <iframe src="${file.url}" title="Просмотр PDF" class="w-full h-[72vh] rounded-xl border border-[#262626] bg-white"></iframe>
            <div class="flex items-center space-x-3 text-xs text-[#a3a3a3]">
              <a href="${file.url}" target="_blank" rel="noopener noreferrer" class="hover:text-[#f87171] underline flex items-center space-x-1">
                <span>Открыть PDF в новой вкладке</span>
                <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
              </a>
            </div>
          </div>
        `;
        initIcons(bodyEl);
        return;
      }

      // 5. DOCX (WITH LAZY LOADED MAMMOTH)
      if (ext === 'docx') {
        if (typeof mammoth === "undefined") {
          bodyEl.innerHTML = `<div class="text-xs text-[#a3a3a3] flex items-center space-x-2"><span class="animate-spin text-[#f87171]" aria-hidden="true">⏳</span><span>Загрузка модуля документов Word...</span></div>`;
          await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
        }
        const resp = await fetch(file.url);
        const arrayBuffer = await resp.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        const cleanHtml = sanitizeHtml(result.value);

        bodyEl.innerHTML = `
          <div class="w-full max-w-3xl p-6 bg-[#141414] border border-[#262626] rounded-xl text-xs leading-relaxed text-[#eeeeee] overflow-y-auto max-h-[72vh] docx-preview-content prose prose-invert">
            ${cleanHtml}
          </div>
        `;
        return;
      }

      // 5. TEXT / CODE
      if (['txt', 'py', 'js', 'html', 'css', 'json', 'sql', 'md', 'ts', 'csv'].includes(ext)) {
        const resp = await fetch(file.url);
        let text = await resp.text();
        
        let notice = "";
        if (text.length > 50000) {
          text = text.slice(0, 50000);
          notice = `\n\n--- [Файл слишком большой для полного отображения в браузере. Показаны первые 50 000 символов. Скачайте файл для полного просмотра] ---`;
        }

        bodyEl.innerHTML = `
          <pre class="w-full max-w-3xl p-5 bg-[#0a0a0a] border border-[#222222] rounded-xl text-xs font-mono text-emerald-300 overflow-auto max-h-[72vh] leading-relaxed whitespace-pre-wrap"><code>${escapeHtml(text + notice)}</code></pre>
        `;
        return;
      }

      // Fallback
      bodyEl.innerHTML = `
        <div class="text-center py-10 space-y-3">
          <div class="w-14 h-14 mx-auto rounded-xl bg-[#850000]/15 text-[#f87171] border border-[#850000]/30 flex items-center justify-center text-xl">
            <i data-lucide="${meta.icon}" class="w-7 h-7" aria-hidden="true"></i>
          </div>
          <p class="text-xs text-[#cccccc]">Предпросмотр формата .${escapeHtml(ext)} в браузере не поддерживается.</p>
          <button 
            onclick="downloadFile('${safeId}')"
            class="px-4 py-2 btn-tactile-primary text-white rounded-xl text-xs font-bold uppercase tracking-wider inline-flex items-center space-x-1.5"
          >
            <i data-lucide="download" class="w-3.5 h-3.5" aria-hidden="true"></i>
            <span>Скачать файл</span>
          </button>
        </div>
      `;
      initIcons();
    } catch (err) {
      bodyEl.innerHTML = `
        <div class="text-center py-8 text-xs text-rose-400 space-y-2">
          <p>Не удалось отобразить файл: ${escapeHtml(err.message)}</p>
          <button onclick="downloadFile('${safeId}')" class="px-3 py-1.5 btn-tactile-secondary text-[#cccccc] rounded-lg">Скачать файл</button>
        </div>
      `;
    }
  }

  function closePreviewModal() {
    releaseFocus();
    document.getElementById("previewModal")?.classList.add("hidden");
    const bodyEl = document.getElementById("previewBody");
    if (bodyEl) bodyEl.innerHTML = "";
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ================= 8. ACTIVE SESSIONS & DEVICE MANAGEMENT =================

  function detectDeviceInfo() {
    const ua = navigator.userAgent || "";
    let os = "Windows";
    if (/iPhone/i.test(ua)) os = "iOS (iPhone)";
    else if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) os = "iPadOS (Планшет)";
    else if (/Android/i.test(ua)) os = "Android";
    else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
    else if (/Linux/i.test(ua)) os = "Linux";
    else if (/Windows NT 10.0/i.test(ua)) os = "Windows 10/11";

    let browser = "Браузер";
    if (/YaBrowser/i.test(ua)) browser = "Яндекс Браузер";
    else if (navigator.brave && typeof navigator.brave.isBrave === "function") browser = "Brave";
    else if (/Edg\//i.test(ua)) browser = "Microsoft Edge";
    else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = "Opera";
    else if (/Chrome\//i.test(ua)) browser = "Google Chrome";
    else if (/Firefox\//i.test(ua)) browser = "Mozilla Firefox";
    else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = "Safari";

    const isMobile = /Android|iPhone|iPod/i.test(ua);
    const isTablet = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    let typeStr = "ПК / Ноутбук";
    if (isMobile) typeStr = "Смартфон";
    else if (isTablet) typeStr = "Планшет";

    return { os, browser, isMobile, isTablet, typeStr, fullStr: `${os} • ${browser}` };
  }

  function formatTimeAgo(diffMs) {
    if (!diffMs || diffMs < 45000) return "только что";
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 60) return `${minutes} мин. назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч. назад`;
    const days = Math.floor(hours / 24);
    return `${days} дн. назад`;
  }

  function setDeviceRoleUI(role) {
    selectedLoginRole = role;
    const btnCollege = document.getElementById("btnRoleCollege");
    const btnMaster = document.getElementById("btnRoleMaster");
    const badge = document.getElementById("deviceTypeBadge");
    const desc = document.getElementById("deviceRoleDescription");

    if (role === "master") {
      btnMaster?.classList.remove("border-[#282828]", "bg-[#181818]", "text-[#a3a3a3]");
      btnMaster?.classList.add("border-[#850000]/70", "bg-[#850000]/25", "text-white", "shadow-sm");
      btnMaster?.setAttribute("aria-pressed", "true");

      btnCollege?.classList.remove("border-[#850000]/60", "bg-[#850000]/20", "text-white", "shadow-sm");
      btnCollege?.classList.add("border-[#282828]", "bg-[#181818]", "text-[#a3a3a3]");
      btnCollege?.setAttribute("aria-pressed", "false");

      if (badge) {
        badge.innerText = "ВЛАДЕЛЕЦ / МАСТЕР";
        badge.className = "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#850000]/25 text-[#f87171] border border-[#850000]/50";
      }
      if (desc) {
        desc.innerText = "Режим администратора: требует постоянный мастер-код. Позволяет управлять сессиями и удаленно отключать компьютеры в колледже.";
      }
    } else {
      btnCollege?.classList.remove("border-[#282828]", "bg-[#181818]", "text-[#a3a3a3]");
      btnCollege?.classList.add("border-[#850000]/60", "bg-[#850000]/20", "text-white", "shadow-sm");
      btnCollege?.setAttribute("aria-pressed", "true");

      btnMaster?.classList.remove("border-[#850000]/70", "bg-[#850000]/25", "text-white", "shadow-sm");
      btnMaster?.classList.add("border-[#282828]", "bg-[#181818]", "text-[#a3a3a3]");
      btnMaster?.setAttribute("aria-pressed", "false");

      if (badge) {
        badge.innerText = "УЧЕБНЫЙ ПК";
        badge.className = "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#202020] text-[#a3a3a3] border border-[#303030]";
      }
      if (desc) {
        desc.innerText = "Безопасный режим для пар: компьютер в колледже не имеет прав администратора и не может завершить сессию вашего домашнего ПК.";
      }
    }
    initIcons();
  }

  async function isSessionRevokedInCloud(sessionId) {
    if (!sessionId) return false;
    try {
      const db = await StorageService.fetchJson(SESSIONS_STORAGE_PATH);
      if (!db || !Array.isArray(db.sessions)) return false;
      const target = db.sessions.find(s => s.id === sessionId);
      if (target && target.status === "revoked") return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  async function registerCurrentSession() {
    try {
      const now = Date.now();
      if (!currentSessionId) {
        currentSessionId = "sess_" + now.toString(36) + "_" + Math.random().toString(36).substring(2, 7);
        localStorage.setItem("disk_session_id", currentSessionId);
      }

      const devInfo = detectDeviceInfo();
      const sessionObj = {
        id: currentSessionId,
        role: currentDeviceRole,
        name: currentDeviceRole === "master" ? "Основной ПК (Владелец)" : "ПК в аудитории (Колледж)",
        deviceInfo: devInfo.fullStr,
        deviceType: devInfo.typeStr,
        isMobile: devInfo.isMobile || devInfo.isTablet,
        createdAt: now,
        lastActive: now,
        status: "active"
      };

      let db = await StorageService.fetchJson(SESSIONS_STORAGE_PATH);
      if (!db || !Array.isArray(db.sessions)) {
        db = { updatedAt: now, sessions: [] };
      }

      // Cleanup stale sessions: revoked older than 12h, or inactive older than 48h
      const twelveHoursAgo = now - 12 * 60 * 60 * 1000;
      const twoDaysAgo = now - 48 * 60 * 60 * 1000;
      db.sessions = db.sessions.filter(s => {
        if (!s || !s.id) return false;
        if (s.id === currentSessionId) return true;
        if (s.status === "revoked" && (s.lastActive || 0) < twelveHoursAgo) return false;
        if ((s.lastActive || 0) < twoDaysAgo) return false;
        return true;
      });

      const existingIdx = db.sessions.findIndex(s => s.id === currentSessionId);
      if (existingIdx >= 0) {
        db.sessions[existingIdx] = { 
          ...db.sessions[existingIdx], 
          ...sessionObj, 
          createdAt: db.sessions[existingIdx].createdAt || now,
          lastActive: now, 
          status: "active" 
        };
      } else {
        db.sessions.push(sessionObj);
      }

      db.updatedAt = now;
      cachedSessionsList = db.sessions;
      await StorageService.saveJson(SESSIONS_STORAGE_PATH, db);
      updateSessionsUI();
    } catch (e) {
      console.warn("registerCurrentSession note:", e);
    }
  }

  async function checkSessionsStatus() {
    if (!isUnlocked || !currentSessionId) return;

    try {
      const db = await StorageService.fetchJson(SESSIONS_STORAGE_PATH);
      if (!db || !Array.isArray(db.sessions)) return;

      cachedSessionsList = db.sessions;
      const mySession = db.sessions.find(s => s.id === currentSessionId);

      // Kill-switch for college session
      if (currentDeviceRole === "college") {
        if (!mySession || mySession.status === "revoked") {
          await handleRemoteRevocation();
          return;
        }

        // Heartbeat: update lastActive if more than 2 minutes elapsed
        const now = Date.now();
        if (mySession && now - (mySession.lastActive || 0) > 120000) {
          mySession.lastActive = now;
          await StorageService.saveJson(SESSIONS_STORAGE_PATH, db);
        }
      } else if (currentDeviceRole === "master") {
        updateSessionsUI();
        checkAndNotifyWeeklyCodeOnMaster();

        // Check for remote code requests from college
        if (db.lastCodeRequest && db.lastCodeRequest.time) {
          const lastHandledTime = parseInt(localStorage.getItem("disk_last_handled_code_req") || "0", 10);
          const reqTime = db.lastCodeRequest.time;
          if (reqTime > lastHandledTime && (Date.now() - reqTime < 300000)) {
            localStorage.setItem("disk_last_handled_code_req", String(reqTime));
            const reqCode = db.lastCodeRequest.code || getWeeklyCodeInfo().code;
            showToast(`🔔 Запрос из колледжа! Код для входа: ${reqCode}`, "info");

            if ("Notification" in window && Notification.permission === "granted") {
              try {
                new Notification("🔔 Студенческий Диск: Запрос кода из аудитории", {
                  body: `Компьютер в колледже запросил код доступа: ${reqCode}`,
                  tag: "college-code-request"
                });
              } catch (e) {}
            }
          }
        }

        const modal = document.getElementById("devicesModal");
        if (modal && !modal.classList.contains("hidden")) {
          renderDevicesList(db.sessions);
        }
      }
    } catch (e) {
      console.warn("checkSessionsStatus note:", e);
    }
  }

  async function handleRemoteRevocation() {
    localStorage.removeItem("disk_auth_pin");
    localStorage.removeItem("disk_session_id");
    localStorage.removeItem("disk_device_role");
    currentSessionId = "";
    currentDeviceRole = "college";

    handleLock();

    await customAlert({
      title: "Сессия завершена",
      message: "Ваша сессия на этом компьютере была завершена удаленно с основного устройства (ПК дома).\n\nВсе локальные данные и ключи стерты. Доступ к диску заблокирован.",
      type: "warning"
    });
  }

  function updateSessionsUI() {
    const badge = document.getElementById("activeSessionsCountBadge");
    const summary = document.getElementById("devicesStatusSummary");

    const collegeActiveCount = cachedSessionsList.filter(s => s.role === "college" && s.status === "active").length;
    const totalActiveCount = cachedSessionsList.filter(s => s.status === "active").length;

    if (badge) {
      badge.innerText = Math.max(1, totalActiveCount);
    }
    if (summary) {
      if (collegeActiveCount === 0) {
        summary.innerText = "Нет активных сессий в колледже. Только ваш ПК.";
      } else {
        summary.innerHTML = `Активных входов в колледже: <span class="text-amber-400 font-bold">${collegeActiveCount}</span>`;
      }
    }
  }

  async function openDevicesModal() {
    if (currentDeviceRole !== "master") {
      showToast("Управление сессиями доступно только с основного устройства", "warning");
      return;
    }

    const modal = document.getElementById("devicesModal");
    if (!modal) return;

    modal.classList.remove("hidden");
    trapFocus(modal);

    // Update weekly code in modal (masked by default!)
    const { code, nextMonFormatted } = getWeeklyCodeInfo();
    const modalCodeVal = document.getElementById("modalWeeklyCodeValue");
    const modalExpires = document.getElementById("modalWeeklyCodeExpires");
    if (modalCodeVal) modalCodeVal.innerText = isWeeklyCodeRevealed ? code : "••••";
    if (modalExpires) modalExpires.innerText = `До ${nextMonFormatted}`;
    updateNotificationBtnUI();

    initIcons(modal);

    const listContainer = document.getElementById("devicesListContainer");
    if (listContainer) {
      listContainer.innerHTML = `
        <div class="py-8 text-center text-xs text-[#8c8c8c]">
          <i data-lucide="loader-2" class="w-5 h-5 mx-auto animate-spin text-[#f87171] mb-2" aria-hidden="true"></i>
          <span>Загрузка списка подключенных устройств...</span>
        </div>
      `;
      initIcons(listContainer);
    }

    try {
      const db = await StorageService.fetchJson(SESSIONS_STORAGE_PATH);
      if (db && Array.isArray(db.sessions)) {
        cachedSessionsList = db.sessions;
      }
      renderDevicesList(cachedSessionsList);
      updateSessionsUI();
    } catch (e) {
      console.warn("openDevicesModal fetch error:", e);
      renderDevicesList(cachedSessionsList);
    }
  }

  function closeDevicesModal() {
    releaseFocus();
    document.getElementById("devicesModal")?.classList.add("hidden");
  }

  function renderDevicesList(sessions = []) {
    const container = document.getElementById("devicesListContainer");
    if (!container) return;

    if (!sessions || sessions.length === 0) {
      container.innerHTML = `
        <div class="py-8 text-center text-xs text-[#8c8c8c]">
          <i data-lucide="shield-check" class="w-6 h-6 mx-auto text-emerald-400 mb-2" aria-hidden="true"></i>
          <p class="font-bold text-white">Все сессии в безопасности</p>
          <p class="text-[11px] text-[#8c8c8c] mt-0.5">Внешних подключений не обнаружено</p>
        </div>
      `;
      initIcons(container);
      return;
    }

    const now = Date.now();
    const ONLINE_THRESHOLD = 5 * 60 * 1000;

    const currentSession = sessions.find(s => s.id === currentSessionId);
    const otherActiveSessions = sessions.filter(s => s.id !== currentSessionId && s.status === "active");
    const inactiveSessions = sessions.filter(s => s.id !== currentSessionId && s.status !== "active");

    let html = "";

    // 1. THIS PC (CURRENT SESSION)
    if (currentSession) {
      const devIcon = currentSession.isMobile ? "smartphone" : "monitor";
      const createdDateStr = new Date(currentSession.createdAt || now).toLocaleDateString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

      html += `
        <div class="mb-4">
          <div class="text-[10px] font-mono uppercase tracking-wider text-[#a3a3a3] font-bold px-1 mb-1.5 flex items-center justify-between">
            <span>Текущее устройство (Этот сеанс)</span>
            <span class="text-emerald-400 font-bold flex items-center space-x-1">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot-pulse"></span>
              <span>В СЕТИ</span>
            </span>
          </div>
          <div class="p-3.5 sm:p-4 rounded-xl border border-emerald-500/40 bg-gradient-to-r from-[#141a16] to-[#121614] shadow-md flex items-center justify-between gap-3">
            <div class="flex items-center space-x-3.5 min-w-0 flex-1">
              <div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 shadow-sm">
                <i data-lucide="${devIcon}" class="w-5 h-5" aria-hidden="true"></i>
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center space-x-2 flex-wrap">
                  <span class="text-xs font-black text-white truncate">${escapeHtml(currentSession.name || "Основной ПК")}</span>
                  <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">ЭТОТ ПК</span>
                </div>
                <div class="text-[11px] text-[#cccccc] font-medium mt-1 truncate">
                  ${escapeHtml(currentSession.deviceInfo || "Браузер")}
                </div>
                <div class="text-[10px] text-[#8c8c8c] mt-0.5 flex items-center space-x-2">
                  <span>Вход: ${createdDateStr}</span>
                  <span>•</span>
                  <span class="text-emerald-400">Активно прямо сейчас</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // 2. OTHER ACTIVE SESSIONS
    html += `
      <div class="mb-3">
        <div class="text-[10px] font-mono uppercase tracking-wider text-[#a3a3a3] font-bold px-1 mb-1.5 flex items-center justify-between">
          <span>Подключенные устройства колледжа (${otherActiveSessions.length})</span>
          ${otherActiveSessions.length > 0 ? `<span class="text-amber-400 text-[10px] font-mono">Требуют внимания</span>` : ''}
        </div>
    `;

    if (otherActiveSessions.length === 0) {
      html += `
        <div class="p-4 rounded-xl border border-[#222222] bg-[#121212]/60 text-center py-5">
          <p class="text-xs font-semibold text-[#cccccc]">Нет активных сессий в колледже</p>
          <p class="text-[10px] text-[#8c8c8c] mt-0.5">Вход выполнен только с вашего текущего компьютера</p>
        </div>
      `;
    } else {
      html += `<div class="space-y-2">`;
      otherActiveSessions.forEach(s => {
        const isOnline = now - (s.lastActive || 0) < ONLINE_THRESHOLD;
        const timeAgoStr = formatTimeAgo(now - (s.lastActive || s.createdAt || now));
        const createdDateStr = new Date(s.createdAt || now).toLocaleDateString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        const devIcon = s.isMobile ? "smartphone" : "monitor";

        html += `
          <div class="p-3.5 rounded-xl border border-amber-500/30 bg-[#161413] hover:bg-[#1a1715] transition-all flex items-center justify-between gap-3 shadow-sm">
            <div class="flex items-center space-x-3 min-w-0 flex-1">
              <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-amber-500/15 border border-amber-500/30 text-amber-400">
                <i data-lucide="${devIcon}" class="w-4 h-4" aria-hidden="true"></i>
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center space-x-2 flex-wrap">
                  <span class="text-xs font-bold text-white truncate">${escapeHtml(s.name || "ПК в аудитории")}</span>
                  ${isOnline 
                    ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center space-x-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot-pulse"></span><span>В СЕТИ</span></span>`
                    : `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">СЕССИЯ АКТИВНА</span>`}
                </div>
                <div class="text-[11px] text-[#cccccc] font-medium mt-0.5 truncate">
                  ${escapeHtml(s.deviceInfo || "Браузер")}
                </div>
                <div class="text-[10px] text-[#8c8c8c] mt-0.5 flex items-center space-x-2">
                  <span>Вход: ${createdDateStr}</span>
                  <span>•</span>
                  <span>Активность: ${timeAgoStr}</span>
                </div>
              </div>
            </div>
            <div class="flex-shrink-0">
              <button 
                type="button" 
                onclick="revokeSession('${escapeHtml(s.id)}')" 
                class="px-2.5 py-1.5 text-xs font-semibold text-rose-300 hover:text-white bg-rose-950/50 hover:bg-rose-900 border border-rose-800/50 hover:border-rose-600 rounded-lg flex items-center space-x-1.5 transition-all shadow-sm"
                title="Принудительно заблокировать этот компьютер"
              >
                <i data-lucide="power" class="w-3.5 h-3.5 text-rose-400" aria-hidden="true"></i>
                <span>Отключить</span>
              </button>
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }
    html += `</div>`;

    // 3. INACTIVE & REVOKED SESSIONS HISTORY
    if (inactiveSessions.length > 0) {
      html += `
        <div class="mt-4 pt-3 border-t border-[#202020]">
          <div class="text-[10px] font-mono uppercase tracking-wider text-[#8c8c8c] font-bold px-1 mb-2 flex items-center justify-between">
            <span>История завершенных сессий (${inactiveSessions.length})</span>
            <span class="text-[10px] text-[#777777]">Отключенные</span>
          </div>
          <div class="space-y-1.5 max-h-40 overflow-y-auto pr-1">
      `;
      inactiveSessions.forEach(s => {
        const timeAgoStr = formatTimeAgo(now - (s.lastActive || s.createdAt || now));
        const devIcon = s.isMobile ? "smartphone" : "monitor";

        html += `
          <div class="p-2.5 rounded-lg border border-[#222222] bg-[#0e0e0e] opacity-75 hover:opacity-100 transition-opacity flex items-center justify-between gap-2 text-xs">
            <div class="flex items-center space-x-2.5 min-w-0 flex-1">
              <i data-lucide="${devIcon}" class="w-4 h-4 text-[#8c8c8c] flex-shrink-0" aria-hidden="true"></i>
              <div class="min-w-0 flex-1">
                <div class="text-[11px] font-semibold text-[#aaaaaa] truncate">${escapeHtml(s.name || "Устройство")} (${escapeHtml(s.deviceInfo || "Браузер")})</div>
                <div class="text-[10px] text-[#777777] font-mono">Завершено: ${timeAgoStr}</div>
              </div>
            </div>
            <button 
              type="button" 
              onclick="deleteSessionFromHistory('${escapeHtml(s.id)}')" 
              class="p-1.5 text-[#777777] hover:text-rose-400 hover:bg-rose-950/30 rounded-lg transition-colors flex-shrink-0"
              title="Удалить запись из истории"
              aria-label="Удалить запись из истории"
            >
              <i data-lucide="trash-2" class="w-3.5 h-3.5" aria-hidden="true"></i>
            </button>
          </div>
        `;
      });
      html += `
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
    initIcons(container);
  }

  async function clearInactiveSessions() {
    if (currentDeviceRole !== "master") return;
    try {
      let db = await StorageService.fetchJson(SESSIONS_STORAGE_PATH) || { updatedAt: Date.now(), sessions: [] };
      const now = Date.now();
      const cutoff = now - 24 * 60 * 60 * 1000;
      db.sessions = (db.sessions || []).filter(s => {
        if (s.id === currentSessionId) return true;
        if (s.status === "active" && (s.lastActive || 0) > cutoff) return true;
        return false;
      });

      db.updatedAt = now;
      await StorageService.saveJson(SESSIONS_STORAGE_PATH, db);
      cachedSessionsList = db.sessions;
      renderDevicesList(cachedSessionsList);
      updateSessionsUI();
      showToast("История старых сессий очищена", "success");
    } catch (e) {
      console.error("clearInactiveSessions error:", e);
      showToast("Ошибка при очистке истории сессий", "error");
    }
  }

  async function deleteSessionFromHistory(sessionId) {
    if (currentDeviceRole !== "master") return;
    if (sessionId === currentSessionId) {
      showToast("Нельзя удалить текущую сессию", "warning");
      return;
    }
    try {
      let db = await StorageService.fetchJson(SESSIONS_STORAGE_PATH) || { updatedAt: Date.now(), sessions: [] };
      db.sessions = (db.sessions || []).filter(s => s.id !== sessionId);
      db.updatedAt = Date.now();
      await StorageService.saveJson(SESSIONS_STORAGE_PATH, db);
      cachedSessionsList = db.sessions;
      renderDevicesList(cachedSessionsList);
      updateSessionsUI();
      showToast("Запись сессии удалена", "info");
    } catch (e) {
      console.error("deleteSessionFromHistory error:", e);
    }
  }

  async function revokeSession(sessionId) {
    if (currentDeviceRole !== "master") return;
    if (sessionId === currentSessionId) {
      showToast("Нельзя отключить текущую сессию Master-устройства", "warning");
      return;
    }

    const sessionToKill = cachedSessionsList.find(s => s.id === sessionId);
    const sessionName = sessionToKill?.name || "это устройство";

    const confirmed = await customConfirm({
      title: "Завершить сессию?",
      message: `Вы уверены, что хотите завершить сессию «${sessionName}»?\n\nКомпьютер в колледже будет моментально заблокирован, а ключи удалены.`,
      confirmText: "Да, отключить",
      type: "warning"
    });

    if (!confirmed) return;

    try {
      const db = await StorageService.fetchJson(SESSIONS_STORAGE_PATH) || { updatedAt: Date.now(), sessions: [] };
      const target = (db.sessions || []).find(s => s.id === sessionId);
      if (target) {
        target.status = "revoked";
        target.lastActive = Date.now();
        db.updatedAt = Date.now();
        await StorageService.saveJson(SESSIONS_STORAGE_PATH, db);
        cachedSessionsList = db.sessions;
        renderDevicesList(cachedSessionsList);
        updateSessionsUI();
        showToast("Сессия успешно отключена. Компьютер в колледже заблокирован.", "success");
      }
    } catch (e) {
      console.error("revokeSession error:", e);
      showToast("Ошибка при завершении сессии", "error");
    }
  }

  async function revokeAllCollegeSessions() {
    if (currentDeviceRole !== "master") return;

    const collegeActiveCount = cachedSessionsList.filter(s => s.role === "college" && s.status === "active").length;
    if (collegeActiveCount === 0) {
      showToast("Нет активных сессий в колледже", "info");
      return;
    }

    const confirmed = await customConfirm({
      title: "Завершить ВСЕ сессии в колледже?",
      message: `Будет принудительно заблокировано компьютеров: ${collegeActiveCount}.\n\nВсе открытые вкладки в аудиториях потеряют доступ. Ваш домашний ПК продолжит работу без изменений.`,
      confirmText: "Отключить все ПК в колледже",
      type: "warning"
    });

    if (!confirmed) return;

    try {
      const db = await StorageService.fetchJson(SESSIONS_STORAGE_PATH) || { updatedAt: Date.now(), sessions: [] };
      let revokedCount = 0;
      (db.sessions || []).forEach(s => {
        if (s.role === "college" && s.status === "active") {
          s.status = "revoked";
          s.lastActive = Date.now();
          revokedCount++;
        }
      });

      db.updatedAt = Date.now();
      await StorageService.saveJson(SESSIONS_STORAGE_PATH, db);
      cachedSessionsList = db.sessions;
      renderDevicesList(cachedSessionsList);
      updateSessionsUI();
      showToast(`Успешно завершено сессий колледжа: ${revokedCount}`, "success");
    } catch (e) {
      console.error("revokeAllCollegeSessions error:", e);
      showToast("Ошибка при завершении сессий", "error");
    }
  }

  // ================= 9. WEEKLY CODE DELIVERY & INTERACTIVE REVEAL =================

  let isWeeklyCodeRevealed = false;
  let weeklyCodeAutoHideTimer = null;

  function updateWeeklyCodeUIElements() {
    const { code, nextMonFormatted } = getWeeklyCodeInfo();

    // 1. Header Quick Widget
    const headerCodeText = document.getElementById("headerWeeklyCodeText");
    const headerEye = document.getElementById("headerCodeEyeIcon");
    if (headerCodeText) {
      headerCodeText.innerText = isWeeklyCodeRevealed ? code : "••••";
      if (isWeeklyCodeRevealed) {
        headerCodeText.classList.remove("text-[#a3a3a3]");
        headerCodeText.classList.add("text-emerald-400");
      } else {
        headerCodeText.classList.remove("text-emerald-400");
        headerCodeText.classList.add("text-[#a3a3a3]");
      }
    }
    if (headerEye) {
      headerEye.setAttribute("data-lucide", isWeeklyCodeRevealed ? "eye-off" : "eye");
    }

    // 2. Devices Modal card
    const modalCodeVal = document.getElementById("modalWeeklyCodeValue");
    const modalBtnText = document.getElementById("modalCodeRevealBtnText");
    const modalEye = document.getElementById("modalCodeEyeIcon");
    const modalExpires = document.getElementById("modalWeeklyCodeExpires");
    if (modalCodeVal) {
      modalCodeVal.innerText = isWeeklyCodeRevealed ? code : "••••";
      if (isWeeklyCodeRevealed) {
        modalCodeVal.classList.remove("text-[#888888]");
        modalCodeVal.classList.add("text-emerald-300", "border-emerald-500/50");
      } else {
        modalCodeVal.classList.remove("text-emerald-300", "border-emerald-500/50");
        modalCodeVal.classList.add("text-[#888888]", "border-[#850000]/50");
      }
    }
    if (modalBtnText) {
      modalBtnText.innerText = isWeeklyCodeRevealed ? "Скрыть" : "Показать";
    }
    if (modalEye) {
      modalEye.setAttribute("data-lucide", isWeeklyCodeRevealed ? "eye-off" : "eye");
    }
    if (modalExpires) {
      modalExpires.innerText = `До ${nextMonFormatted}`;
    }

    // 3. Dedicated Interactive Reveal Dialog (#weeklyCodeModal)
    for (let i = 0; i < 4; i++) {
      const digitEl = document.getElementById(`revealDigit${i}`);
      if (digitEl) {
        if (isWeeklyCodeRevealed) {
          digitEl.innerText = code[i] || "";
          digitEl.className = "w-11 h-13 flex items-center justify-center font-mono text-2xl font-black bg-[#161616] text-white border border-emerald-500/60 rounded-xl shadow-inner transition-all";
        } else {
          digitEl.innerText = "•";
          digitEl.className = "w-11 h-13 flex items-center justify-center font-mono text-2xl font-black bg-[#161616] text-[#8c8c8c] border border-[#252525] rounded-xl shadow-inner transition-all";
        }
      }
    }

    const revealStatusText = document.getElementById("revealStatusText");
    const revealStatusIcon = document.getElementById("revealStatusIcon");
    const dialogToggleMaskText = document.getElementById("dialogToggleMaskText");
    const dialogEyeIcon = document.getElementById("dialogEyeIcon");
    const revealExpiresText = document.getElementById("revealExpiresText");

    if (revealStatusText) {
      revealStatusText.innerText = isWeeklyCodeRevealed 
        ? "Код открыт (скроется через 30 сек)" 
        : "Скрыто для безопасности";
      revealStatusText.className = isWeeklyCodeRevealed 
        ? "text-emerald-400 font-semibold transition-colors" 
        : "text-[#8c8c8c] group-hover:text-white transition-colors";
    }
    if (revealStatusIcon) {
      revealStatusIcon.setAttribute("data-lucide", isWeeklyCodeRevealed ? "eye-off" : "eye");
      revealStatusIcon.setAttribute("class", isWeeklyCodeRevealed 
        ? "w-3 h-3 text-emerald-400 transition-colors" 
        : "w-3 h-3 text-[#a3a3a3] group-hover:text-[#f87171] transition-colors");
    }
    if (dialogToggleMaskText) {
      dialogToggleMaskText.innerText = isWeeklyCodeRevealed ? "Скрыть код" : "Показать код";
    }
    if (dialogEyeIcon) {
      dialogEyeIcon.setAttribute("data-lucide", isWeeklyCodeRevealed ? "eye-off" : "eye");
    }
    if (revealExpiresText) {
      revealExpiresText.innerText = `Действует до ${nextMonFormatted}`;
    }

    initIcons();
  }

  function toggleWeeklyCodeMask() {
    isWeeklyCodeRevealed = !isWeeklyCodeRevealed;
    if (weeklyCodeAutoHideTimer) {
      clearTimeout(weeklyCodeAutoHideTimer);
      weeklyCodeAutoHideTimer = null;
    }

    if (isWeeklyCodeRevealed) {
      // Auto-hide after 30 seconds for shoulder-surfing & screen-sharing protection
      weeklyCodeAutoHideTimer = setTimeout(() => {
        isWeeklyCodeRevealed = false;
        updateWeeklyCodeUIElements();
      }, 30000);
    }

    updateWeeklyCodeUIElements();
  }

  function openWeeklyCodeModal() {
    if (currentDeviceRole !== "master") return;
    const modal = document.getElementById("weeklyCodeModal");
    if (!modal) return;
    updateWeeklyCodeUIElements();
    modal.classList.remove("hidden");
    trapFocus(modal);
    initIcons(modal);
  }

  function closeWeeklyCodeModal() {
    releaseFocus();
    document.getElementById("weeklyCodeModal")?.classList.add("hidden");
  }

  async function copyWeeklyCodeToClipboard() {
    const { code } = getWeeklyCodeInfo();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = code;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      showToast(`Код для пар (${code}) скопирован в буфер!`, "success");
    } catch (e) {
      showToast(`Код для пар: ${code}`, "info");
    }
  }

  function updateNotificationBtnUI() {
    const btnText = document.getElementById("notificationBtnText");
    const bellIcon = document.getElementById("bellIcon");
    if (!btnText) return;

    if ("Notification" in window && Notification.permission === "granted") {
      btnText.innerText = "Уведомления включены";
      bellIcon?.setAttribute("data-lucide", "bell-ring");
      bellIcon?.classList.remove("text-[#a3a3a3]");
      bellIcon?.classList.add("text-emerald-400");
    } else {
      btnText.innerText = "Уведомления на ПК";
      bellIcon?.setAttribute("data-lucide", "bell");
      bellIcon?.classList.remove("text-emerald-400");
      bellIcon?.classList.add("text-[#a3a3a3]");
    }
    initIcons();
  }

  async function toggleDesktopNotifications() {
    if (!("Notification" in window)) {
      showToast("Ваш браузер не поддерживает системные уведомления", "warning");
      return;
    }

    if (Notification.permission === "granted") {
      const { code, nextMonFormatted } = getWeeklyCodeInfo();
      try {
        new Notification("🔑 Студенческий Диск — Код для пар", {
          body: `Актуальный код на эту неделю: ${code}\nДействует до: ${nextMonFormatted}`,
          tag: "weekly-code-test"
        });
        showToast("Уведомления на ПК активны! Тестовое уведомление отправлено.", "success");
      } catch (e) {
        showToast(`Уведомления активны. Код на неделю: ${code}`, "info");
      }
      return;
    }

    if (Notification.permission !== "denied") {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        const { code, nextMonFormatted } = getWeeklyCodeInfo();
        try {
          new Notification("🔔 Уведомления на ПК включены!", {
            body: `Код для пар на эту неделю: ${code}\nДействует до: ${nextMonFormatted}`
          });
        } catch (e) {}
        showToast("Системные уведомления на этот ПК успешно включены!", "success");
        updateNotificationBtnUI();
      } else {
        showToast("Разрешение на уведомления отклонено в браузере", "warning");
      }
    } else {
      showToast("Уведомления заблокированы в настройках браузера", "warning");
    }
  }

  function checkAndNotifyWeeklyCodeOnMaster() {
    if (currentDeviceRole !== "master") return;

    const { weekNum, code, nextMonFormatted } = getWeeklyCodeInfo();
    const lastNotified = localStorage.getItem("disk_last_notified_week");

    updateWeeklyCodeUIElements();
    updateNotificationBtnUI();

    // If new week arrived and hasn't been notified yet on this browser
    if (lastNotified !== String(weekNum)) {
      localStorage.setItem("disk_last_notified_week", String(weekNum));

      showToast(`🎓 Новый код для колледжа на эту неделю: ${code} (до ${nextMonFormatted})`, "info");

      if ("Notification" in window && Notification.permission === "granted") {
        try {
          new Notification("🔑 Новый код для пар на эту неделю", {
            body: `Код доступа в колледже: ${code}\nДействует до: ${nextMonFormatted}`,
            tag: `weekly-code-${weekNum}`
          });
        } catch (e) {
          console.warn("Notification error:", e);
        }
      }
    }
  }

  // ================= EXPOSE ONLY SAFE UI HANDLERS TO WINDOW =================
  window.handlePinSubmit = handlePinSubmit;
  window.handleLock = handleLock;
  window.togglePinVisibility = togglePinVisibility;
  window.selectSubject = selectSubject;
  window.selectSubfolder = selectSubfolder;
  window.selectSubjectAndSubfolder = selectSubjectAndSubfolder;
  window.openCreateSubjectModal = openCreateSubjectModal;
  window.closeCreateSubjectModal = closeCreateSubjectModal;
  window.submitCreateSubject = submitCreateSubject;
  window.openRenameSubjectModal = openRenameSubjectModal;
  window.closeRenameSubjectModal = closeRenameSubjectModal;
  window.submitRenameSubject = submitRenameSubject;
  window.deleteSubject = deleteSubject;
  window.openCreateSubfolderModal = openCreateSubfolderModal;
  window.closeCreateSubfolderModal = closeCreateSubfolderModal;
  window.submitCreateSubfolder = submitCreateSubfolder;
  window.openRenameSubfolderModal = openRenameSubfolderModal;
  window.closeRenameSubfolderModal = closeRenameSubfolderModal;
  window.submitRenameSubfolder = submitRenameSubfolder;
  window.deleteSubfolder = deleteSubfolder;
  window.openMoveFileModal = openMoveFileModal;
  window.closeMoveFileModal = closeMoveFileModal;
  window.submitMoveFile = submitMoveFile;
  window.openPreview = openPreview;
  window.closePreviewModal = closePreviewModal;
  window.downloadFile = downloadFile;
  window.downloadCurrentSubjectZip = downloadCurrentSubjectZip;
  window.deleteFile = deleteFile;
  window.handleSearchInput = handleSearchInput;
  window.handleMobileSearchInput = handleMobileSearchInput;
  window.clearSearch = clearSearch;
  window.clearMobileSearch = clearMobileSearch;
  window.toggleMobileSearch = toggleMobileSearch;
  window.switchViewMode = switchViewMode;
  window.changeSortMode = changeSortMode;
  window.triggerFileInput = triggerFileInput;
  window.handleFileInputChange = handleFileInputChange;
  window.openSelectUploadSubjectModal = openSelectUploadSubjectModal;
  window.closeSelectUploadSubjectModal = closeSelectUploadSubjectModal;
  window.confirmUploadWithSelectedSubject = confirmUploadWithSelectedSubject;

  // Device & Sessions Management
  window.openDevicesModal = openDevicesModal;
  window.closeDevicesModal = closeDevicesModal;
  window.revokeSession = revokeSession;
  window.revokeAllCollegeSessions = revokeAllCollegeSessions;
  window.clearInactiveSessions = clearInactiveSessions;
  window.deleteSessionFromHistory = deleteSessionFromHistory;
  window.setDeviceRoleUI = setDeviceRoleUI;

  // Weekly Code Delivery & Reveal
  window.openWeeklyCodeModal = openWeeklyCodeModal;
  window.closeWeeklyCodeModal = closeWeeklyCodeModal;
  window.toggleWeeklyCodeMask = toggleWeeklyCodeMask;
  window.copyWeeklyCodeToClipboard = copyWeeklyCodeToClipboard;
  window.toggleDesktopNotifications = toggleDesktopNotifications;

})(window, document);
