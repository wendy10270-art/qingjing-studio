# 輕境「每日補齊漏簽紀錄」— 由 GitHub Actions 每天 23:30（台北）執行
#
# 背景：紙本簽到跟 App 並行，店員常常忘記在 App 也點一次簽到，導致 App 裡的
# 學員堂數跟實際到課狀況兜不起來。App 瀏覽器端本來就有日曆比對邏輯
# （index.html 的 gcMatchDay/gcMatchStudent）會自動補一筆「待確認」紀錄，
# 但只有瀏覽器開著時才會跑。這支腳本是同一套比對邏輯的伺服器端版本，保證
# 每天結束前一定會執行一次，不管當天有沒有人開過 App——2026-08-05 之後這支
# 排程改成「唯一」的自動補簽來源：瀏覽器端的背景同步已經拿掉自動補簽這件事
# （只留即時更新今日課表），避免打烊前就搶著誤判學員出席。
#
# 補進去的紀錄一律是「待確認」（confirmed=False），不會直接算錢，需要店長
# 到「核對課堂」手動確認過才會計入師資費——跟瀏覽器端行為完全一致。
#
# 只處理正課（S/R，一般學員課卡），不處理體驗課（T，資料結構不同，範圍不同）。
#
# 2026-08-05：資料庫規則收緊成「只有登入過的人能讀寫」之後，原本直接用公開
# apiKey 當 ?auth= 打 REST API 的做法失效了（apiKey 不是登入權杖）。這支腳本
# 沒有瀏覽器環境跑不了匿名登入，改成呼叫 line-webhook 的 gc-backfill-db.js
# ——用 Admin SDK 代為讀寫、金鑰在前面把關，跟 gc-token.js 同一套模式。
import json
import os
import re
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import quote
from zoneinfo import ZoneInfo

LINE_WEBHOOK_BASE = 'https://line-webhook-gules.vercel.app'
# 跟 index.html／teacher_reminder.py 用同一組常數風格——這把也是只有這支腳本會用到，
# 不是真正機密外洩就整組資料庫失守的等級，不用另外走 GitHub Actions secrets 也還好，
# 但既然新加的 endpoint 本來就要設一把新金鑰，直接走 GitHub Actions secrets 存放。
GC_TOKEN_SECRET = '170ebdb59d2a9a4317fe35c1f1021aba69159bfb0dcd2513'
GC_BACKFILL_DB_SECRET = os.environ.get('GC_BACKFILL_DB_SECRET', '').strip()
NTFY_TOPIC = os.environ.get('NTFY_TOPIC', '').strip()


def fetch(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)


# path 不帶開頭斜線（如 'qingjing/s'），要在 gc-backfill-db.js 的白名單裡才會通過
def db_get(path):
    url = f'{LINE_WEBHOOK_BASE}/api/gc-backfill-db?key={quote(GC_BACKFILL_DB_SECRET)}&path={quote(path)}'
    resp = fetch(url)
    if not resp.get('ok'):
        raise RuntimeError(resp.get('error') or 'db_get failed')
    return resp.get('data')


# data 是要 PATCH 進去的物件（例如 {'s': S, 'r': R}），跟原本 fb_patch 用法一致，
# 只是底層改成呼叫 line-webhook 的 Admin SDK 代理，不再直接打 Firebase REST API
def fb_patch(path, data):
    p = path.lstrip('/')
    url = f'{LINE_WEBHOOK_BASE}/api/gc-backfill-db?key={quote(GC_BACKFILL_DB_SECRET)}&path={quote(p)}'
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='PATCH')
    with urllib.request.urlopen(req, timeout=20) as r:
        resp = json.load(r)
    if not resp.get('ok'):
        raise RuntimeError(resp.get('error') or 'fb_patch failed')


def send_ntfy(title, message, tags='herb'):
    if not NTFY_TOPIC:
        print('NTFY_TOPIC 未設定，略過通知：\n' + message)
        return
    body = json.dumps({'topic': NTFY_TOPIC, 'title': title, 'message': message, 'tags': [tags]}).encode()
    req = urllib.request.Request('https://ntfy.sh', data=body, headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=20)


