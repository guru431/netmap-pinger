'use strict';

// Apply this browser's preferences before the stylesheets and first paint.
(() => {
  const root = document.documentElement;
  const keys = {
    language: 'netmap-language',
    theme: 'netmap-theme',
    font: 'netmap-font-size',
    scale: 'netmap-ui-scale'
  };
  const scales = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
  const scaleFloor = matchMedia('(pointer: coarse)').matches ? 75 : 50;

  function read(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch { return false; }
  }

  const savedFont = Number(read(keys.font));
  const savedScale = Number(read(keys.scale));
  const font = savedFont >= 85 && savedFont <= 150 && savedFont % 5 === 0 ? savedFont : 100;
  const scale = scales.includes(savedScale) ? Math.max(scaleFloor, savedScale) : 100;
  const language = read(keys.language) === 'en' ? 'en' : 'ru';
  const theme = read(keys.theme) === 'dark' ? 'dark' : 'light';

  function applyTheme(value) {
    root.dataset.theme = value;
    document.querySelector('meta[name="theme-color"]').content = value === 'dark' ? '#1b242e' : '#132a3b';
  }

  function applySizes(fontSize, interfaceScale) {
    root.style.setProperty('--font-scale', fontSize / 100);
    root.style.setProperty('--ui-scale', interfaceScale / 100);
    root.style.zoom = String(interfaceScale / 100);
  }

  root.lang = language;
  if (language === 'en') {
    document.querySelector('link[rel="manifest"]').href = 'static/pwa/manifest.en.webmanifest';
  }
  applyTheme(theme);
  applySizes(font, scale);

  document.addEventListener('DOMContentLoaded', () => {
    for (const choice of document.querySelectorAll('input[name="appearance-theme"]')) {
      choice.checked = choice.value === theme;
      choice.addEventListener('change', () => {
        if (!choice.checked) return;
        applyTheme(choice.value);
        save(keys.theme, choice.value);
      });
    }

    const languageInput = document.getElementById('interface-language');
    languageInput.value = language;
    languageInput.addEventListener('change', () => {
      if (languageInput.value === language) return;
      if (save(keys.language, languageInput.value)) {
        location.reload();
      } else {
        languageInput.value = language;
        document.getElementById('language-status').textContent =
          tr("Браузер не разрешает сохранить язык. Разрешите хранилище сайта и повторите.");
      }
    });

    const fontInput = document.getElementById('appearance-font');
    const scaleInput = document.getElementById('appearance-scale');
    const fontOutput = document.getElementById('appearance-font-value');
    for (const value of scales) {
      const option = new Option(`${value}%`, value);
      option.disabled = value < scaleFloor;
      scaleInput.add(option);
    }
    fontInput.value = font;
    scaleInput.value = scale;
    fontOutput.value = `${font}%`;

    function updateSizes() {
      applySizes(Number(fontInput.value), Number(scaleInput.value));
      fontOutput.value = `${fontInput.value}%`;
      save(keys.font, fontInput.value);
      save(keys.scale, scaleInput.value);
    }

    fontInput.addEventListener('input', updateSizes);
    scaleInput.addEventListener('change', updateSizes);
    document.getElementById('appearance-reset').addEventListener('click', () => {
      fontInput.value = scaleInput.value = '100';
      updateSizes();
    });
  }, { once: true });
})();
