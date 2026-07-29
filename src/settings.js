// Настройки Imaginy: extensionSettings.Imaginy (camelCase-поле контекста, см.
// docs/sillytavern-api.md §1), с мержем недостающих ключей при апгрейде.

import { getCtx } from './ctx.js';
import { logError, logInfo } from './log.js';

export const MODULE_NAME = 'Imaginy';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showEditButton: true,
    regenerateAfterSave: false,
});

// Возвращает живой (не клонированный) объект настроек, создавая его при первом
// обращении и добавляя недостающие ключи после апгрейдов, чтобы никогда не остаться
// с undefined-полями.
export function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = ctx.extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = DEFAULT_SETTINGS[key];
        }
    }
    return settings;
}

export function saveSettings() {
    const ctx = getCtx();
    ctx.saveSettingsDebounced();
}

// Загружает settings.html и подключает чекбоксы. onSettingsChanged(settings) вызывается
// при изменении enabled/showEditButton, чтобы decorate.js мог сразу перерисоваться —
// без циклического импорта settings.js -> decorate.js -> settings.js.
export async function initSettingsUI(onSettingsChanged) {
    const ctx = getCtx();
    try {
        // Внимание: import.meta.url внутри src/settings.js резолвится относительно
        // src/, поэтому путь к settings.html (лежит в корне расширения) — на уровень
        // выше.
        const settingsHtml = await $.get(new URL('../settings.html', import.meta.url).href);
        $('#extensions_settings').append(settingsHtml);
    } catch (err) {
        logError('не удалось загрузить settings.html', err);
        return;
    }

    const settings = getSettings();

    const $enabled = $('#imaginy_enabled');
    const $showEditButton = $('#imaginy_show_edit_button');
    const $regenerateAfterSave = $('#imaginy_regenerate_after_save');

    $enabled.prop('checked', settings.enabled);
    $showEditButton.prop('checked', settings.showEditButton);
    $regenerateAfterSave.prop('checked', settings.regenerateAfterSave);

    $enabled.on('change', function () {
        const s = getSettings();
        s.enabled = this.checked;
        saveSettings();
        onSettingsChanged?.(s);
    });

    $showEditButton.on('change', function () {
        const s = getSettings();
        s.showEditButton = this.checked;
        saveSettings();
        onSettingsChanged?.(s);
    });

    $regenerateAfterSave.on('change', function () {
        const s = getSettings();
        s.regenerateAfterSave = this.checked;
        saveSettings();
    });

    logInfo('панель настроек инициализирована');
}
