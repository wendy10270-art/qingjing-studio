# 完整資料庫備份 — R+S 資料層遷移計畫（階段 0：準備）的安全網。
# 把目前 Firebase 上的 qingjing（含 s/r/sch/t/l）+ qingjing_ledger 整包 GET 下來，
# 存成帶時間戳的 JSON 檔，遷移任何一步出錯都能從這份備份救回來。
#
# 用法：
#   python3 scripts/backup_full_db.py
#
# 讀取方式：跟 index.html 裡的匿名登入（firebase.auth().signInAnonymously()）完全同一套
# 機制，只是用 REST 直接打 Identity Toolkit 拿 idToken，不需要任何伺服器端密鑰
# （SCRIPTS_DB_SECRET 是只給 line-webhook/api/scripts-db.js 白名單腳本用的伺服器端密鑰，
# 刻意設為「只寫入 Vercel、寫入後前端/CLI 都讀不回來」，這裡不需要也不該去動它）。
# 用的 apiKey 是 index.html 裡本來就公開的那把（同一顆），資料庫規則只要求 auth != null，
# 匿名登入完全公開、任何人本來就能做，這裡只是唯讀備份，不寫入任何東西。
import json
import os
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

FB_URL = 'https://qingjing-studio-default-rtdb.firebaseio.com'
FIREBASE_API_KEY = 'AIzaSyBg3_toi-Kqyi9iw2IbW9C5HhkbgJappxI'
BACKUP_DIR = '/Volumes/WINNIE/輕境健康平衡工作室/_agent_backups'
# 涵蓋整個遷移計畫要動的資料：qingjing.s（學員）、qingjing.r（簽到記錄）、
# qingjing.sch/t/l（課表/師資/請假），以及獨立的 qingjing_ledger（流水帳）
READABLE_PATHS = ['qingjing', 'qingjing_ledger']


def get_anon_id_token():
    url = f'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={FIREBASE_API_KEY}'
    req = urllib.request.Request(
        url,
        data=json.dumps({'returnSecureToken': True}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        resp = json.load(r)
    token = resp.get('idToken')
    if not token:
        raise RuntimeError(f'匿名登入失敗：{resp}')
    return token


def fetch(path, id_token):
    url = f'{FB_URL}/{path}.json?auth={id_token}'
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.load(r)
    if isinstance(data, dict) and set(data.keys()) == {'error'}:
        raise RuntimeError(f'{path}: {data["error"]}')
    return data


def main():
    print('匿名登入中...')
    id_token = get_anon_id_token()

    snapshot = {}
    for path in READABLE_PATHS:
        print(f'讀取 {path} ...')
        snapshot[path] = fetch(path, id_token)

    now = datetime.now(ZoneInfo('Asia/Taipei'))
    ts = now.strftime('%Y%m%d_%H%M%S')
    os.makedirs(BACKUP_DIR, exist_ok=True)
    out_path = os.path.join(BACKUP_DIR, f'backup_full_db_{ts}.json')

    payload = {
        'note': f'{now.strftime("%Y-%m-%d %H:%M")} R+S 資料層遷移計畫階段 0：遷移前完整備份',
        'backed_up_at': now.isoformat(),
        'data': snapshot,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    qj = snapshot.get('qingjing') or {}
    s_count = len(qj.get('s') or [])
    r_count = len(qj.get('r') or [])
    sch_count = len(qj.get('sch') or {})
    ledger_count = len(snapshot.get('qingjing_ledger') or [])
    print(f'已備份至：{out_path}')
    print(f'  s（學員）：{s_count} 筆')
    print(f'  r（簽到記錄）：{r_count} 筆')
    print(f'  sch（課表日期數）：{sch_count} 天')
    print(f'  qingjing_ledger（流水帳）：{ledger_count} 筆')


if __name__ == '__main__':
    main()
