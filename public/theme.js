// ---- Color helpers ---------------------------------------------------------
function qpHexToRgb(hex) {
  const c = (hex || '').replace('#', '');
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function qpRgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function qpLuminance([r, g, b]) { return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }

// A hover/emphasis variant of a color: darkens light colors, lightens dark
// ones, so it works whether a quiz's brand color is white or black.
function qpShade(hex, amount = 0.25) {
  if (!hex) return hex;
  const rgb = qpHexToRgb(hex);
  const lum = qpLuminance(rgb);
  const mixWith = lum > 0.5 ? [0, 0, 0] : [255, 255, 255];
  const mixed = rgb.map((c, i) => c + (mixWith[i] - c) * amount);
  return qpRgbToHex(...mixed);
}

// Apply a quiz's theme (or clear back to the app default) by overriding CSS
// custom properties on the root element — every component reads colors via
// var(--qp-primary) / var(--qp-accent), so this one call re-themes the whole
// page instantly, no re-render needed.
function qpApplyTheme(theme) {
  const root = document.documentElement.style;
  if (theme && theme.primary_color) {
    root.setProperty('--qp-primary', theme.primary_color);
    root.setProperty('--qp-primary-dark', qpShade(theme.primary_color, 0.3));
  } else {
    root.removeProperty('--qp-primary');
    root.removeProperty('--qp-primary-dark');
  }
  if (theme && theme.secondary_color) {
    root.setProperty('--qp-accent', theme.secondary_color);
    root.setProperty('--qp-accent-dark', qpShade(theme.secondary_color, 0.25));
  } else {
    root.removeProperty('--qp-accent');
    root.removeProperty('--qp-accent-dark');
  }
}

// Sample an <img> onto a small offscreen canvas and average its opaque
// pixels — a fast, good-enough "dominant color" to suggest a theme from a
// freshly-chosen logo file. Only works for local files (blob: / data: URLs);
// an already-hosted cross-origin image would taint the canvas, so this is
// meant to run at file-picker time, before upload.
function qpDominantColor(imgEl) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, size, size);
  let r = 0, g = 0, b = 0, count = 0;
  try {
    const data = ctx.getImageData(0, 0, size, size).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // skip transparent pixels
      r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
    }
  } catch (e) {
    return null;
  }
  if (!count) return null;
  return qpRgbToHex(r / count, g / count, b / count);
}

// ---- Podium (Kahoot-style top 3) -------------------------------------------
function qpEsc(s) { return (s ?? '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function qpRenderPodium(rows) {
  const top3 = rows.slice(0, 3);
  if (!top3.length) return '';
  // Kahoot ordering: 2nd on the left, 1st in the middle (tallest), 3rd on the right.
  const order = [top3[1], top3[0], top3[2]].filter(Boolean);
  const heights = { 0: 108, 1: 156, 2: 84 }; // by podium position (2nd, 1st, 3rd)
  const medals = { 0: '🥈', 1: '🥇', 2: '🥉' };
  const delays = { 0: '0.15s', 1: '0s', 2: '0.3s' };

  return `
    <div class="qp-podium">
      ${order.map((row, i) => {
        if (!row) return '';
        const height = heights[top3.indexOf(row)] ?? 90;
        const medal = medals[top3.indexOf(row)] ?? '';
        const delay = delays[top3.indexOf(row)] ?? '0s';
        return `
          <div class="qp-podium-stand" style="animation-delay:${delay}">
            <div class="qp-podium-medal">${medal}</div>
            <div class="qp-podium-name">${qpEsc(row.name)}</div>
            <div class="qp-podium-pts">${row.totalPoints} pts</div>
            <div class="qp-podium-block" style="height:${height}px"></div>
          </div>`;
      }).join('')}
    </div>`;
}

// ---- FLIP-style reorder animation -------------------------------------------
// Animates a leaderboard list re-sorting itself instead of just snapping to
// new positions. Call with the *old* DOM state still in the container; it
// captures current positions, lets you mutate innerHTML, then animates the
// delta. Rows must carry a `data-key` attribute (e.g. player id) so it can
// match old to new.
function qpFlipReorder(container, applyNewHtml) {
  if (!container) { applyNewHtml(); return; }
  const firstRects = new Map();
  container.querySelectorAll('[data-key]').forEach((el) => {
    firstRects.set(el.dataset.key, el.getBoundingClientRect());
  });

  applyNewHtml();

  container.querySelectorAll('[data-key]').forEach((el) => {
    const first = firstRects.get(el.dataset.key);
    if (!first) {
      // New row — fade/slide it in rather than snapping.
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      requestAnimationFrame(() => {
        el.style.transition = 'opacity .3s ease, transform .3s ease';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });
      return;
    }
    const last = el.getBoundingClientRect();
    const deltaY = first.top - last.top;
    if (Math.abs(deltaY) < 1) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${deltaY}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform .4s cubic-bezier(.2,.8,.2,1)';
      el.style.transform = 'translateY(0)';
    });
  });
}
