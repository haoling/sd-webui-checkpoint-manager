"""Checkpoint Manager

Extra Networks の「Checkpoints」タブに次の機能を追加する拡張機能。

* 複数 checkpoint のチェック選択
* 選択した checkpoint を models/stable-diffusion のサブフォルダへ移動
* 選択した checkpoint の削除 (既定はゴミ箱フォルダへ退避)
* 選択した checkpoint で、同じ設定・同じ Seed の画像を連続生成

画面側は javascript/checkpoint_manager.js、サーバー側 (ファイル操作 API と連続生成)
はこのファイルで実装している。
"""

import copy
import os
import shutil
import time

import gradio as gr

from modules import script_callbacks, scripts, shared, sd_models, processing

API_PREFIX = "/ckptmgr"
REQUEST_HEADER = "x-requested-with"
REQUEST_HEADER_VALUE = "ckptmgr"

MODEL_EXTS = (".ckpt", ".safetensors")

# checkpoint と同じ名前 (拡張子違い) で置かれる付随ファイル
SIDECAR_SUFFIXES = (
    ".yaml", ".yml", ".json", ".metadata.json", ".txt", ".info", ".civitai.info",
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".preview.png", ".preview.jpg", ".preview.jpeg", ".preview.webp", ".preview.gif",
)


def log(msg):
    print(f"[Checkpoint Manager] {msg}")


# ---------------------------------------------------------------------------
# パス関連
# ---------------------------------------------------------------------------

def checkpoint_roots():
    """checkpoint を置いているルートフォルダ (CheckpointInfo の名前計算と同じ優先順位)"""
    roots = []
    for r in (shared.cmd_opts.ckpt_dir, sd_models.model_path):
        if r:
            r = os.path.abspath(r)
            if r not in roots:
                roots.append(r)
    return roots


def is_inside(path, root):
    path = os.path.abspath(path)
    root = os.path.abspath(root)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def root_of(path):
    for r in checkpoint_roots():
        if is_inside(path, r):
            return r
    return None


def clean_folder(folder):
    """ユーザー入力のサブフォルダ名を検証して 'a/b' 形式に正規化する。不正なら ValueError。"""
    folder = (folder or "").replace("\\", "/").strip().strip("/")
    if folder == "":
        return ""
    parts = [p.strip() for p in folder.split("/") if p.strip() != ""]
    for p in parts:
        if p in (".", "..") or p.startswith(".") or ":" in p or any(c in p for c in '<>"|?*\0'):
            raise ValueError(f"使用できないフォルダ名です: {p}")
    return "/".join(parts)


def list_subfolders(root):
    out = []
    for cur, dirs, _ in os.walk(root, followlinks=True):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        rel = os.path.relpath(cur, root)
        if rel != ".":
            out.append(rel.replace(os.sep, "/"))
    return sorted(out, key=str.lower)


def resolve_infos(names):
    """表示名/タイトルから CheckpointInfo を厳密一致で引く (破壊的操作なので部分一致は使わない)"""
    infos, errors, seen = [], [], set()
    for name in names:
        info = sd_models.checkpoint_aliases.get(name) or sd_models.checkpoints_list.get(name)
        if info is None:
            errors.append(f"見つかりません: {name}")
            continue
        if info.filename in seen:
            continue
        seen.add(info.filename)
        infos.append(info)
    return infos, errors


def loaded_filename():
    try:
        return os.path.abspath(shared.sd_model.sd_checkpoint_info.filename)
    except Exception:
        return None


def sidecar_files(model_path, moving_paths):
    """model_path に付随するファイルの一覧。同じ名前の別 checkpoint が残る場合は付随ファイルを動かさない。"""
    d = os.path.dirname(model_path)
    stem = os.path.splitext(os.path.basename(model_path))[0]
    moving = {os.path.abspath(p) for p in moving_paths}
    try:
        for f in os.listdir(d):
            other = os.path.join(d, f)
            if os.path.abspath(other) in moving:
                continue
            o_stem, o_ext = os.path.splitext(f)
            if o_stem == stem and o_ext.lower() in MODEL_EXTS:
                return []
    except OSError:
        return []
    found = []
    for suffix in SIDECAR_SUFFIXES:
        p = os.path.join(d, stem + suffix)
        if os.path.isfile(p):
            found.append(p)
    return found


