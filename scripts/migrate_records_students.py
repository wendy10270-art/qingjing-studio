# R+S 資料層遷移計畫．一次性遷移腳本（階段 1 才會真的執行；階段 0 只先寫出來，
# 這支腳本目前刻意「不會被自動執行」——沒有排程掛它、也還沒被任何人手動跑過）。
#
# 用途：把現有 qingjing/r（簽到記錄陣列）、qingjing/s（學員資料陣列）逐筆搬到新結構
# qingjing/records/{舊 id}、qingjing/students/{舊 id}（用舊 id 當新節點 key，而非
# push key——這樣才能重複執行仍是同一批 key，冪等、不會每跑一次多長一批重複資料）。
#
# 執行前置：務必先跑過 scripts/backup_full_db.py 留一份完整備份（本次遷移計畫已在
# 2026-09-15 執行過一次，見 _agent_backups/backup_full_db_*.json）。
#
# 用法：
#   python3 scripts/migrate_records_students.py --dry-run   # 只印出會做什麼，不寫入
#   python3 scripts/migrate_records_students.py --apply     # 真的寫入 qingjing/records、qingjing/students
#   python3 scripts/migrate_records_students.py --verify    # 只做驗證比對，不寫入
#
# 安全設計：
#   - 冪等：用舊 id 當 key，同一筆資料重複執行只會覆蓋成同樣的內容，不會重複新增
#   - 每筆都用 PUT（覆蓋整個節點），不是 PATCH，確保新節點內容跟舊陣列該筆完全一致
#   - --apply 之外的模式一律不寫入，預設也不會被排程或其他程式呼叫到
import argparse
import json
import sys
import urllib.request
from urllib.error import HTTPError

FB_URL = 'https://qingjing-studio-default-rtdb.firebaseio.com'
FIREBASE_API_KEY = 'AIzaSyBg3_toi-Kqyi9iw2IbW9C5HhkbgJappxI'


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


def fb_get(path, id_token):
    url = f'{FB_URL}/{path}.json?auth={id_token}'
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.load(r)
    if isinstance(data, dict) and set(data.keys()) == {'error'}:
        raise RuntimeError(f'{path}: {data["error"]}')
    return data


def fb_put(path, value, id_token):
    url = f'{FB_URL}/{path}.json?auth={id_token}'
    body = json.dumps(value).encode()
    req = urllib.request.Request(url, data=body, method='PUT', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except HTTPError as e:
        raise RuntimeError(f'PUT {path} 失敗：HTTP {e.code} {e.read().decode(errors="replace")}')


def deep_equal(a, b):
    # 逐欄位比對（dict/list 遞迴），數字型別寬鬆比對（Firebase 有時把整數存回浮點數）
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a.keys()) != set(b.keys()):
            return False
        return all(deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        return all(deep_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return a == b


def migrate(records_or_students, id_field, target_prefix, id_token, apply):
    """records_or_students: 舊陣列（R 或 S）；id_field 通常是 'id'。"""
    plan = []
    skipped = []
    for i, item in enumerate(records_or_students):
        old_id = item.get(id_field)
        if not old_id:
            skipped.append((i, item))
            continue
        plan.append((old_id, item))

    print(f'{target_prefix}：共 {len(records_or_students)} 筆，{len(plan)} 筆有 id 可搬，{len(skipped)} 筆缺 id 略過')
    for i, item in skipped:
        print(f'  ⚠ 略過第 {i} 筆（缺 {id_field} 欄位）：{json.dumps(item, ensure_ascii=False)[:200]}')

    if not apply:
        for old_id, _ in plan[:5]:
            print(f'  [dry-run] 會寫入 {target_prefix}/{old_id}')
        if len(plan) > 5:
            print(f'  ...（共 {len(plan)} 筆，僅列出前 5 筆）')
        return plan

    for old_id, item in plan:
        fb_put(f'{target_prefix}/{old_id}', item, id_token)
    print(f'  ✓ 已寫入 {len(plan)} 筆到 {target_prefix}/*')
    return plan


def verify(old_list, id_field, target_prefix, id_token):
    new_snap = fb_get(target_prefix, id_token) or {}
    old_by_id = {item.get(id_field): item for item in old_list if item.get(id_field)}

    # 筆數比對
    ok = True
    if len(old_by_id) != len(new_snap):
        ok = False
        print(f'  ✗ 筆數不符：舊資料 {len(old_by_id)} 筆，新節點 {len(new_snap)} 筆')
    else:
        print(f'  ✓ 筆數相符：{len(old_by_id)} 筆')

    missing = set(old_by_id.keys()) - set(new_snap.keys())
    extra = set(new_snap.keys()) - set(old_by_id.keys())
    if missing:
        ok = False
        print(f'  ✗ 新節點缺少 {len(missing)} 筆：{list(missing)[:10]}')
    if extra:
        ok = False
        print(f'  ✗ 新節點多出 {len(extra)} 筆（不在舊資料裡）：{list(extra)[:10]}')

    mismatch = []
    for old_id, old_item in old_by_id.items():
        if old_id in new_snap and not deep_equal(old_item, new_snap[old_id]):
            mismatch.append(old_id)
    if mismatch:
        ok = False
        print(f'  ✗ {len(mismatch)} 筆內容不一致：{mismatch[:10]}')
    else:
        print('  ✓ 逐欄位比對：所有已遷移筆數內容一致')

    return ok


def main():
    ap = argparse.ArgumentParser(description='R+S 資料層一次性遷移腳本')
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true', help='只印出遷移計畫，不寫入任何東西')
    mode.add_argument('--apply', action='store_true', help='真的把 r/s 逐筆寫進 records/students')
    mode.add_argument('--verify', action='store_true', help='只驗證：比對舊陣列跟新節點是否一致，不寫入')
    args = ap.parse_args()

    print('匿名登入中...')
    id_token = get_anon_id_token()

    print('讀取現有 qingjing...')
    qj = fb_get('qingjing', id_token) or {}
    r_list = qj.get('r') or []
    s_list = qj.get('s') or []

    if args.verify:
        print('\n── 驗證 records（來源：qingjing/r）──')
        ok1 = verify(r_list, 'id', 'qingjing/records', id_token)
        print('\n── 驗證 students（來源：qingjing/s）──')
        ok2 = verify(s_list, 'id', 'qingjing/students', id_token)
        sys.exit(0 if (ok1 and ok2) else 1)

    apply = args.apply
    if apply:
        confirm = input('⚠ 即將真的寫入 production 的 qingjing/records、qingjing/students，'
                         '確定已經跑過 backup_full_db.py 備份了嗎？輸入 yes 繼續：')
        if confirm.strip().lower() != 'yes':
            print('已取消，未寫入任何資料')
            sys.exit(1)

    print('\n── 遷移 records（來源：qingjing/r）──')
    migrate(r_list, 'id', 'qingjing/records', id_token, apply)
    print('\n── 遷移 students（來源：qingjing/s）──')
    migrate(s_list, 'id', 'qingjing/students', id_token, apply)

    if apply:
        print('\n遷移完成，建議接著跑一次 --verify 確認新舊資料一致')


if __name__ == '__main__':
    main()
