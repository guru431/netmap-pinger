'use strict';

const uiLanguage = document.documentElement.lang === 'en' ? 'en' : 'ru';
const uiLocale = uiLanguage === 'en' ? 'en-GB' : 'ru-RU';

function tr(source, ...values) {
  const message = uiLanguage === 'en' && Object.hasOwn(netmapEnglish, source) ? netmapEnglish[source] : source;
  return values.length ? message.replace(/\{(\d+)\}/g, (slot, index) => values[index] ?? slot) : message;
}

function serverMessage(value) {
  const source = String(value ?? '');
  const limit = /^Остановлено по лимиту (\d+) с$/.exec(source);
  return limit ? tr("Остановлено по лимиту {0} с", limit[1]) : tr(source);
}

// Only translate the fixed labels in the HTML shell. Map data is rendered by app.js.
if (uiLanguage === 'en') {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = tr(node.textContent);
  for (const node of document.querySelectorAll('[data-i18n-attrs]')) {
    for (const attribute of node.dataset.i18nAttrs.split(' ')) {
      node.setAttribute(attribute, tr(node.getAttribute(attribute)));
    }
  }
}