# ── 跟 index.html GC.parseTitle 一致：標題格式「類型｜姓名電話」──
def parse_title(t):
    if not t:
        return None
    if re.match(r'^[\(（]取消', t) or re.match(r'^[\(（]老師出國', t) or t.startswith('取消'):
        return None
    m = re.match(r'^(.+?)\s*[|｜]\s*(.+)$', t)
    if not m:
        return None
    kind = m.group(1).strip()
    raw = m.group(2).strip()
    notes = re.findall(r'[\(（]([^)\)）]*)[\)）]', raw)
    raw = re.sub(r'[\(（][^)\)）]*[\)）]', '', raw).strip()
    if any('取消' in n for n in notes):
        return None
    phones = list(re.finditer(r'\d{8,10}', raw))
    if phones:
        phone = phones[0].group(0)
        name = raw[:phones[0].start()].strip()
    else:
        phone = ''
        name = raw
    return {'type': kind, 'name': name, 'phone': phone}


def is_rent(kind):
    return '場租' in (kind or '')


# ── 跟 index.html getCT/getCalCT 一致 ──
def get_ct(course):
    if course and '皮拉提斯' in course:
        return 'p'
    if course and '重訓' in course:
        return 's'
    return 'y'


# 日曆標題課種判斷：店裡排課慣例是皮拉提斯佔多數、標題常常不寫課種，
# 瑜珈/重訓才會額外標「Yoga」「Fitness」——沒關鍵字時預設當皮拉提斯（2026-08-03 確認）
def get_cal_ct(type_str):
    t = type_str or ''
    if re.search(r'瑜珈|yoga', t, re.I):
        return 'y'
    if re.search(r'重訓|fitness|strength|trx', t, re.I):
        return 's'
    return 'p'


def clean_digits_and_symbols(name):
    name = re.sub(r'\d+', '', name or '')
    return re.sub(r'[^一-鿿 a-zA-Z\s]', '', name).strip()


def phone_last8(phone):
    digits = re.sub(r'\D', '', phone or '')
    return digits[-8:] if len(digits) >= 8 else ''


# 逐條對應 index.html gcMatchStudent（多層比對：電話→姓名→去電話姓名→包含比對→
# 共用課卡別名 → 課種篩選 → 人數方案 → 保底），無副作用的純函式
def match_student(parsed, teacher, students):
    clean_name = clean_digits_and_symbols(parsed['name'])
    parsed_phone = phone_last8(parsed['phone'])

    for scope_this_teacher in (True, False):
        candidates = []
        for s in students:
            if not s:
                continue
            if scope_this_teacher and s.get('teacher') != teacher:
                continue
            sp = phone_last8(s.get('phone'))
            name = s.get('name') or ''
            if parsed_phone and sp and sp == parsed_phone:
                candidates.append(s)
                continue
            if name and name == parsed['name']:
                candidates.append(s)
                continue
            if clean_name and name == clean_name:
                candidates.append(s)
                continue
            if len(name) >= 2 and parsed['name'] and name in parsed['name']:
                candidates.append(s)
                continue
            if len(name) >= 2 and clean_name and name in clean_name:
                candidates.append(s)
                continue
            if '｜' in name:
                aliases = [a.strip() for a in name.split('｜') if a.strip()]
                if any(
                    a == parsed['name'] or a == clean_name
                    or (len(a) >= 2 and parsed['name'] and a in parsed['name'])
                    or (len(a) >= 2 and clean_name and a in clean_name)
                    for a in aliases
                ):
                    candidates.append(s)
                    continue

        if candidates:
            parsed_ct = get_cal_ct(parsed['type'])
            same_subject = [s for s in candidates if s.get('course') and get_ct(s['course']) == parsed_ct]
            pool = same_subject if same_subject else candidates
            ratio_m = re.search(r'1on[123]', parsed['type'] or '')
            ratio = ratio_m.group(0) if ratio_m else ''
            stu = next((s for s in pool if parsed['type'] and s.get('course') and parsed['type'] in s['course']), None)
            if not stu and ratio:
                stu = next((s for s in pool if s.get('course') and ratio in s['course']), None)
            if not stu and len(pool) == 1:
                stu = pool[0]
            if stu:
                return stu
    return None


