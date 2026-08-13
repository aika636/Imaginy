// Тест синхронизации путей к картинкам (src/srcsync.js) под jsdom.
//
// Запуск из корня репозитория:
//   npm install --no-save jsdom
//   node tests/srcsync.test.mjs
//
// Воспроизводит жалобу пользователя: перегенерированная картинка после перезагрузки
// страницы возвращается к самой первой генерации. Причина — хост при перегенерации
// всего сообщения пишет новый путь только в message.mes (upstream index.js:4604), а
// SillyTavern перерисовывает сообщение из любого из шести мест хранения.
import { JSDOM } from 'jsdom';

const SRC = new URL('../src/', import.meta.url).pathname;

const dom = new JSDOM('<body><div id="chat"></div></body>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;
global.MutationObserver = dom.window.MutationObserver;

let chat = [];
global.SillyTavern = {
    getContext: () => ({
        chat,
        extensionSettings: {},
        eventSource: { on() {} },
        event_types: {},
        async saveChat() {},
        saveChatDebounced() {},
    }),
};

const {
    reconcileMessage, reconcileChat, reconcileChatWhenVisible, mirrorMessage,
    generatedSrcsInText, applySrcByIndex,
} = await import(`${SRC}srcsync.js`);
const { replaceSrcEverywhere } = await import(`${SRC}persist.js`);

const results = [];
function check(name, actual, expected) {
    results.push({ name, ok: actual === expected, actual, expected });
}

const INSTR = `data-iig-instruction='{"prompt":"a cat","style":"anime"}'`;
const OLD = 'user/images/gen/iig_first.png';
const NEW = 'user/images/gen/iig_reroll.png';
const tag = (src) => `<img ${INSTR} src="${src}">`;

// ── 1. Разбор текста ───────────────────────────────────────────────────────────
{
    const text = `Текст ${tag(OLD)} ещё ${tag(NEW)} конец`;
    const srcs = generatedSrcsInText(text);
    check('разбор: найдено две картинки', srcs.length, 2);
    check('разбор: первый путь', srcs[0], OLD);
    check('разбор: второй путь', srcs[1], NEW);
    // Чужая картинка без инструкции хоста в счёт не идёт.
    check('разбор: посторонний img игнорируется',
        generatedSrcsInText(`<img src="avatar.png"> ${tag(OLD)}`).length, 1);
    check('разбор: текст без картинок', generatedSrcsInText('просто текст').length, 0);
}

// ── 2. Замена по индексу ───────────────────────────────────────────────────────
{
    const text = `${tag(OLD)} и ${tag(OLD)}`;
    const out = applySrcByIndex(text, [NEW, OLD]);
    const srcs = generatedSrcsInText(out);
    check('по индексу: первая заменена', srcs[0], NEW);
    check('по индексу: вторая не тронута', srcs[1], OLD);
    check('по индексу: инструкция уцелела', out.includes(INSTR), true);
}

// ── 3. Главный сценарий: хост обновил только mes ───────────────────────────────
// Ровно то, что делает upstream regenerateMessageImages. До сверки перезагрузка
// страницы возвращала бы OLD из display_text / extblocks / swipes[swipe_id].
{
    const message = {
        mes: `Смотри: ${tag(NEW)}`,
        swipe_id: 1,
        swipes: [`другой свайп ${tag(OLD)}`, `Смотри: ${tag(OLD)}`],
        swipe_info: [
            { extra: { display_text: `другой свайп ${tag(OLD)}` } },
            { extra: { display_text: `Смотри: ${tag(OLD)}`, extblocks: `Смотри: ${tag(OLD)}` } },
        ],
        extra: { display_text: `Смотри: ${tag(OLD)}`, extblocks: `Смотри: ${tag(OLD)}` },
    };

    const changed = reconcileMessage(message);

    check('сверка: сообщение изменилось', changed, true);
    check('сверка: display_text', generatedSrcsInText(message.extra.display_text)[0], NEW);
    check('сверка: extblocks', generatedSrcsInText(message.extra.extblocks)[0], NEW);
    check('сверка: swipes[swipe_id]', generatedSrcsInText(message.swipes[1])[0], NEW);
    check('сверка: swipe_info[swipe_id].display_text',
        generatedSrcsInText(message.swipe_info[1].extra.display_text)[0], NEW);
    check('сверка: swipe_info[swipe_id].extblocks',
        generatedSrcsInText(message.swipe_info[1].extra.extblocks)[0], NEW);

    // Чужой свайп — другой текст со своими картинками; трогать его нельзя.
    check('сверка: чужой свайп не тронут', generatedSrcsInText(message.swipes[0])[0], OLD);
    check('сверка: swipe_info чужого свайпа не тронут',
        generatedSrcsInText(message.swipe_info[0].extra.display_text)[0], OLD);
}

// ── 4. Сверка идемпотентна и не трогает согласованное сообщение ────────────────
{
    const message = {
        mes: `Ок ${tag(NEW)}`,
        extra: { display_text: `Ок ${tag(NEW)}` },
    };
    check('сверка: согласованное сообщение не меняется', reconcileMessage(message), false);
}

// ── 5. Разное число картинок — сопоставлять по индексу нельзя ──────────────────
// extblocks может держать только часть картинок сообщения; вслепую подставлять туда
// пути из mes значило бы поменять картинку на чужую.
{
    const message = {
        mes: `${tag(NEW)} и ${tag(NEW)}`,
        extra: { extblocks: `только одна ${tag(OLD)}` },
    };
    check('сверка: поле с другим числом картинок пропущено', reconcileMessage(message), false);
    check('сверка: такое поле осталось прежним',
        generatedSrcsInText(message.extra.extblocks)[0], OLD);
}

// ── 6. Заглушка ошибки не переносится ──────────────────────────────────────────
// error.svg общий для всех неудавшихся генераций — подстрочная замена задела бы всё
// сообщение разом; этот путь хост проставляет во все места сам.
{
    const ERR = '/scripts/extensions/third-party/SLAY/error.svg';
    const message = {
        mes: `Упало ${tag(ERR)}`,
        extra: { display_text: `Упало ${tag(OLD)}` },
    };
    reconcileMessage(message);
    check('сверка: error.svg не переносится',
        generatedSrcsInText(message.extra.display_text)[0], OLD);
}

// ── 7. replaceSrcEverywhere: перенос пути во все места ─────────────────────────
// Половина mirror — то, что применяется, когда смену src поймали в DOM живьём.
{
    const message = {
        mes: `a ${tag(OLD)}`,
        extra: { display_text: `a ${tag(OLD)}`, extblocks: `a ${tag(OLD)}` },
        swipes: [`a ${tag(OLD)}`],
        swipe_info: [{ extra: { display_text: `a ${tag(OLD)}`, extblocks: `a ${tag(OLD)}` } }],
    };

    check('перенос: вернул true', replaceSrcEverywhere(message, OLD, NEW), true);
    check('перенос: mes', generatedSrcsInText(message.mes)[0], NEW);
    check('перенос: display_text', generatedSrcsInText(message.extra.display_text)[0], NEW);
    check('перенос: extblocks', generatedSrcsInText(message.extra.extblocks)[0], NEW);
    check('перенос: swipes', generatedSrcsInText(message.swipes[0])[0], NEW);
    check('перенос: swipe_info.display_text',
        generatedSrcsInText(message.swipe_info[0].extra.display_text)[0], NEW);
    check('перенос: swipe_info.extblocks',
        generatedSrcsInText(message.swipe_info[0].extra.extblocks)[0], NEW);
    check('перенос: повторный вызов ничего не меняет',
        replaceSrcEverywhere(message, OLD, NEW), false);
}

// ── 8. reconcileChat чинит и DOM ───────────────────────────────────────────────
// ST отрисовал сообщение из испорченного места хранения: в чате уже NEW, а на экране
// всё ещё OLD. Без починки DOM пользователь до перезагрузки видит старую картинку.
{
    chat = [{
        mes: `Смотри: ${tag(NEW)}`,
        extra: { display_text: `Смотри: ${tag(OLD)}` },
    }];
    document.getElementById('chat').innerHTML = `
        <div class="mes" mesid="0"><div class="mes_text">${tag(OLD)}</div></div>`;

    reconcileChat();

    check('чат: display_text починен',
        generatedSrcsInText(chat[0].extra.display_text)[0], NEW);
    check('чат: картинка в DOM починена',
        document.querySelector('#chat img[data-iig-instruction]').getAttribute('src'), NEW);
}

// ── 9. mirror: перегенерация, пойманная живьём ─────────────────────────────────
// Три такта, как их видит наблюдатель при перегенерации всего сообщения: картинка ->
// плейсхолдер без инструкции -> новая картинка. Снимок обязан пережить средний такт,
// иначе старый путь потеряется и сопоставить его с новым будет нечем.
{
    chat = [{
        mes: `Смотри: ${tag(OLD)}`,
        extra: { display_text: `Смотри: ${tag(OLD)}` },
        swipes: [`Смотри: ${tag(OLD)}`],
        swipe_id: 0,
    }];
    const chatEl = document.getElementById('chat');
    chatEl.innerHTML = `<div class="mes" mesid="0"><div class="mes_text">${tag(OLD)}</div></div>`;
    const mesEl = chatEl.querySelector('.mes');
    const mesTextEl = mesEl.querySelector('.mes_text');

    check('mirror: первый проход только снимает состояние', mirrorMessage(mesEl), false);

    mesTextEl.innerHTML = '<div class="iig-loading-placeholder">Генерация…</div>';
    check('mirror: во время генерации ничего не пишем', mirrorMessage(mesEl), false);

    mesTextEl.innerHTML = tag(NEW);
    check('mirror: новая картинка перенесена', mirrorMessage(mesEl), true);
    check('mirror: mes', generatedSrcsInText(chat[0].mes)[0], NEW);
    check('mirror: display_text', generatedSrcsInText(chat[0].extra.display_text)[0], NEW);
    check('mirror: swipes', generatedSrcsInText(chat[0].swipes[0])[0], NEW);
    check('mirror: повторный проход без изменений', mirrorMessage(mesEl), false);
}

// ── 10. Скрытая вкладка: сверка ждёт возвращения ───────────────────────────────
// В скрытой вкладке чинить нечего: DOM никто не видит, а таймеры фоновой вкладки
// браузер и так душит. Работа должна не пропасть, а дождаться visibilitychange.
{
    let visibility = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
    Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => visibility === 'hidden',
    });

    const broken = () => ({
        mes: `Смотри: ${tag(NEW)}`,
        extra: { display_text: `Смотри: ${tag(OLD)}` },
    });

    chat = [broken()];
    reconcileChatWhenVisible();
    check('скрытая вкладка: сверка не выполнена',
        generatedSrcsInText(chat[0].extra.display_text)[0], OLD);

    // Второй вызов, пока вкладка всё ещё скрыта: слушатель должен остаться один,
    // иначе на возвращении сверка прошла бы столько раз, сколько было CHAT_CHANGED.
    reconcileChatWhenVisible();

    visibility = 'visible';
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    check('возвращение на вкладку: сверка выполнена',
        generatedSrcsInText(chat[0].extra.display_text)[0], NEW);

    // Слушатель снят: следующее visibilitychange не должно тянуть за собой сверку.
    chat = [broken()];
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    check('слушатель снят: повторное событие сверку не запускает',
        generatedSrcsInText(chat[0].extra.display_text)[0], OLD);

    // Видимая вкладка — сверка идёт сразу, без ожидания события.
    reconcileChatWhenVisible();
    check('видимая вкладка: сверка выполнена сразу',
        generatedSrcsInText(chat[0].extra.display_text)[0], NEW);
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ожидалось ${JSON.stringify(r.expected)}, получено ${JSON.stringify(r.actual)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок прошло`);
process.exit(failed ? 1 : 0);
