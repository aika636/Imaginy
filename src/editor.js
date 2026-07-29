// Собственный модальный редактор промпта. Осознанное отклонение от плана
// (plan-fork.md §3.2 предполагал ctx.callGenericPopup): нам нужны три разных
// действия (Сохранить / Сохранить и перегенерировать / Отмена), а состав
// ctx.POPUP_TYPE для кастомных кнопок [НЕ ПРОВЕРЕНО] на этой инсталляции
// (docs/sillytavern-api.md §1). Собственный оверлей .imaginy-modal не зависит ни
// от одной непроверенной части хоста и даёт полный контроль над рядом кнопок.

import { toast } from './ctx.js';
import { logError, logInfo, logWarn } from './log.js';

const FIELDS = [
    { key: 'prompt', label: 'Промпт', kind: 'textarea', rows: 8, autofocus: true },
    { key: 'style', label: 'Стиль', kind: 'textarea', rows: 3 },
    { key: 'aspect_ratio', label: 'Соотношение сторон', kind: 'text' },
    { key: 'image_size', label: 'Размер', kind: 'text' },
    { key: 'quality', label: 'Качество', kind: 'text' },
    { key: 'preset', label: 'Пресет', kind: 'text' },
];

let modalOpen = false;

function isMac() {
    try {
        return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent ?? '');
    } catch (err) {
        return false;
    }
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
        logWarn('copyToClipboard: navigator.clipboard упал, пробуем фолбэк', err);
    }
    // Фолбэк для не-HTTPS контекстов, где Clipboard API недоступен.
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (err) {
        logWarn('copyToClipboard: фолбэк execCommand тоже упал', err);
        return false;
    }
}

// openEditor({ data, kind, regen }) -> Promise<{ action: 'save'|'saveAndRegen', data } | null>
// regen — результат canRegen(targetEl, kind) из src/regen.js: { ok, reason }.
// Единственный источник истины для того, можно ли перегенерировать и почему нет —
// сам regen.js; здесь мы только показываем его вердикт.
export function openEditor({ data, kind, regen }) {
    // Флаг сверяем с реальным DOM: если модалка «открыта», но оверлея на странице нет,
    // значит прошлый вызов упал на полпути (или узел вынесли извне) — тогда флаг
    // залипший, и держать пользователя в состоянии «редактор уже открыт» до перезагрузки
    // страницы нельзя.
    if (modalOpen && document.querySelector('.imaginy-modal-overlay')) {
        toast('info', 'Редактор уже открыт');
        return Promise.resolve(null);
    }
    if (modalOpen) {
        logWarn('openEditor: залипший флаг modalOpen без оверлея в DOM — сбрасываю');
        modalOpen = false;
    }
    modalOpen = true;

    return new Promise((resolve) => {
        try {
            buildModal({ data, kind, regen }, resolve);
        } catch (err) {
            // Любое исключение при сборке модалки раньше оставляло modalOpen === true
            // навсегда: окно не появлялось, а следующий клик отвечал «Редактор уже открыт».
            // Теперь состояние откатывается, а причина видна пользователю без консоли.
            modalOpen = false;
            document.querySelector('.imaginy-modal-overlay')?.remove();
            logError('openEditor: не удалось построить модалку', err);
            toast('error', `Не удалось открыть редактор: ${err?.message ?? err}`);
            resolve(null);
        }
    });
}

