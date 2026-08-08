// Настройки Imaginy: extensionSettings.Imaginy (camelCase-поле контекста ST),
// с мержем недостающих ключей при апгрейде.

import { getCtx, toast } from './ctx.js';
import { logError, logInfo } from './log.js';
import { getHost } from './host.js';

export const MODULE_NAME = 'Imaginy';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showEditButton: true,
    regenerateAfterSave: false,
    // Досинхронизация путей к картинкам по всем местам хранения текста сообщения
    // (src/srcsync.js). Лечит откат перегенерированной картинки на самую первую после
    // перезагрузки страницы. Выключатель нужен на случай конфликта с хостом.
    syncImageSrc: true,
    // Последний непустой «Стиль» из редактора. Живёт в extensionSettings (глобальные
    // настройки ST), а не в метаданных чата, поэтому переживает и смену чата, и
    // перезагрузку страницы: редактор подставляет его, когда в инструкции стиля нет.
    lastStyle: '',
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
    const $syncImageSrc = $('#imaginy_sync_image_src');

    $enabled.prop('checked', settings.enabled);
    $showEditButton.prop('checked', settings.showEditButton);
    $regenerateAfterSave.prop('checked', settings.regenerateAfterSave);
    $syncImageSrc.prop('checked', settings.syncImageSrc);

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

    $syncImageSrc.on('change', function () {
        const s = getSettings();
        s.syncImageSrc = this.checked;
        saveSettings();
    });

    bindLastStyle();
    bindHostName();

    logInfo('панель настроек инициализирована');
}

// Поле «Запомненный стиль»: тот же lastStyle, что подставляет редактор, только
// доступный без открытия картинки. Своя обёртка в try/catch — панель обязана
// инициализироваться целиком, даже если этот кусок упал.
function bindLastStyle() {
    try {
        const $lastStyle = $('#imaginy_last_style');
        $lastStyle.val(getSettings().lastStyle ?? '');

        // В настройки кладём тримленое значение — ровно то же, что пишет редактор
        // (src/editor.js, rememberStyle). Иначе «  foo\n», набранное здесь, после
        // первого же сохранения в редакторе скачком превратилось бы в «foo», а стиль
        // из одних пробелов осел бы в настройках, никогда не подставляясь: редактор
        // требует lastStyle.trim().length > 0. Само поле при этом не переписываем —
        // иначе у пользователя прыгал бы курсор прямо во время набора.
        // saveSettings дебаунсится, звать на каждый ввод нормально.
        $lastStyle.on('input', function () {
            // Тело обработчика выполняется много позже привязки и внешним try уже не
            // накрыто: getSettings() зовёт SillyTavern.getContext(), который может
            // бросить. Без своего catch исключение ушло бы наружу из jQuery.
            try {
                getSettings().lastStyle = this.value.trim();
                saveSettings();
            } catch (err) {
                logError('не удалось запомнить стиль из панели настроек', err);
            }
        });

        $('#imaginy_forget_style').on('click', function () {
            try {
                // Сначала настройки, потом поле: если запись упадёт, поле останется
                // заполненным и покажет реальное состояние, а не пустоту с тостом об успехе.
                getSettings().lastStyle = '';
                saveSettings();
                $lastStyle.val('');
                toast('success', 'Запомненный стиль забыт');
            } catch (err) {
                logError('не удалось забыть стиль', err);
                toast('error', 'Не удалось забыть стиль');
            }
        });
    } catch (err) {
        logError('не удалось привязать поле запомненного стиля', err);
    }
}

// Редактор меняет lastStyle сам (при сохранении и по кнопке «Забыть» в подсказке), а
// панель строится один раз — без этого вызова она показывала бы устаревшее значение.
// Живёт здесь, а не в editor.js, чтобы не появился цикл settings.js -> editor.js.
export function refreshLastStyleField() {
    try {
        const el = document.getElementById('imaginy_last_style');
        if (!el) return;
        // В фокусе — значит пользователь печатает прямо сейчас; затирать его ввод нельзя.
        if (document.activeElement === el) return;
        el.value = getSettings().lastStyle ?? '';
    } catch (err) {
        logError('не удалось обновить поле запомненного стиля', err);
    }
}

// Показывает в панели, какое расширение картинок Imaginy считает активным. Детект по
// DOM уточняется по мере отрисовки картинок (src/host.js), поэтому подпись обновляем
// не один раз, а несколько — иначе на старте она навсегда застынет на предварительном
// выводе, сделанном по одним настройкам.
function bindHostName() {
    const el = document.getElementById('imaginy_host_name');
    if (!el) return;

    const render = () => {
        try {
            el.textContent = getHost().name;
        } catch (err) {
            el.textContent = 'не определено';
        }
    };

    render();
    for (const delay of [2000, 6000, 15000]) setTimeout(render, delay);
}