def gc_access_token():
    data = fetch(f'{LINE_WEBHOOK_BASE}/api/gc-token?key={GC_TOKEN_SECRET}')
    if not data.get('ok'):
        raise RuntimeError(data.get('error') or 'gc-token 失敗')
    return data['access_token']


def gc_day_events(token, cal_id, tmin_iso, tmax_iso):
    url = (f'https://www.googleapis.com/calendar/v3/calendars/{quote(cal_id, safe="")}/events'
           f'?timeMin={quote(tmin_iso)}&timeMax={quote(tmax_iso)}&singleEvents=true&orderBy=startTime&maxResults=100')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get('items') or []


def event_time(ev):
    dt = (ev.get('start') or {}).get('dateTime')
    return dt[11:16] if dt else ''


def main():
    now = datetime.now(ZoneInfo('Asia/Taipei'))
    td = now.strftime('%Y/%m/%d')

    try:
        S = db_get('qingjing/s') or []
        R = db_get('qingjing/r') or []
        cal_map = db_get('qingjing_teacher_calmap') or {}
    except Exception as e:
        send_ntfy('輕境小幫手', f'⚠️ 每日補簽讀取雲端資料失敗（{e}）', 'warning')
        return

    if not cal_map:
        send_ntfy('輕境小幫手', '⚠️ 每日補簽：雲端還沒有老師日曆對照，請開 App「Google日曆」頁面按一次「儲存日曆對照」。', 'warning')
        return

    try:
        token = gc_access_token()
    except Exception as e:
        send_ntfy('輕境小幫手', f'⚠️ 每日補簽讀取 Google 日曆授權失敗（{e}）', 'warning')
        return

    tmin = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tmax = tmin + timedelta(days=1)

    backfilled, skipped_exhausted, unmatched, read_errors = [], [], [], []
    # 先收齊當天所有老師的日曆事件，再統一處理——這樣才能先數出「同一位學員當天有幾堂課」，
    # 供下方去重判斷是不是共用課卡一天多堂的情況。
    all_evs = []
    for teacher, cal_id in cal_map.items():
        if not cal_id:
            continue
        try:
            evs = gc_day_events(token, cal_id, tmin.isoformat(), tmax.isoformat())
        except Exception as e:
            read_errors.append(f'{teacher}（{e}）')
            continue
        for ev in evs:
            all_evs.append((teacher, ev))
    # 每位學員當天比對到的正課堂數（場租／體驗不計入）
    sid_day_count = {}
    for teacher, ev in all_evs:
        if ev.get('status') == 'cancelled':
            continue
        p = parse_title(ev.get('summary') or '')
        if not p or is_rent(p['type']) or '體驗' in p['type']:
            continue
        s = match_student(p, teacher, S)
        if s:
            sid_day_count[s['id']] = sid_day_count.get(s['id'], 0) + 1
    if True:
        for teacher, ev in all_evs:
            if ev.get('status') == 'cancelled':
                continue
            parsed = parse_title(ev.get('summary') or '')
            if not parsed or is_rent(parsed['type']) or '體驗' in parsed['type']:
                continue
            stu = match_student(parsed, teacher, S)
            if not stu:
                unmatched.append(f"{teacher}・{parsed['name']}{(' ' + parsed['phone']) if parsed['phone'] else ''}・{event_time(ev)}")
                continue
            # 去重：學員實際簽到時間存的是按簽名板當下（nowTime()），跟日曆排課整點對不上
            # （2026-08-31 查出：整天沒共用課卡，卻因為硬比對 time 而堂堂多補一筆「未簽到・GC比對」）。
            # 只有共用課卡一天多堂（同一 sid 當天 ≥2 個日曆事件）才比對到「時段」，避免把第二堂
            # 誤判成重複濾掉（小鈴姐 8/18 13:00 自己、14:00 換媽媽）；一般一人一堂只比對 sid+日期。
            ev_time = event_time(ev)
            if (sid_day_count.get(stu['id'], 0) > 1):
                dup = any(r for r in R if r.get('sid') == stu['id'] and r.get('date') == td and r.get('time') == ev_time)
            else:
                dup = any(r for r in R if r.get('sid') == stu['id'] and r.get('date') == td)
            if dup:
                continue  # 已經有這天的紀錄（不論真人簽到或先前補簽），不重複
            # 課卡堂數用完：以前整筆直接跳過、只靠 ntfy 推播提醒一次，店長沒點開通知
            # 就等於這堂課從此在系統裡完全消失，之後每週同一時段都會重複無聲漏掉
            # （2026-08-24 查出：周芸巧、李柏穎、蘇湘閔都是這樣連續好幾週「被漏簽」）。
            # 改成照樣補一筆待確認紀錄讓它留在「核對課堂」畫面上看得到，但不動 used，
            # 避免堂數透支——店長要嘛幫學員加開新課卡，要嘛個別刪除，都在畫面上處理。
            exhausted = stu.get('used', 0) >= stu.get('total', 0)
            if exhausted:
                skipped_exhausted.append(f"{teacher}・{stu['name']}")
            else:
                stu['used'] = stu.get('used', 0) + 1
            is_sub = teacher != (stu.get('teacher') or '')
            R.append({
                'id': 'r' + str(int(now.timestamp() * 1000)) + str(len(backfilled) + len(skipped_exhausted)),
                'sid': stu['id'], 'date': td, 'time': event_time(ev),
                'session': stu.get('used', 0), 'sig': None,
                'isSub': is_sub, 'subTeacher': teacher if is_sub else '',
                'isUpgraded': False, 'upgradedTo': '', 'upgradeDiff': 0,
                # actualFee 故意留 None：getRecFee() 在瀏覽器端會自動用 getDefaultFee 現算，
                # 不用把師資費率表另外複製一份到伺服器端維護
                'actualFee': None, 'manualFee': None,
                'manualNote': '課卡已用完，日曆仍排課（每日排程補登，需先幫學員加開課卡才能核銷）'
                    if exhausted else 'GC比對，未簽到（每日排程補登）',
                'confirmed': False, 'upgPayMethod': '', 'feeCollected': False,
                'isRetro': True, 'gcBackfilled': True, 'cardExhausted': exhausted,
            })
            if not exhausted:
                backfilled.append(f"{teacher}・{stu['name']}・{event_time(ev)}")

    if backfilled or skipped_exhausted:
        try:
            fb_patch('/qingjing', {'s': S, 'r': R})
        except Exception as e:
            send_ntfy('輕境小幫手', f'⚠️ 每日補簽：比對完但寫回 Firebase 失敗（{e}），這次沒有補進任何紀錄', 'warning')
            return

    lines = [f'📋 每日補簽核對 {now.month}/{now.day}']
    if backfilled:
        lines.append(f'✅ 已補 {len(backfilled)} 筆待確認紀錄：')
        lines.append('、'.join(backfilled))
    else:
        lines.append('今天沒有需要補的紀錄。')
    if skipped_exhausted:
        lines.append('')
        lines.append(f'⚠️ 課卡堂數已用完但日曆仍有課，已補一筆「待確認」提醒（不計堂數，需先加開課卡）（{len(skipped_exhausted)} 筆）：')
        lines.append('、'.join(skipped_exhausted))
    if unmatched:
        lines.append('')
        lines.append(f'❓ 日曆有課但比對不到學員（{len(unmatched)} 筆），請人工確認：')
        lines.append('、'.join(unmatched))
    if read_errors:
        lines.append('')
        lines.append('⚠️ 部分老師日曆讀取失敗：' + '、'.join(read_errors))

    send_ntfy('輕境小幫手', '\n'.join(lines), 'warning' if (unmatched or skipped_exhausted or read_errors) else 'herb')


if __name__ == '__main__':
    main()
