// Настройки Imaginy: extensionSettings.Imaginy (camelCase-поле контекста ST),
// с мержем недостающих ключей при апгрейде.

import { getCtx, toast } from './ctx.js';
import { logError, logInfo } from './log.js';
import { getHost } from './host.js';
import { t, resetLocale, LOCALES } from './i18n.js';

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
    // Язык интерфейса: 'auto' — как в самой таверне, иначе код из i18n.LOCALES.
    // Ручной переключатель нужен потому, что язык таверны и язык, на котором человеку
    // удобно читать расширение, совпадают не всегда — а ещё потому, что getCurrentLocale
    // есть не во всех версиях ST (см. src/i18n.js).
    language: 'auto',
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

    // Язык пересчитываем заново: модуль i18n мог определить его до того, как ST донёс
    // настройки расширения и свою локаль, и закэшировать преждевременный ответ.
    resetLocale();
    applyPanelTranslations();
    bindLastStyle();
    bindLanguage();
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
                toast('success', t('toast.styleForgotten'));
            } catch (err) {
                logError('не удалось забыть стиль', err);
                toast('error', t('toast.styleForgetFailed'));
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

// Переписывает подписи панели на текущий язык. В settings.html лежит русский текст
// (язык оригинала) плюс ключ в data-i18n; здесь текст заменяется переводом. Отдельная
// функция, а не разовый проход, потому что её же зовёт переключатель языка.
function applyPanelTranslations() {
    try {
        const root = document.querySelector('.imaginy-settings');
        if (!root) return;
        for (const el of root.querySelectorAll('[data-i18n]')) {
            el.textContent = t(el.getAttribute('data-i18n'));
        }
    } catch (err) {
        logError('не удалось перевести панель настроек', err);
    }
}

// Переключатель языка. Смена применяется к панели сразу, к редактору — при следующем
// открытии: перерисовывать открытое окно не за чем, оно живёт секунды.
function bindLanguage() {
    try {
        const $language = $('#imaginy_language');
        const current = getSettings().language ?? 'auto';
        $language.val(LOCALES.includes(current) || current === 'auto' ? current : 'auto');

        $language.on('change', function () {
            try {
                const s = getSettings();
                s.language = this.value;
                saveSettings();
                resetLocale();
                applyPanelTranslations();
                // Имя хоста подписи не имеет — его пишет bindHostName, и перевод панели
                // только что затёр его ключом-заглушкой «определяется…».
                renderHostName();
                logInfo(`язык интерфейса переключён: ${s.language}`);
            } catch (err) {
                logError('не удалось переключить язык', err);
            }
        });
    } catch (err) {
        logError('не удалось привязать переключатель языка', err);
    }
}

// Показывает в панели, какое расширение картинок Imaginy считает активным. Детект по
// DOM уточняется по мере отрисовки картинок (src/host.js), поэтому подпись обновляем
// не один раз, а несколько — иначе на старте она навсегда застынет на предварительном
// выводе, сделанном по одним настройкам.
function renderHostName() {
    const el = document.getElementById('imaginy_host_name');
    if (!el) return;
    try {
        // t(имя) — имена опознанных хостов не переводятся и возвращаются сами собой
        // (см. src/i18n.js); ключ есть только у неопознанного.
        el.textContent = t(getHost().name);
    } catch (err) {
        el.textContent = t('settings.host.unknown');
    }
}

function bindHostName() {
    if (!document.getElementById('imaginy_host_name')) return;
    renderHostName();
    for (const delay of [2000, 6000, 15000]) setTimeout(renderHostName, delay);
}
