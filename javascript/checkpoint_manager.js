/* Checkpoint Manager: Extra Networks の Checkpoints タブにチェック選択・移動・削除・連続生成を追加する */
(function () {
    const TABS = ['txt2img', 'img2img'];
    const selected = new Set(); // checkpoint のタイトル (sd_models.checkpoints_list のキー)。クリック順を保持
    let lastClicked = null;

    function apiUrl(path) {
        const root = ((window.gradio_config && window.gradio_config.root) || '').replace(/\/$/, '');
        return root + '/ckptmgr' + path;
    }

    async function api(path, body) {
        const res = await fetch(apiUrl(path), {
            method: body ? 'POST' : 'GET',
            headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ckptmgr'},
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    function app() {
        return typeof gradioApp === 'function' ? gradioApp() : document;
    }

    function cardTitle(card) {
        // onclick="return selectCheckpoint("name")" の name が一意なタイトル (data-name はサブフォルダ違いで重複する)
        const m = (card.getAttribute('onclick') || '').match(/selectCheckpoint\((".*")\)/);
        if (m) {
            try {
                return JSON.parse(m[1]);
            } catch (e) { /* fallthrough */ }
        }
        return card.dataset.name || null;
    }

    function allCards(tab) {
        return Array.from(app().querySelectorAll('#' + tab + '_checkpoints_pane .card'));
    }

    function setValue(el, value) {
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event('input', {bubbles: true}));
    }

    // ---- 選択状態を画面と生成用テキストボックスに反映 ----
    function syncAll() {
        const text = Array.from(selected).join('\n');
        TABS.forEach(function (tab) {
            const ta = app().querySelector('#ckptmgr_selected_' + tab + ' textarea');
            if (ta && ta.value !== text) setValue(ta, text);

            allCards(tab).forEach(function (card) {
                const t = cardTitle(card);
                const cb = card.querySelector('.ckptmgr-check input');
                const on = t !== null && selected.has(t);
                if (cb && cb.checked !== on) cb.checked = on;
                const lb = card.querySelector('.ckptmgr-check');
                if (lb) lb.classList.toggle('ckptmgr-on', on);
                card.classList.toggle('ckptmgr-selected', on);
            });

            const label = app().querySelector('#' + tab + '_checkpoints_pane .ckptmgr-count');
            // 同じ値でも textContent への代入は DOM 変更扱いになり、onUiUpdate が無限に再発火するため差分があるときだけ書く
            const countText = selected.size + ' 件選択中';
            if (label && label.textContent !== countText) label.textContent = countText;
        });
    }

    function toggle(title, on) {
        if (on) selected.add(title);
        else selected.delete(title);
    }

    // ---- カードへのチェックボックス追加 ----
    function decorateCards(tab) {
        const cards = allCards(tab);
        cards.forEach(function (card) {
            if (card.querySelector('.ckptmgr-check')) return;
            const label = document.createElement('label');
            label.className = 'ckptmgr-check';
            label.title = 'クリックで選択 / Shiftで範囲選択';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            label.appendChild(cb);
            const mark = document.createElement('span');
            mark.className = 'ckptmgr-mark';
            mark.textContent = '✓';
            label.appendChild(mark);
            // カード本体のクリック (= Checkpoint切替) を発火させない
            ['click', 'mousedown', 'mouseup'].forEach(function (ev) {
                label.addEventListener(ev, function (e) {
                    e.stopPropagation();
                });
            });
            cb.addEventListener('click', function (e) {
                const title = cardTitle(card);
                if (title === null) return;
                if (e.shiftKey && lastClicked !== null) {
                    const list = allCards(tab).filter(function (c) {
                        return c.offsetParent !== null;
                    });
                    const a = list.findIndex(function (c) { return cardTitle(c) === lastClicked; });
                    const b = list.findIndex(function (c) { return c === card; });
                    if (a >= 0 && b >= 0) {
                        list.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (c) {
                            toggle(cardTitle(c), cb.checked);
                        });
                    }
                } else {
                    toggle(title, cb.checked);
                }
                lastClicked = title;
                syncAll();
            });
            card.appendChild(label);
        });
    }

    // ---- ダイアログ ----
    function dialog(title, bodyNodes, buttons) {
        const overlay = document.createElement('div');
        overlay.className = 'ckptmgr-overlay';
        const box = document.createElement('div');
        box.className = 'ckptmgr-dialog';
        const h = document.createElement('h3');
        h.textContent = title;
        box.appendChild(h);
        bodyNodes.forEach(function (n) { box.appendChild(n); });
        const row = document.createElement('div');
        row.className = 'ckptmgr-buttons';
        buttons.forEach(function (b) {
            const btn = document.createElement('button');
            btn.textContent = b.label;
            btn.className = 'lg secondary gradio-button ckptmgr-btn' + (b.danger ? ' ckptmgr-danger' : '');
            btn.addEventListener('click', function () {
                if (b.onclick) b.onclick(close);
                else close();
            });
            row.appendChild(btn);
        });
        box.appendChild(row);
        overlay.appendChild(box);
        overlay.addEventListener('mousedown', function (e) {
            if (e.target === overlay) close();
        });
        document.body.appendChild(overlay);
        function close() {
            overlay.remove();
        }
        return {close: close, box: box};
    }

    function p(text, cls) {
        const el = document.createElement('p');
        el.textContent = text;
        if (cls) el.className = cls;
        return el;
    }

    function nameList(titles) {
        const ul = document.createElement('ul');
        ul.className = 'ckptmgr-list';
        titles.forEach(function (t) {
            const li = document.createElement('li');
            li.textContent = t;
            ul.appendChild(li);
        });
        return ul;
    }

    function refreshTab(tab) {
        const btn = app().getElementById(tab + '_checkpoints_extra_refresh_internal');
        if (btn) btn.dispatchEvent(new Event('click'));
        // model dropdown も更新
        const dd = app().getElementById('refresh_sd_model_checkpoint');
        if (dd) dd.click();
    }

    function showResult(res, tab) {
        const nodes = [];
        if (res.ok && res.ok.length) nodes.push(p('完了: ' + res.ok.length + ' 件'));
        if (res.errors && res.errors.length) {
            nodes.push(p('エラー:', 'ckptmgr-error'));
            nodes.push(nameList(res.errors));
        }
        res.ok.forEach(function (t) { selected.delete(t); });
        dialog('結果', nodes, [{label: '閉じる'}]);
        refreshTab(tab);
        // 名前(タイトル)が変わるので、選択状態は解除する
        selected.clear();
        syncAll();
    }

    function requireSelection() {
        if (selected.size === 0) {
            dialog('Checkpoint Manager', [p('Checkpoint を1つ以上チェックしてください。')], [{label: '閉じる'}]);
            return false;
        }
        return true;
    }

    async function onMove(tab) {
        if (!requireSelection()) return;
        let info;
        try {
            info = await api('/folders');
        } catch (e) {
            dialog('エラー', [p(String(e))], [{label: '閉じる'}]);
            return;
        }
        const titles = Array.from(selected);
        const sel = document.createElement('select');
        sel.className = 'ckptmgr-input';
        const optRoot = document.createElement('option');
        optRoot.value = '';
        optRoot.textContent = '(ルート)';
        sel.appendChild(optRoot);
        info.folders.forEach(function (f) {
            const o = document.createElement('option');
            o.value = f;
            o.textContent = f;
            sel.appendChild(o);
        });
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ckptmgr-input';
        input.placeholder = '新しいフォルダ名 (例: anime/v5)。入力するとこちらを優先';

        dialog(titles.length + ' 件を移動', [
            nameList(titles),
            p('移動先フォルダ (' + info.root + ' 以下)'),
            sel,
            input,
            p('同名の付随ファイル (プレビュー画像 / .yaml / .json など) も一緒に移動します。', 'ckptmgr-note'),
        ], [
            {label: 'キャンセル'},
            {
                label: '移動する',
                onclick: async function (close) {
                    try {
                        const res = await api('/move', {names: titles, folder: input.value.trim() || sel.value});
                        close();
                        showResult(res, tab);
                    } catch (e) {
                        close();
                        dialog('エラー', [p(String(e))], [{label: '閉じる'}]);
                    }
                },
            },
        ]);
    }

    function onDelete(tab) {
        if (!requireSelection()) return;
        const titles = Array.from(selected);
        const mk = function (value, text, checked) {
            const l = document.createElement('label');
            l.className = 'ckptmgr-radio';
            const r = document.createElement('input');
            r.type = 'radio';
            r.name = 'ckptmgr_del_mode';
            r.value = value;
            r.checked = checked;
            l.appendChild(r);
            l.appendChild(document.createTextNode(' ' + text));
            return l;
        };
        const trash = mk('trash', 'ゴミ箱フォルダへ退避 (models/stable-diffusion-trash。後で戻せる)', true);
        const perm = mk('perm', '完全に削除 (元に戻せません)', false);
        dialog(titles.length + ' 件を削除', [nameList(titles), trash, perm], [
            {label: 'キャンセル'},
            {
                label: '削除する',
                danger: true,
                onclick: async function (close) {
                    const permanent = perm.querySelector('input').checked;
                    try {
                        const res = await api('/delete', {names: titles, permanent: permanent});
                        close();
                        showResult(res, tab);
                    } catch (e) {
                        close();
                        dialog('エラー', [p(String(e))], [{label: '閉じる'}]);
                    }
                },
            },
        ]);
    }

    function showGenerationTab(tab) {
        const buttons = Array.from(app().querySelectorAll('#' + tab + '_extra_tabs > div.tab-nav > button'));
        const btn = buttons.find(function (b) { return b.textContent.trim() === 'Generation'; }) || buttons[0];
        if (btn) btn.click();
    }

    function onGenerate(tab) {
        if (!requireSelection()) return;
        const cb = app().querySelector('#ckptmgr_enable_' + tab + ' input[type=checkbox]');
        const gen = app().getElementById(tab + '_generate');
        if (!cb || !gen) return;
        syncAll();
        showGenerationTab(tab);
        cb.checked = true;
        cb.dispatchEvent(new Event('input', {bubbles: true}));
        cb.dispatchEvent(new Event('change', {bubbles: true}));
        // 入力値の反映を待ってから Generate。送信後は誤爆しないようチェックを戻す
        setTimeout(function () {
            gen.click();
            setTimeout(function () {
                cb.checked = false;
                cb.dispatchEvent(new Event('input', {bubbles: true}));
                cb.dispatchEvent(new Event('change', {bubbles: true}));
            }, 1500);
        }, 200);
    }

    // ---- ツールバー ----
    function button(text, title, handler, cls) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.title = title;
        b.className = 'lg secondary gradio-button ckptmgr-btn ' + (cls || '');
        b.addEventListener('click', handler);
        return b;
    }

    function buildToolbar(tab) {
        const bar = document.createElement('div');
        bar.className = 'ckptmgr-toolbar';
        bar.appendChild(button('全選択', '表示中のCheckpointをすべて選択', function () {
            allCards(tab).forEach(function (c) {
                if (c.offsetParent !== null && cardTitle(c)) selected.add(cardTitle(c));
            });
            syncAll();
        }));
        bar.appendChild(button('全解除', '選択をすべて解除', function () {
            selected.clear();
            syncAll();
        }));
        const count = document.createElement('span');
        count.className = 'ckptmgr-count';
        count.textContent = '0 件選択中';
        bar.appendChild(count);
        const spacer = document.createElement('span');
        spacer.className = 'ckptmgr-spacer';
        bar.appendChild(spacer);
        bar.appendChild(button('▶ 選択したCheckpointで連続生成', '現在の設定・Seedのまま、選択したCheckpointで順に生成', function () { onGenerate(tab); }, 'ckptmgr-primary'));
        bar.appendChild(button('📁 移動', '選択したCheckpointをサブフォルダへ移動', function () { onMove(tab); }));
        bar.appendChild(button('🗑 削除', '選択したCheckpointを削除', function () { onDelete(tab); }, 'ckptmgr-danger'));
        return bar;
    }

    function setup() {
        TABS.forEach(function (tab) {
            const pane = app().getElementById(tab + '_checkpoints_pane');
            if (!pane) return;
            if (!pane.querySelector(':scope > .ckptmgr-toolbar')) {
                pane.insertBefore(buildToolbar(tab), pane.firstChild);
            }
            decorateCards(tab);
        });
        syncAll();
    }

    // UI 更新のたびに走るので、まとめて少し間引いて実行する
    let scheduled = false;
    function scheduleSetup() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function () {
            scheduled = false;
            setup();
        }, 150);
    }

    if (typeof onUiUpdate === 'function') {
        onUiUpdate(scheduleSetup);
    } else {
        setInterval(setup, 1000);
    }
})();
