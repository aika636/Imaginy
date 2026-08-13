// Собственный модальный редактор промпта — вместо ctx.callGenericPopup: нам нужны три
// разных действия (Сохранить / Сохранить и перегенерировать / Отмена), а состав
// ctx.POPUP_TYPE для кастомных кнопок от версии ST к версии не гарантирован.
// Собственный оверлей .imaginy-modal не зависит ни от одной непроверенной части хоста
// и даёт полный контроль над рядом кнопок.

import { toast } from './ctx.js';
import { logError, logInfo, logWarn } from './log.js';
import { getAspectRatioContext, setAspectRatioFromPrompt, getStyleContext, clearHostStyle } from './hostquirks.js';
import { getHost } from './host.js';
import { getSettings, saveSettings, refreshLastStyleField } from './settings.js';

// Поля image_size / quality / preset намеренно не редактируются: у активного
// naistera-пути хост их вообще не отправляет (в теле запроса только
// prompt/aspect_ratio/model), а у остальных путей это глобальные настройки хоста.
// Ключи, если они были в инструкции, сохраняются как есть — см. buildResultData.
const FIELDS = [
    { key: 'prompt', label: 'Промпт', kind: 'textarea', rows: 8, autofocus: true },
    { key: 'style', label: 'Стиль', kind: 'textarea', rows: 3 },
    { key: 'aspect_ratio', label: 'Соотношение сторон', kind: 'select' },
];

// Пороги раскладки заданы в строках текста, а не в пикселях. Пиксель на разных
// устройствах означает разное: высота строки зависит от темы ST, размера шрифта в
// настройках браузера и системного масштаба, поэтому «560 px» на одном телефоне — это
// 26 строк, а на другом с крупным шрифтом — 16. Считаем в том, что важно на самом деле:
// сколько строк текста помещается в видимую часть экрана.
//
// ROOMY_LINES — сколько строк просит просторная раскладка (шапка, три поля целиком,
// кнопки столбиком с подсказкой о горячих клавишах). Меньше — ужимаем «обвязку».
// FOCUS_LINES — ниже этого даже с ужатой обвязкой всем полям сразу тесно, и высоту
// забирает то поле, которое правят прямо сейчас.
const ROOMY_LINES = 32;
const FOCUS_LINES = 26;
// Запасная высота строки: используется, только если стили поля почему-то не читаются
// (jsdom в тестах, экзотический движок). Примерно 1.35 от типового шрифта в 16px.
const FALLBACK_LINE_HEIGHT = 21;
// Фолбэк для движков без visualViewport (старые WebView и встроенные браузеры в
// приложениях): там всплывшую клавиатуру не видно ни в одном измерении, и считается,
// что она закрывает примерно 45% экрана — цифра консервативная, ошибка в меньшую
// сторону просто оставит окно чуть просторнее.
const ASSUMED_KEYBOARD_FREE_SHARE = 0.55;

// Метка сборки в логе и в диагностическом тосте: главный вопрос при разборе проблемы
// на телефоне — доехал ли туда новый код вообще, или браузер отдаёт модуль из кэша.
const EDITOR_BUILD = '0.4.0';

let modalOpen = false;
// settle() текущей модалки. Нужен ровно для одного случая: оверлей вынесли из DOM мимо
// редактора (чужой скрипт, перерисовка чата) — тогда закрыть окно уже некому, а промис
// прошлого openEditor остался бы неразрешённым навсегда. index.js его ждёт (await), так
// что вместе с промисом подвис бы и onEdit.
let pendingSettle = null;

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

// transform / filter / backdrop-filter / perspective / will-change / contain на элементе
// делают его содержащим блоком для потомков с position: fixed — такой потомок начинает
// отсчитывать координаты от него, а не от вьюпорта. Оверлей вставляется прямо в <body>,
// поэтому испортить точку отсчёта может только сам <body>: если он это делает (мобильная
// тема ST с блюром), монтируемся уровнем выше, в <html>.
function createsFixedContainingBlock(el) {
    try {
        const cs = getComputedStyle(el);
        return (cs.transform && cs.transform !== 'none')
            || (cs.filter && cs.filter !== 'none')
            || (cs.backdropFilter && cs.backdropFilter !== 'none')
            || (cs.perspective && cs.perspective !== 'none')
            || /transform|filter|perspective/.test(cs.willChange ?? '')
            || /paint|layout|strict|content/.test(cs.contain ?? '');
    } catch (err) {
        logWarn('createsFixedContainingBlock: не удалось прочитать стили', err);
        return false;
    }
}