function buildModal({ data, kind, regen }, resolve) {
    const inputs = {}; // key -> <textarea>|<input>
    let dirty = false;
    let settled = false;

    const overlay = document.createElement('div');
    overlay.className = 'imaginy-modal-overlay';
    // Дублируем позиционирование инлайном: если style.css почему-то не подхватился
    // (кэш мобильного браузера, свой порядок загрузки в чужой сборке ST) или движок
    // не знает шорткат `inset`, оверлей без этих правил оказывается статическим
    // блоком в конце <body> — то есть за пределами видимой области, и выглядит это
    // ровно как «редактор не открывается». Значения совпадают с style.css.
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.left = '0';
    overlay.style.zIndex = '100000';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    const modal = document.createElement('div');
    modal.className = 'imaginy-modal';
    overlay.appendChild(modal);

    const header = document.createElement('div');
    header.className = 'imaginy-modal-header';
    header.textContent = 'Редактирование промпта';
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'imaginy-modal-body';
    modal.appendChild(body);

    let copyBtn = null;

    for (const field of FIELDS) {
        const wrap = document.createElement('div');
        wrap.className = 'imaginy-field';

        const labelRow = document.createElement('div');
        labelRow.className = 'imaginy-field-label-row';

        const label = document.createElement('label');
        label.textContent = field.label;
        labelRow.appendChild(label);

        if (field.key === 'prompt') {
            copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'imaginy-copy-btn';
            copyBtn.textContent = 'Скопировать промпт';
            labelRow.appendChild(copyBtn);
        }

        wrap.appendChild(labelRow);

        let input;
        if (field.kind === 'textarea') {
            input = document.createElement('textarea');
            input.rows = field.rows;
        } else {
            input = document.createElement('input');
            input.type = 'text';
        }
        // Значение выставляем через .value, а не интерполяцией в HTML-строку —
        // пользовательские/модельные данные не должны никогда попадать в innerHTML.
        const existing = data?.[field.key];
        input.value = typeof existing === 'string' ? existing : existing != null ? String(existing) : '';
        input.addEventListener('input', () => {
            dirty = true;
        });
        if (field.autofocus) {
            queueMicrotask(() => input.focus());
        }

        inputs[field.key] = input;
        wrap.appendChild(input);
        body.appendChild(wrap);
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const ok = await copyToClipboard(inputs.prompt.value);
            toast(ok ? 'success' : 'error', ok ? 'Промпт скопирован' : 'Не удалось скопировать промпт');
        });
    }

    const footer = document.createElement('div');
    footer.className = 'imaginy-modal-footer';
    modal.appendChild(footer);

    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'menu_button';
    btnSave.textContent = 'Сохранить';

    const btnSaveRegen = document.createElement('button');
    btnSaveRegen.type = 'button';
    btnSaveRegen.className = 'menu_button';
    btnSaveRegen.textContent = 'Сохранить и перегенерировать';

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'menu_button';
    btnCancel.textContent = 'Отмена';

    if (regen && !regen.ok) {
        btnSaveRegen.disabled = true;
        btnSaveRegen.title = regen.reason;
    }

    const hint = document.createElement('small');
    hint.className = 'imaginy-modal-hint';
    hint.textContent = `${SAVE_HOTKEY_LABEL} — сохранить, Esc — отмена`;
    footer.appendChild(hint);

    footer.appendChild(btnSave);
    footer.appendChild(btnSaveRegen);
    footer.appendChild(btnCancel);

    document.body.appendChild(overlay);

    // Диагностика «окно вставилось, но его не видно»: без консоли (телефон) это
    // единственный способ отличить упавшую сборку модалки от CSS-проблемы.
    try {
        const rect = overlay.getBoundingClientRect();
        logInfo(`openEditor: оверлей вставлен, rect=${Math.round(rect.width)}x${Math.round(rect.height)} @ ${Math.round(rect.left)},${Math.round(rect.top)}`);
        if (rect.width < 1 || rect.height < 1 || rect.bottom < 1 || rect.top > window.innerHeight) {
            toast('warning', 'Редактор открыт, но не виден — похоже, style.css расширения не применился');
        }
    } catch (err) {
        logWarn('openEditor: не удалось измерить оверлей', err);
    }

    function buildResultData() {
        // Клонируем исходный объект, чтобы неизвестные ключи (которые мы не
        // рендерим) пережили редактирование.
        const result = { ...(data ?? {}) };
        for (const field of FIELDS) {
            const raw = inputs[field.key].value;
            const trimmed = raw.trim();
            if (trimmed.length > 0) {
                result[field.key] = trimmed;
            } else if (Object.hasOwn(result, field.key)) {
                // Пусто и ключ был в исходной инструкции — удаляем, а не пишем "":
                // для SLAY отсутствие ключа и пустая строка не одно и то же
                // (plan-fork.md §3.2 — "пустые не пишем в JSON, чтобы не менять
                // поведение SLAY").
                delete result[field.key];
            }
            // Пусто и ключа не было — ничего не делаем, ключ остаётся отсутствующим.
        }
        return result;
    }

    function cleanup() {
        document.removeEventListener('keydown', onKeydown, true);
        overlay.removeEventListener('mousedown', onBackdropMouseDown);
        overlay.remove();
        modalOpen = false;
    }

    function settle(value) {
        if (settled) return;
        settled = true;
        try {
            cleanup();
        } finally {
            resolve(value);
        }
    }

    function doSave(action) {
        settle({ action, data: buildResultData() });
    }

    btnSave.addEventListener('click', () => doSave('save'));
    btnSaveRegen.addEventListener('click', () => {
        if (btnSaveRegen.disabled) return;
        doSave('saveAndRegen');
    });
    btnCancel.addEventListener('click', () => settle(null));

    function onKeydown(e) {
        const isEnter = e.key === 'Enter' || e.code === 'NumpadEnter';
        const isSaveCombo = (e.ctrlKey || e.metaKey) && isEnter;
        const isEscape = e.key === 'Escape';
        // stopPropagation только на тех клавишах, которые мы реально обрабатываем.
        // Слушатель висит на document в capture-фазе, поэтому безусловный
        // stopPropagation отрезал бы от события и сами поля ввода модалки, и
        // всё остальное — глушим ровно свои сочетания, чтобы по ним не сработали
        // ещё и глобальные горячие клавиши ST.
        if (!isSaveCombo && !isEscape) return;
        e.stopPropagation();
        e.preventDefault();
        if (isSaveCombo) doSave('save');
        else settle(null);
    }
    document.addEventListener('keydown', onKeydown, true);

    function onBackdropMouseDown(e) {
        if (e.target !== overlay) return;
        if (dirty) {
            // Форма грязная — не терять правки молча по случайному клику мимо.
            return;
        }
        settle(null);
    }
    overlay.addEventListener('mousedown', onBackdropMouseDown);
}

// Экспортируем для UI-подсказки в горячих клавишах, если понадобится снаружи.
export const SAVE_HOTKEY_LABEL = isMac() ? 'Cmd+Enter' : 'Ctrl+Enter';