def refresh_checkpoints():
    try:
        sd_models.list_models()
    except Exception as e:
        log(f"list_models failed: {e}")


def check_not_busy():
    if getattr(shared.state, "job", ""):
        raise RuntimeError("画像生成中はファイル操作できません")


def unique_path(path):
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    return f"{base}.{time.strftime('%Y%m%d-%H%M%S')}{ext}"


# ---------------------------------------------------------------------------
# 移動 / 削除
# ---------------------------------------------------------------------------

def move_checkpoints(names, folder):
    check_not_busy()
    folder = clean_folder(folder)
    infos, errors = resolve_infos(names)
    plans, done = [], []
    current = loaded_filename()
    all_paths = [os.path.abspath(i.filename) for i in infos]

    for info in infos:
        src = os.path.abspath(info.filename)
        root = root_of(src)
        if root is None:
            errors.append(f"管理フォルダ外のため移動できません: {info.name}")
            continue
        if src == current:
            errors.append(f"現在ロード中のため移動できません: {info.name}")
            continue
        dst_dir = os.path.abspath(os.path.join(root, folder))
        if not is_inside(dst_dir, root):
            errors.append(f"移動先が不正です: {folder}")
            continue
        if os.path.dirname(src) == dst_dir:
            errors.append(f"すでに同じフォルダにあります: {info.name}")
            continue
        dst = os.path.join(dst_dir, os.path.basename(src))
        if os.path.exists(dst):
            errors.append(f"移動先に同名ファイルがあります: {os.path.relpath(dst, root)}")
            continue
        files = [(src, dst)]
        for sc in sidecar_files(src, all_paths):
            sc_dst = os.path.join(dst_dir, os.path.basename(sc))
            if os.path.exists(sc_dst):
                errors.append(f"付随ファイルの移動先に同名ファイルがあるためスキップ: {os.path.basename(sc)}")
            else:
                files.append((sc, sc_dst))
        plans.append((info, dst_dir, files))

    for info, dst_dir, files in plans:
        try:
            os.makedirs(dst_dir, exist_ok=True)
            for s, d in files:
                shutil.move(s, d)
            done.append(info.name)
            log(f"moved: {info.name} -> {folder or '(root)'}")
        except Exception as e:
            errors.append(f"移動に失敗しました ({info.name}): {e}")

    refresh_checkpoints()
    return {"ok": done, "errors": errors}


def delete_checkpoints(names, permanent):
    check_not_busy()
    infos, errors = resolve_infos(names)
    done = []
    current = loaded_filename()
    all_paths = [os.path.abspath(i.filename) for i in infos]

    for info in infos:
        src = os.path.abspath(info.filename)
        root = root_of(src)
        if root is None:
            errors.append(f"管理フォルダ外のため削除できません: {info.name}")
            continue
        if src == current:
            errors.append(f"現在ロード中のため削除できません: {info.name}")
            continue
        files = [src] + sidecar_files(src, all_paths)
        try:
            if permanent:
                for f in files:
                    os.remove(f)
            else:
                # list_hidden_files が既定で有効なため、ルートの外 (兄弟フォルダ) に退避する
                trash_root = root.rstrip(os.sep) + "-trash"
                rel_dir = os.path.relpath(os.path.dirname(src), root)
                dst_dir = trash_root if rel_dir == "." else os.path.join(trash_root, rel_dir)
                os.makedirs(dst_dir, exist_ok=True)
                for f in files:
                    shutil.move(f, unique_path(os.path.join(dst_dir, os.path.basename(f))))
            done.append(info.name)
            log(f"{'deleted' if permanent else 'trashed'}: {info.name}")
        except Exception as e:
            errors.append(f"削除に失敗しました ({info.name}): {e}")

    refresh_checkpoints()
    return {"ok": done, "errors": errors}


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def register_api(demo, app):
    from fastapi import HTTPException, Request

    def guard(request: Request):
        if request.headers.get(REQUEST_HEADER) != REQUEST_HEADER_VALUE:
            raise HTTPException(status_code=403, detail="forbidden")
        # --gradio-auth 使用時は、ログイン済みのブラウザからの要求だけ受け付ける
        if getattr(shared.cmd_opts, "gradio_auth", None) or getattr(shared.cmd_opts, "gradio_auth_path", None):
            tokens = getattr(app, "tokens", None)
            cookie = request.cookies.get("access-token") or request.cookies.get("access-token-unsecure")
            if not tokens or not cookie or cookie not in tokens:
                raise HTTPException(status_code=403, detail="login required")

    def run(fn):
        try:
            return fn()
        except (RuntimeError, ValueError) as e:
            return {"ok": [], "errors": [str(e)]}

    @app.get(f"{API_PREFIX}/folders")
    async def folders(request: Request):
        guard(request)
        roots = checkpoint_roots()
        root = roots[0] if roots else None
        return {"root": root, "folders": list_subfolders(root) if root and os.path.isdir(root) else []}

    @app.post(f"{API_PREFIX}/move")
    async def move(request: Request):
        guard(request)
        data = await request.json()
        names = [str(n) for n in data.get("names", [])]
        folder = str(data.get("folder", ""))
        return run(lambda: move_checkpoints(names, folder))

    @app.post(f"{API_PREFIX}/delete")
    async def delete(request: Request):
        guard(request)
        data = await request.json()
        names = [str(n) for n in data.get("names", [])]
        return run(lambda: delete_checkpoints(names, bool(data.get("permanent", False))))