function pickMountRoot() {
    if (document.body && createsFixedContainingBlock(document.body)) {
        logWarn('openEditor: <body> задаёт содержащий блок для fixed — монтирую оверлей в <html>');
        return document.documentElement;
    }
    return document.body ?? document.documentElement;
}

// Строка-подсказка под полем: текст + необязательная кнопка действия. Один и тот же
// вид у предупреждений о перекрытии настройками SLAY и у заметки о подставленном стиле.
function createHintRow(text, action) {
    const row = document.createElement('div');
    row.className = 'imaginy-field-warning';
    applyStyles(row, {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
        fontSize: '0.8em',
        opacity: '0.85',
    });

    const span = document.createElement('span');
    span.textContent = text;
    row.appendChild(span);

    if (action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'imaginy-copy-btn';
        btn.textContent = action.label;
        btn.addEventListener('click', () => action.onClick(row));
        row.appendChild(btn);
    }

    return row;
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
        // Добиваем промис прошлого вызова: его окна уже нет, ответа от пользователя не
        // будет никогда, а ждущий его onEdit иначе не проснётся.
        try {
            pendingSettle?.(null);
        } catch (err) {
            logWarn('openEditor: не удалось закрыть промис прошлой модалки', err);
        }
        pendingSettle = null;
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
            // Модалка могла успеть зарегистрировать settle до падения — ссылка на неё
            // больше не годится, промис резолвим прямо здесь.
            pendingSettle = null;
            document.querySelector('.imaginy-modal-overlay')?.remove();
            logError('openEditor: не удалось построить модалку', err);
            toast('error', `Не удалось открыть редактор: ${err?.message ?? err}`);
            resolve(null);
        }
    });
}

