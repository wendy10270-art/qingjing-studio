# R+S 資料層遷移計畫．每日比對腳本（階段 1：雙寫觀察期用）。
#
# 目的：階段 1 上線後，舊結構（qingjing/r 陣列、qingjing/s[].used）跟新結構
# （qingjing/records/*、qingjing/students/*/used）理論上應該逐筆一致——舊邏輯
# 照舊執行、新結構只是背景多寫一份。這支腳本就是拿來「盯著看有沒有落差」：
#   - 新結構寫入失敗被吞掉（設計上就會發生，只是不該常態發生、也不該永遠不補）
#   - 有沒有漏掉的呼叫點（例如以後又新增了一個會動 R/S.used 的地方，忘記雙寫）
#
# 用法：
#   python3 scripts/diff_records_students.py            # 印出比對結果到終端機
#   python3 scripts/diff_records_students.py --json out.json  # 同時把落差明細存成 JSON
#
# 目前先手動執行即可（老闆/工程師觀察期每天跑一次），還沒排程自動化。
# 之後若要排程，可比照 scripts/daily_digest.py 掛一個新的 GitHub Actions workflow，
# 但那需要走 GitHub 網頁改 .github/workflows/*（PAT 沒有 workflow scope，git push 推不上去）。
import argparse
import json
import sys
import urllib.request

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


def diff_records(r_list, records_snap):
    """比對 qingjing/r（舊，陣列）跟 qingjing/records（新，逐筆節點）。
    只比對「舊有的一定要在新結構裡出現、且核心欄位一致」，新結構單方面多出來的
    key（例如 dry-run 測試殘留、或還沒被舊結構刪除同步的孤兒）另外列出，不算失敗，
    但要看得到。"""
    records_snap = records_snap or {}
    old_by_id = {r.get('id'): r for r in r_list if r.get('id')}
    core_fields = ['sid', 'date', 'session', 'confirmed']

    missing_in_new = []
    field_mismatch = []
    for old_id, old_r in old_by_id.items():
        new_r = records_snap.get(old_id)
        if new_r is None:
            missing_in_new.append(old_id)
            continue
        for f in core_fields:
            if old_r.get(f) != new_r.get(f):
                field_mismatch.append({'id': old_id, 'field': f, 'old': old_r.get(f), 'new': new_r.get(f)})

    extra_in_new = sorted(set(records_snap.keys()) - set(old_by_id.keys()))

    return {
        'old_count': len(old_by_id),
        'new_count': len(records_snap),
        'missing_in_new': missing_in_new,
        'field_mismatch': field_mismatch,
        'extra_in_new': extra_in_new,
    }


def diff_students_used(s_list, students_snap):
    """比對 qingjing/s[].used（舊）跟 qingjing/students/{sid}/used（新）。"""
    students_snap = students_snap or {}
    mismatch = []
    missing_in_new = []
    for s in s_list:
        sid = s.get('id')
        if not sid:
            continue
        old_used = s.get('used') or 0
        new_student = students_snap.get(sid)
        if new_student is None:
            missing_in_new.append(sid)
            continue
        new_used = (new_student or {}).get('used') or 0
        if old_used != new_used:
            mismatch.append({'sid': sid, 'name': s.get('name'), 'old_used': old_used, 'new_used': new_used})

    return {
        'old_student_count': len(s_list),
        'new_student_count': len(students_snap),
        'missing_in_new': missing_in_new,
        'used_mismatch': mismatch,
    }


def main():
    ap = argparse.ArgumentParser(description='R+S 資料層每日比對腳本（階段 1 雙寫觀察期用）')
    ap.add_argument('--json', help='把落差明細另存成 JSON 檔（選填）')
    args = ap.parse_args()

    print('匿名登入中...')
    id_token = get_anon_id_token()

    print('讀取 qingjing/r、qingjing/s、qingjing/records、qingjing/students ...')
    qj = fb_get('qingjing', id_token) or {}
    r_list = qj.get('r') or []
    s_list = qj.get('s') or []
    records_snap = fb_get('qingjing/records', id_token) or {}
    students_snap = fb_get('qingjing/students', id_token) or {}

    print('\n── R（簽到記錄）比對：qingjing/r vs qingjing/records ──')
    rdiff = diff_records(r_list, records_snap)
    print(f"  舊：{rdiff['old_count']} 筆　新：{rdiff['new_count']} 筆")
    if rdiff['missing_in_new']:
        print(f"  ✗ 新結構缺少 {len(rdiff['missing_in_new'])} 筆（雙寫失敗或漏接的呼叫點）：{rdiff['missing_in_new'][:10]}")
    else:
        print('  ✓ 舊有的記錄都能在新結構找到')
    if rdiff['field_mismatch']:
        print(f"  ✗ {len(rdiff['field_mismatch'])} 個欄位不一致：{rdiff['field_mismatch'][:10]}")
    else:
        print('  ✓ 核心欄位（sid/date/session/confirmed）皆一致')
    if rdiff['extra_in_new']:
        print(f"  ℹ 新結構多出 {len(rdiff['extra_in_new'])} 筆不在舊結構（可能是測試殘留或舊結構那筆被刪但新結構沒同步刪）：{rdiff['extra_in_new'][:10]}")

    print('\n── S.used（學員已用堂數）比對：qingjing/s[].used vs qingjing/students/*/used ──')
    sdiff = diff_students_used(s_list, students_snap)
    print(f"  舊：{sdiff['old_student_count']} 位學員　新結構已有：{sdiff['new_student_count']} 位")
    if sdiff['missing_in_new']:
        print(f"  ✗ 新結構缺少 {len(sdiff['missing_in_new'])} 位學員（尚未被任何雙寫呼叫點寫過）：{sdiff['missing_in_new'][:10]}")
    else:
        print('  ✓ 舊有的學員都能在新結構找到')
    if sdiff['used_mismatch']:
        print(f"  ✗ {len(sdiff['used_mismatch'])} 位學員 used 不一致：")
        for m in sdiff['used_mismatch'][:20]:
            print(f"     - {m['name']}（{m['sid']}）：舊={m['old_used']}　新={m['new_used']}")
    else:
        print('  ✓ 所有已同步學員的 used 堂數一致')

    ok = (not rdiff['missing_in_new'] and not rdiff['field_mismatch']
          and not sdiff['used_mismatch'])

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump({'records': rdiff, 'students_used': sdiff}, f, ensure_ascii=False, indent=2)
        print(f'\n落差明細已存到 {args.json}')

    print('\n' + ('✓ 整體比對通過，新舊資料一致' if ok else '✗ 發現落差，請人工檢查上面列出的項目'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