script_callbacks.on_app_started(register_api)


# ---------------------------------------------------------------------------
# 複数 checkpoint での連続生成
# ---------------------------------------------------------------------------

class CheckpointManagerScript(scripts.Script):
    def title(self):
        return "Checkpoint Manager"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        tab = "img2img" if is_img2img else "txt2img"
        with gr.Accordion("Checkpoint Manager (複数Checkpointで連続生成)", open=False):
            enabled = gr.Checkbox(
                label="選択したCheckpointで連続生成する (同じ設定・同じSeed)",
                value=False,
                elem_id=f"ckptmgr_enable_{tab}",
            )
            selected = gr.Textbox(
                label="対象Checkpoint (Checkpointsタブでチェックすると自動入力。1行1つ)",
                lines=3,
                elem_id=f"ckptmgr_selected_{tab}",
            )
        return [enabled, selected]

    @staticmethod
    def _targets(selected):
        infos, _ = resolve_infos([ln.strip() for ln in (selected or "").splitlines() if ln.strip()])
        return infos

    def before_process(self, p, enabled=False, selected="", *args):
        if getattr(p, "_ckptmgr_child", False) or not enabled:
            return
        if p.script_args and p.script_args[0]:
            log("スクリプト(X/Y/Z plot等)が選択されているため連続生成は無効です")
            return
        infos = self._targets(selected)
        if not infos:
            return
        # 1つ目はこの実行そのものを override_settings で切り替える。残りは postprocess で順に実行する
        p._ckptmgr_queue = [i.title for i in infos[1:]]
        p.override_settings = dict(p.override_settings or {})
        p.override_settings["sd_model_checkpoint"] = infos[0].title
        log(f"{len(infos)} checkpoints: " + ", ".join(i.name for i in infos))

    def postprocess(self, p, processed, enabled=False, selected="", *args):
        queue = getattr(p, "_ckptmgr_queue", None)
        if not queue or getattr(p, "_ckptmgr_child", False):
            return
        p._ckptmgr_queue = None

        for title in queue:
            if shared.state.interrupted or getattr(shared.state, "stopping_generation", False):
                break
            child = copy.copy(p)
            child._ckptmgr_child = True
            child._ckptmgr_queue = None
            child.override_settings = dict(p.override_settings)
            child.override_settings["sd_model_checkpoint"] = title
            # 最後に外側の process_images が元のモデルへ戻すので、ここでは戻さない
            child.override_settings_restore_afterwards = False
            child.extra_generation_params = dict(p.extra_generation_params)
            child.iteration = 0
            if hasattr(child, "is_hr_pass"):
                child.is_hr_pass = False
            shared.state.job_count += child.n_iter
            try:
                res = processing.process_images(child)
            except Exception as e:
                log(f"{title}: 生成に失敗しました: {e}")
                continue
            processed.images.extend(res.images)
            processed.infotexts.extend(res.infotexts)