function buildModal({ data, kind, regen }, resolve) {
    const inputs = {}; // key -> <textarea>|<input>
    const wraps = {};  // key -> .imaginy-field (обёртка поля, ею управляет applyLayout)
    let dirty = false;
    let settled = false;
    // Поле, которое пользователь правит прямо сейчас: когда места мало, именно оно
    // забирает всю свободную высоту, остальные сжимаются до подписи и пары строк.
    let focusedKey = 'prompt';
    // Поле, к которому уже прокручивали тело модалки, и флаг склейки пересчётов
    // раскладки — оба живут в requestLayout/applyLayout.
    let shownKey = 'prompt';
    let layoutQueued = false;

    // Объявление settle поднято, так что ссылку можно взять уже здесь — до того, как
    // хоть что-то успеет упасть. Снимается она в самом settle и в catch у openEditor.
    pendingSettle = settle;

    const overlay = document.createElement('div');
    overlay.className = 'imaginy-modal-overlay';
    // Критичная геометрия задаётся инлайном, а не только классом. Причины: style.css
    // расширения может не подхватиться (кэш мобильного браузера, чужая сборка ST),
    // движок может не знать шорткат `inset`, а правила хоста — схлопнуть нашу коробку.
    // Инлайн бьёт любой внешний селектор без !important, поэтому окно видно даже
    // тогда, когда от нашего CSS не осталось ничего. Значения совпадают со style.css.
    const narrow = window.innerWidth <= 600;
    applyStyles(overlay, {
        position: 'fixed',
        top: '0',
        left: '0',
        // Размер задаётся единицами вьюпорта, а НЕ парой top/bottom + right/left. Пара
        // сторон растягивает элемент по содержащему блоку, а им для position:fixed
        // становится не вьюпорт, а ближайший предок с transform/filter/backdrop-filter —
        // а такие у мобильной темы ST есть. Отсюда и была полоска в 1-2 строки сверху:
        // оверлей честно растягивался, только по чужой низкой коробке. vh/vw же всегда
        // считаются от вьюпорта, каким бы ни был предок.
        width: '100vw',
        height: '100vh',
        zIndex: '100000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: narrow ? '8px' : '16px',
        boxSizing: 'border-box',
        background: 'rgba(0, 0, 0, 0.6)',
    });
    // dvh учитывает свернувшуюся адресную строку и всплывшую клавиатуру. Присваиваем
    // вторым шагом: движок без поддержки dvh молча проигнорирует строку и останется
    // на 100vh выше.
    overlay.style.height = '100dvh';

    const modal = document.createElement('div');
    modal.className = 'imaginy-modal';
    applyStyles(modal, {
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: narrow ? '100%' : '720px',
        // min-height — страховка от схлопывания: без неё окно с нулевой высотой
        // выглядит как тонкая полоска, и отличить это от «не открылось» нельзя.
        minHeight: '120px',
        // На узком экране окно занимает почти весь экран (столько же, сколько даёт
        // @media max-width: 600px в style.css — инлайн обязан повторять медиазапрос,
        // иначе перебьёт его). На широком — прежние 85% высоты.
        height: narrow ? '100%' : 'auto',
        maxHeight: narrow ? '100%' : '85vh',
        overflow: 'hidden',
        borderRadius: narrow ? '0' : '8px',
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
    // Имя хоста в шапке — не украшение: по нему сразу видно, чьи кнопки и настройки
    // Imaginy считает своими (детект хоста описан в src/host.js).
    header.textContent = `Редактирование промпта — ${getHost().name}`;
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
    const host = getHost();
    const aspectCtx = getAspectRatioContext();
    const styleCtx = getStyleContext();
    // Настройки читаем один раз на открытие: нужен только запомненный стиль. Если
    // настройки почему-то недоступны, редактор обязан открыться и без них.
    let lastStyle = '';
    try {
        lastStyle = String(getSettings().lastStyle ?? '');
        // Лог именно здесь, а не в месте подстановки: он должен появляться и когда
        // память пуста. Иначе «стиль не подставился» неотличимо от «в браузере старый
        // модуль из кэша» — а метка сборки ниже покажет ровно это.
        logInfo(`openEditor: запомненный стиль — ${lastStyle.trim().length} символов`);
    } catch (err) {
        logWarn('openEditor: не удалось прочитать настройки (запомненный стиль)', err);
    }

    for (const field of FIELDS) {
        const wrap = document.createElement('div');
        wrap.className = 'imaginy-field' + (field.key === 'prompt' ? ' imaginy-field-prompt' : '');
        applyStyles(wrap, {
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            // Промпт забирает всю свободную высоту: окно теперь во весь экран, и поле
            // на фиксированные 8 строк посреди пустоты выглядело бы нелепо.
            // minHeight здесь НЕ 0: с нулевым минимумом на низком экране блок сжимался
            // сильнее своего содержимого, textarea вылезала за его границы и налезала
            // на подпись следующего поля («Стиль»). Живой минимум = подпись + textarea,
            // а лишнее уводится в прокрутку тела модалки (у него overflow-y: auto).
            ...(field.key === 'prompt' ? { flex: '1 1 auto', minHeight: '124px' } : { flex: '0 0 auto' }),
        });

        const labelRow = document.createElement('div');
        labelRow.className = 'imaginy-field-label-row';
        applyStyles(labelRow, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' });

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

        // Значение выставляем через .value / .textContent, а не интерполяцией в
        // HTML-строку — пользовательские/модельные данные не должны никогда попадать
        // в innerHTML.
        const existing = data?.[field.key];
        let existingValue = typeof existing === 'string' ? existing : existing != null ? String(existing) : '';

        // Стиль в инструкции есть далеко не всегда (SLAY кладёт его только когда модель
        // выдала [style: ...]), а пользователю он нужен один и тот же от картинки к
        // картинке и от чата к чату. Поэтому в пустое поле подставляем последний
        // сохранённый стиль — с явной подписью, чтобы подстановка не была молчаливой.
        const styleFromMemory = field.key === 'style' && !existingValue.trim() && lastStyle.trim().length > 0;
        if (styleFromMemory) existingValue = lastStyle;

        let input;
        if (field.kind === 'textarea') {
            input = document.createElement('textarea');
            input.rows = field.rows;
        } else if (field.kind === 'select') {
            input = document.createElement('select');
            // Пустое значение = ключа в инструкции нет; хост тогда берёт свою настройку
            // либо '1:1' (во всех четырёх хостах это одно и то же выражение
            // options.aspectRatio || settings.aspectRatio || '1:1').
            const choices = ['', ...aspectCtx.choices];
            // Значение из инструкции может быть нестандартным (руками правленый JSON) —
            // не теряем его молча, добавляем в список.
            if (existingValue && !choices.includes(existingValue)) choices.push(existingValue);
            for (const value of choices) {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = value === ''
                    ? `Не задано (значение возьмёт ${host.name})`
                    : value;
                input.appendChild(opt);
            }
        } else {
            input = document.createElement('input');
            input.type = 'text';
        }
        input.value = existingValue;
        applyStyles(input, {
            width: '100%',
            boxSizing: 'border-box',
            ...(field.key === 'prompt' ? { flex: '1 1 auto', minHeight: '96px', resize: 'vertical' } : {}),
        });
        input.addEventListener('input', () => {
            dirty = true;
        });
        input.addEventListener('focus', () => {
            focusedKey = field.key;
            // Клавиатура всплывает не мгновенно: пересобираем раскладку и сразу (по
            // текущим размерам), и по событию visualViewport, когда она доедет.
            applyLayout();
        });
        if (field.autofocus) {
            queueMicrotask(() => {
                // На сенсорном устройстве фокус сразу поднимает экранную клавиатуру, и
                // окно открывается уже наполовину закрытым — даже если пользователь
                // зашёл прочитать промпт или нажать «Перегенерировать». Там курсор
                // ставится по тапу, а не за пользователя.
                if (hasTouchInput()) return;
                input.focus();
                // Курсор по умолчанию встаёт в конец подставленного текста, и длинный
                // промпт открывается прокрученным на последнюю строку. Начало читать
                // удобнее — тем более в невысоком окне.
                try {
                    input.setSelectionRange(0, 0);
                } catch (err) {
                    logWarn('openEditor: не удалось поставить курсор в начало', err);
                }
                input.scrollTop = 0;
            });
        }

        inputs[field.key] = input;
        wraps[field.key] = wrap;
        wrap.appendChild(input);

        // Стиль из инструкции доходит до генерации только когда глобальный стиль хоста
        // не выбран: иначе он перекрывает per-image значение целиком, до всех API-путей
        // (у форков sillyimages это resolveEffectiveStyle; см. src/hostquirks.js).
        if (field.key === 'style' && styleCtx.overridden) {
            wrap.appendChild(createHintRow(
                `В ${host.name} выбран стиль «${styleCtx.name}» — он перекроет любой стиль, вписанный здесь.`,
                {
                    label: 'Сбросить стиль хоста',
                    onClick: (row) => {
                        if (clearHostStyle()) {
                            row.remove();
                            toast('success', `Глобальный стиль ${host.name} сброшен — теперь применяется стиль из инструкции`);
                        } else {
                            toast('error', `Не удалось изменить настройку ${host.name} — сбросьте стиль вручную в его панели`);
                        }
                    },
                },
            ));
        }

        if (styleFromMemory) {
            wrap.appendChild(createHintRow('Подставлен последний использованный стиль.', {
                label: 'Забыть',
                onClick: (row) => {
                    input.value = '';
                    dirty = true;
                    try {
                        const s = getSettings();
                        s.lastStyle = '';
                        saveSettings();
                        refreshLastStyleField();
                    } catch (err) {
                        logWarn('openEditor: не удалось забыть стиль', err);
                    }
                    row.remove();
                    input.focus();
                },
            }));
        }

        // Соотношение сторон из инструкции доходит до генерации только тогда, когда
        // глобальная настройка хоста стоит в «Из промпта» (auto) — иначе хост подставит
        // своё значение и правка тихо ни на что не повлияет. Квирк есть только у SLAY:
        // у трёх форков per-image значение в приоритете, и предупреждения не будет
        // (src/hostquirks.js).
        if (field.key === 'aspect_ratio' && aspectCtx.overridden) {
            wrap.appendChild(createHintRow(
                `В настройках ${host.name} жёстко задано «${aspectCtx.global}» — это значение перекроет любое выбранное здесь.`,
                {
                    label: 'Переключить на «Из промпта»',
                    onClick: (row) => {
                        if (setAspectRatioFromPrompt()) {
                            row.remove();
                            toast('success', `${host.name} переключён на «Из промпта» — соотношение теперь берётся из инструкции`);
                        } else {
                            toast('error', `Не удалось изменить настройку ${host.name} — переключите вручную в его панели`);
                        }
                    },
                },
            ));
        }

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

    // Короткие подписи для компактного режима: три кнопки в столбик вместе с подсказкой
    // о горячих клавишах съедали на телефоне со всплывшей клавиатурой около 190 px —
    // больше, чем оставалось самому промпту.
    const SHORT_LABELS = new Map([
        [btnSave, 'Сохранить'],
        [btnSaveRegen, 'Сохр. + реген.'],
        [btnCancel, 'Отмена'],
    ]);
    const FULL_LABELS = new Map([...SHORT_LABELS.keys()].map((b) => [b, b.textContent]));

    // Всплывшая клавиатура на Android ужимает вьюпорт, на iOS — не ужимает, а сдвигает
    // видимую область вверх (layout viewport остаётся прежним, поэтому 100dvh там врёт).
    // visualViewport описывает оба случая честно, поэтому оверлей сажаем прямо на него,
    // а 100dvh/100vh остаются фолбэком для движков без этого API.
    const vv = window.visualViewport ?? null;

    pickMountRoot().appendChild(overlay);
    applyLayout();
    // Клавиатура, поворот экрана, сворачивание адресной строки, разделённый экран,
    // раскладывающийся телефон — всё это приходит одними и теми же событиями. Слушаем
    // все: какое из них сработает на конкретном устройстве, заранее не известно.
    vv?.addEventListener('resize', requestLayout);
    vv?.addEventListener('scroll', requestLayout);
    window.addEventListener('resize', requestLayout);
    window.addEventListener('orientationchange', requestLayout);

    // Высота строки в поле промпта — единица измерения для всех порогов раскладки.
    function lineHeight() {
        try {
            const cs = getComputedStyle(inputs.prompt);
            const line = parseFloat(cs.lineHeight);
            if (Number.isFinite(line) && line > 0) return line;
            const font = parseFloat(cs.fontSize);
            // line-height: normal вычисляется в 'normal', числом его не получить —
            // берём типовой множитель от размера шрифта.
            if (Number.isFinite(font) && font > 0) return font * 1.35;
        } catch (err) {
            logWarn('applyLayout: не удалось измерить высоту строки', err);
        }
        return FALLBACK_LINE_HEIGHT;
    }

    // Пальцем по экрану — значит, ввод идёт с экранной клавиатуры. Нужно только для
    // фолбэка ниже: на устройстве с мышью гадать про клавиатуру не надо.
    function hasTouchInput() {
        try {
            return window.matchMedia?.('(pointer: coarse)').matches === true;
        } catch (err) {
            return false;
        }
    }

    // Геометрия видимой области и режим раскладки. Единственное место, где расширение
    // судит о размерах экрана, — и судит по измерению, а не по модели устройства.
    function measureViewport() {
        const line = lineHeight();
        const width = vv?.width ?? window.innerWidth;
        let height = vv?.height ?? window.innerHeight;
        let assumedKeyboard = false;
        if (!vv && hasTouchInput() && document.activeElement?.closest?.('.imaginy-modal')) {
            // Движок не показывает, что клавиатура всплыла (нет visualViewport), но поле
            // в фокусе и ввод сенсорный — значит, часть экрана она уже занимает. Без
            // этой поправки окно раскладывалось бы по всей высоте, а кнопки внизу
            // оказались бы под клавиатурой и до них было бы не достать.
            height = Math.round(height * ASSUMED_KEYBOARD_FREE_SHARE);
            assumedKeyboard = true;
        }
        return {
            width,
            height,
            assumedKeyboard,
            offsetTop: vv?.offsetTop ?? 0,
            offsetLeft: vv?.offsetLeft ?? 0,
            narrow: width <= 600,
            // Двухступенчато: сначала ужимается обвязка окна, и только если места мало
            // даже с ней — сворачиваются поля, которые сейчас не правят.
            compact: height < line * ROOMY_LINES,
            focusPriority: height < line * FOCUS_LINES,
        };
    }

    // Единственное место, где решается, как окно разложено. Зовётся при открытии, при
    // каждом изменении видимой области (клавиатура, поворот, адресная строка) и при
    // переходе фокуса между полями.
    function applyLayout() {
        if (settled) return;
        const view = measureViewport();
        const { narrow, compact } = view;

        if (vv) {
            applyStyles(overlay, {
                top: `${view.offsetTop}px`,
                left: `${view.offsetLeft}px`,
                width: `${view.width}px`,
                height: `${view.height}px`,
            });
        } else if (view.assumedKeyboard) {
            // Клавиатура посчитана «на глаз» — тогда и окно поднимаем над ней вручную,
            // иначе нижние кнопки останутся под ней.
            overlay.style.height = `${view.height}px`;
        } else {
            // Ни visualViewport, ни клавиатуры: возвращаем размер по вьюпорту. 100dvh
            // учитывает свернувшуюся адресную строку, 100vh — фолбэк для движков без dvh
            // (строка со 100vh остаётся в силе, если dvh не понят).
            overlay.style.height = '100vh';
            overlay.style.height = '100dvh';
        }
        applyStyles(overlay, { padding: compact ? '0' : narrow ? '8px' : '16px' });

        applyStyles(modal, {
            maxWidth: narrow ? '100%' : '720px',
            height: narrow ? '100%' : 'auto',
            // Проценты, а не vh: оверлей теперь и есть видимая область, а vh на телефоне
            // со всплывшей клавиатурой считается от полного экрана и промахивается.
            maxHeight: narrow ? '100%' : '85%',
            // Компактный режим = места и так в обрез: минимум в 120 px тут только мешал бы
            // ужаться, а рамка и скругления крадут ещё несколько строк.
            minHeight: compact ? '0' : '120px',
            borderRadius: narrow || compact ? '0' : '8px',
        });
        modal.classList.toggle('imaginy-compact', compact);

        applyStyles(header, compact
            ? { padding: '6px 12px', fontSize: '0.9em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
            : { padding: '12px 16px', fontSize: '', whiteSpace: '', overflow: '', textOverflow: '' });

        applyStyles(body, compact
            ? { padding: '8px 12px', gap: '8px' }
            : { padding: '12px 16px', gap: '12px' });

        // В компактном режиме подсказка про Ctrl+Enter не нужна вдвойне: места нет, а
        // физической клавиатуры у телефона обычно тоже.
        hint.style.display = compact ? 'none' : '';
        applyStyles(footer, compact
            ? { flexDirection: 'row', alignItems: 'stretch', padding: '8px 12px', gap: '6px' }
            : narrow
                ? { flexDirection: 'column', alignItems: 'stretch', padding: '12px 16px', gap: '8px' }
                : { flexDirection: 'row', alignItems: '', padding: '12px 16px', gap: '8px' });
        for (const [btn, short] of SHORT_LABELS) {
            btn.textContent = compact ? short : FULL_LABELS.get(btn);
            applyStyles(btn, compact
                ? { flex: '1 1 0', minWidth: '0', padding: '8px 4px', fontSize: '0.85em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
                : { flex: '', minWidth: '', padding: '', fontSize: '', whiteSpace: '', overflow: '', textOverflow: '' });
        }

        // Поля. Пока места хватает — всё как раньше: промпт тянется, остальные по
        // содержимому. Когда его мало, высоту получает то поле, которое правят прямо
        // сейчас, а соседние сжимаются до подписи и двух строк — они никуда не деваются,
        // их видно и можно открыть тапом, но они больше не съедают экран у того, что
        // редактируется.
        const expandedKey = view.focusPriority ? (focusedKey || 'prompt') : 'prompt';
        for (const field of FIELDS) {
            const wrap = wraps[field.key];
            const input = inputs[field.key];
            if (!wrap || !input) continue;
            const expanded = field.key === expandedKey;
            const isTextarea = field.kind === 'textarea';

            if (!view.focusPriority) {
                if (isTextarea) input.rows = field.rows;
                applyStyles(wrap, field.key === 'prompt'
                    ? { flex: '1 1 auto', minHeight: '124px' }
                    : { flex: '0 0 auto', minHeight: '' });
                applyStyles(input, field.key === 'prompt'
                    ? { flex: '1 1 auto', minHeight: '96px', height: '' }
                    : { flex: '', minHeight: '', height: '' });
                continue;
            }

            // Свёрнутое поле — ровно две строки. Высоту задаём через rows, а не через
            // height в em: реальная высота строки и внутренние отступы textarea зависят
            // от темы ST, а rows считает их сам и не режет строку пополам.
            if (isTextarea) {
                input.rows = expanded ? field.rows : 2;
                // Свёрнутое поле показывает начало текста, а не то место, где его
                // застала прокрутка: иначе превью открывается с середины слова.
                if (!expanded) input.scrollTop = 0;
            }
            // minHeight здесь именно '0', а не пустая строка: очистка инлайна вернула бы
            // в силу min-height из style.css (.imaginy-field-prompt — 124px, textarea —
            // 96px), и свёрнутое поле продолжило бы занимать высоту развёрнутого.
            applyStyles(wrap, expanded && isTextarea
                ? { flex: '1 1 auto', minHeight: '84px' }
                : { flex: '0 0 auto', minHeight: '0' });
            applyStyles(input, expanded && isTextarea
                ? { flex: '1 1 auto', minHeight: '60px', height: '' }
                : isTextarea
                    ? { flex: '0 0 auto', minHeight: '0', height: 'auto' }
                    : { flex: '', minHeight: '0', height: '' });
        }

        // Тело модалки прокручиваемое: если поля всё же не поместились (совсем низкий
        // экран в альбомной ориентации), развёрнутое поле надо показать целиком. Делаем
        // это только при смене поля, а не на каждое дрожание вьюпорта.
        if (expandedKey !== shownKey) {
            shownKey = expandedKey;
            try {
                wraps[expandedKey]?.scrollIntoView?.({ block: 'nearest' });
            } catch (err) {
                logWarn('applyLayout: не удалось прокрутить к активному полю', err);
            }
        }
    }

    // События вьюпорта на телефоне приходят пачками (клавиатура выезжает анимацией):
    // склеиваем их в один пересчёт на кадр, чтобы не грузить слабые устройства.
    function requestLayout() {
        if (layoutQueued) return;
        layoutQueued = true;
        const run = () => {
            layoutQueued = false;
            applyLayout();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 0);
    }

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
                // для хоста отсутствие ключа и пустая строка не одно и то же, поэтому
                // пустые значения в JSON не пишем.
                delete result[field.key];
            }
            // Пусто и ключа не было — ничего не делаем, ключ остаётся отсутствующим.
        }
        return result;
    }

    function cleanup() {
        vv?.removeEventListener('resize', requestLayout);
        vv?.removeEventListener('scroll', requestLayout);
        window.removeEventListener('resize', requestLayout);
        window.removeEventListener('orientationchange', requestLayout);
        document.removeEventListener('keydown', onKeydown, true);
        overlay.removeEventListener('mousedown', onBackdropMouseDown);
        overlay.remove();
        modalOpen = false;
    }

    function settle(value) {
        if (settled) return;
        settled = true;
        if (pendingSettle === settle) pendingSettle = null;
        try {
            cleanup();
        } finally {
            resolve(value);
        }
    }

    // Запоминаем только непустой стиль: очистка поля означает «у этой картинки стиля
    // нет», а не «забудь мой стиль навсегда» (для этого есть кнопка «Забыть»).
    function rememberStyle() {
        const value = (inputs.style?.value ?? '').trim();
        if (!value) return;
        try {
            const s = getSettings();
            if (s.lastStyle === value) return;
            s.lastStyle = value;
            saveSettings();
            refreshLastStyleField();
        } catch (err) {
            logWarn('openEditor: не удалось запомнить стиль', err);
        }
    }

    function doSave(action) {
        rememberStyle();
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
