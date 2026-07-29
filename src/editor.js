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

// Метка сборки в логе и в диагностическом тосте: главный вопрос при разборе проблемы
// на телефоне — доехал ли туда новый код вообще, или браузер отдаёт модуль из кэша.
const EDITOR_BUILD = '0.1.1';

let modalOpen = false;

function isMac() {
    try {
        return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent ?? '');
    } catch (err) {
        return false;
    }
}

function applyStyles(el, styles) {
    for (const [prop, value] of Object.entries(styles)) {
        el.style[prop] = value;
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
    // Критичная геометрия задаётся инлайном, а не только классом. Причины: style.css
    // расширения может не подхватиться (кэш мобильного браузера, чужая сборка ST),
    // движок может не знать шорткат `inset`, а правила хоста — схлопнуть нашу коробку.
    // Инлайн бьёт любой внешний селектор без !important, поэтому окно видно даже
    // тогда, когда от нашего CSS не осталось ничего. Значения совпадают со style.css.
    applyStyles(overlay, {
        position: 'fixed',
        top: '0',
        right: '0',
        bottom: '0',
        left: '0',
        zIndex: '100000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        boxSizing: 'border-box',
        background: 'rgba(0, 0, 0, 0.6)',
    });

    const modal = document.createElement('div');
    modal.className = 'imaginy-modal';
    applyStyles(modal, {
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '720px',
        // min-height — страховка от схлопывания: без неё окно с нулевой высотой
        // выглядит как тонкая полоска, и отличить это от «не открылось» нельзя.
        minHeight: '120px',
        // На узком экране style.css разворачивает окно на всю высоту (@media
        // max-width: 600px), инлайн обязан вести себя так же — иначе он бы это правило
        // перебил, ведь инлайн приоритетнее любого селектора.
        maxHeight: window.innerWidth <= 600 ? '100%' : '85vh',
        overflow: 'hidden',
        borderRadius: '8px',
        border: '1px solid var(--SmartThemeBorderColor, #444)',
        background: 'var(--SmartThemeBlurTintColor, #1e1e1e)',
        color: 'var(--SmartThemeBodyColor, #e0e0e0)',
    });
    overlay.appendChild(modal);

    // Внутренняя раскладка тоже инлайном — ровно тот минимум, без которого окно
    // нечитаемо: шапка, прокручиваемое тело, прижатый низ. Остальное (цвета, отступы
    // полей, вид кнопок) спокойно доедет из style.css, когда он есть.
    const header = document.createElement('div');
    header.className = 'imaginy-modal-header';
    header.textContent = 'Редактирование промпта';
    applyStyles(header, { flex: '0 0 auto', padding: '12px 16px', fontWeight: '600' });
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'imaginy-modal-body';
    applyStyles(body, {
        flex: '1 1 auto',
        minHeight: '0',
        overflowY: 'auto',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
    });
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
        applyStyles(input, { width: '100%', boxSizing: 'border-box' });
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
    applyStyles(footer, {
        flex: '0 0 auto',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '12px 16px',
        justifyContent: 'flex-end',
        // На узком экране style.css ставит кнопки в столбик — инлайн повторяет это,
        // иначе он бы перебил медиазапрос.
        ...(window.innerWidth <= 600 ? { flexDirection: 'column', alignItems: 'stretch' } : {}),
    });
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

    // Диагностика «окно вставилось, но его не видно». Консоли на телефоне нет, поэтому
    // измеренная геометрия уходит в тост как есть: по числам сразу видно, схлопнут
    // оверлей, схлопнута модалка или окно уехало за пределы вьюпорта.
    try {
        const o = overlay.getBoundingClientRect();
        const m = modal.getBoundingClientRect();
        const geom = `overlay ${Math.round(o.width)}x${Math.round(o.height)}@${Math.round(o.left)},${Math.round(o.top)}`
            + ` modal ${Math.round(m.width)}x${Math.round(m.height)}@${Math.round(m.left)},${Math.round(m.top)}`
            + ` viewport ${window.innerWidth}x${window.innerHeight}`;
        logInfo(`openEditor: ${geom} (v${EDITOR_BUILD})`);
        const collapsed = m.width < 40 || m.height < 40;
        const offscreen = m.bottom < 1 || m.top > window.innerHeight || m.right < 1 || m.left > window.innerWidth;
        if (collapsed || offscreen) {
            toast('warning', `Редактор v${EDITOR_BUILD} не виден: ${geom}`);
        }
    } catch (err) {
        logWarn('openEditor: не удалось измерить окно', err);
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
