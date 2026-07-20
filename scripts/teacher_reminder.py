# 輕境老師版「明日提醒」— 由 GitHub Actions 每天 10:00（台北）執行
#
# 跟學員版（line_reminder.py）不同：這支不走「店長先看過再按確認送出」那一套，
# 是店長跟老師之間內部溝通，風險比對外發給學員低，所以直接推播，不用等人按按鈕。
#
# 內容分兩塊：① 明天課表（跟 daily_digest.py 一樣解析 SCH，改成依老師分組）
#            ② 明天場租（SCH 同步時就把場租事件濾掉了，所以場租要另外直接打
#               Google Calendar API 查老師自己的日曆，找標題含「場租」的明天事件）
import json
import os
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

FB = 'https://qingjing-studio-default-rtdb.firebaseio.com'
LINE_WEBHOOK_BASE = 'https://line-webhook-gules.vercel.app'
# 跟 index.html 的 GC_TOKEN_SECRET／TEACHER_PUSH_SECRET 用同一組常數——這兩把本來就寫死在
# index.html 裡（GitHub Pages 完全公開），不是真正機密，所以不用另外走 GitHub Actions secrets。
GC_TOKEN_SECRET = '170ebdb59d2a9a4317fe35c1f1021aba69159bfb0dcd2513'
TEACHER_PUSH_SECRET = '571af36b802c6c269a5264649b8748cdf62774fcf74ed081'
NTFY_TOPIC = os.environ.get('NTFY_TOPIC', '').strip()
DRY_RUN = os.environ.get('DRY_RUN', '').strip() == '1'
WD = '日一二三四五六'


def fetch(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)


def send_ntfy(title, message, tags='herb'):
    if not NTFY_TOPIC:
        print('NTFY_TOPIC 未設定，略過通知：\n' + message)
        return
    body = json.dumps({'topic': NTFY_TOPIC, 'title': title, 'message': message, 'tags': [tags]}).encode()
    req = urllib.request.Request('https://ntfy.sh', data=body, headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=20)


def phone_key(phone):
    digits = ''.join(c for c in (phone or '') if c.isdigit())
    return digits[-8:] if len(digits) >= 8 else None


# 跟 index.html 的 GC.parseTitle 邏輯一致：標題格式「類型｜姓名」
def parse_title(t):
    if not t:
        return None
    if t.startswith('取消') or t.startswith('(取消') or t.startswith('（取消') or t.startswith('(老師出國') or t.startswith('（老師出國'):
        return None
    for sep in ('|', '｜'):
        if sep in t:
            kind, _, rest = t.partition(sep)
            return kind.strip(), rest.strip()
    return None


def is_rent(kind):
    return '場租' in (kind or '')


def gc_access_token():
    data = fetch(f'{LINE_WEBHOOK_BASE}/api/gc-token?key={GC_TOKEN_SECRET}')
    if not data.get('ok'):
        raise RuntimeError(data.get('error') or 'gc-token 失敗')
    return data['access_token']


def gc_tomorrow_events(token, cal_id, tmin_iso, tmax_iso):
    from urllib.parse import quote
    url = (f'https://www.googleapis.com/calendar/v3/calendars/{quote(cal_id, safe="")}/events'
           f'?timeMin={quote(tmin_iso)}&timeMax={quote(tmax_iso)}&singleEvents=true&orderBy=startTime&maxResults=50')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get('items') or []


def event_time(ev):
    dt = (ev.get('start') or {}).get('dateTime')
    if not dt:
        return ''
    return dt[11:16]


def send_teacher_message(phone, message):
    body = json.dumps({'phone': phone, 'message': message}).encode()
    req = urllib.request.Request(
        f'{LINE_WEBHOOK_BASE}/api/send-teacher-message?key={TEACHER_PUSH_SECRET}',
        data=body, headers={'Content-Type': 'application/json'}, method='POST',
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def main():
    now = datetime.now(ZoneInfo('Asia/Taipei'))
    tomorrow = now + timedelta(days=1)
    td = tomorrow.strftime('%Y/%m/%d')
    dow = (tomorrow.weekday() + 1) % 7  # 0=週日
    wd_label = f'週{WD[dow]}'

    try:
        d = fetch(FB + '/qingjing.json') or {}
        if isinstance(d, dict) and set(d.keys()) == {'error'}:
            raise RuntimeError(d['error'])
        teacher_phones = fetch(FB + '/qingjing_teacher_phones.json') or {}
        cal_map = fetch(FB + '/qingjing_teacher_calmap.json') or {}
        bindings = fetch(FB + '/qingjing_line_bindings_teacher.json') or {}
    except Exception as e:
        send_ntfy('輕境小幫手', f'⚠️ 老師明日提醒讀取雲端資料失敗（{e}）', 'warning')
        return

    S = d.get('s') or []
    SCH = d.get('sch') or {}

    # ── 明天課表，依老師分組（沿用 daily_digest.py 的排課解析邏輯）──
    by_teacher = {}
    def add_item(teacher, time_, name):
        if not teacher:
            return
        by_teacher.setdefault(teacher, []).append((time_ or '', name))

    for teacher, slots in (SCH.get(td) or {}).items():
        for sl in slots or []:
            if not sl or sl.get('skip'):
                continue
            st = next((x for x in S if x.get('id') == sl.get('sid')), None)
            if st:
                add_item(teacher, sl.get('time'), st['name'])
    for st in S:
        skipped = any(sl.get('sid') == st.get('id') and sl.get('skip')
                      for slots in (SCH.get(td) or {}).values() for sl in slots or [])
        for rc in st.get('recurring') or []:
            if rc and rc.get('day') == dow and st.get('used', 0) < st.get('total', 0) and not skipped:
                if not any(n == st['name'] and t == rc.get('time') for t, n in by_teacher.get(st.get('teacher', ''), [])):
                    add_item(st.get('teacher'), rc.get('time'), st['name'])
        nb = st.get('nextBooking')
        if nb and nb.get('date') == td:
            if not any(n == st['name'] for _, n in by_teacher.get(st.get('teacher', ''), [])):
                add_item(st.get('teacher'), nb.get('time'), st['name'])
    for teacher in by_teacher:
        by_teacher[teacher].sort()

    # ── 明天場租：直接查老師自己的 Google 日曆 ──
    rent_by_teacher = {}
    if cal_map:
        try:
            token = gc_access_token()
            tmin = tomorrow.replace(hour=0, minute=0, second=0, microsecond=0)
            tmax = tmin + timedelta(days=1)
            for teacher, cal_id in cal_map.items():
                if not cal_id:
                    continue
                try:
                    evs = gc_tomorrow_events(token, cal_id, tmin.isoformat(), tmax.isoformat())
                except Exception as e:
                    print(f'讀 {teacher} 日曆失敗：{e}')
                    continue
                for ev in evs:
                    if ev.get('status') == 'cancelled':
                        continue
                    parsed = parse_title(ev.get('summary') or '')
                    if not parsed or not is_rent(parsed[0]):
                        continue
                    rent_by_teacher.setdefault(teacher, []).append(event_time(ev))
        except Exception as e:
            print(f'Google Calendar 讀取失敗：{e}')

    teachers = set(by_teacher) | set(rent_by_teacher)
    if not teachers:
        print(f'{td} 沒有課表或場租，不用發老師提醒')
        return

    sent, unbound, failed = [], [], []
    for teacher in teachers:
        phone = teacher_phones.get(teacher)
        key = phone_key(phone)
        binding = bindings.get(key or '') or {}
        if not (binding.get('groupId') or binding.get('roomId') or binding.get('userId')):
            unbound.append(teacher)
            continue

        lines = [f'{teacher}老師您好，我是阿勇店長 🐾', f'明天（{td}・{wd_label}）行程提醒：', '']
        classes = by_teacher.get(teacher) or []
        if classes:
            lines.append(f'📅 課表（共{len(classes)}堂）：')
            lines += [f'　{t or "時間未定"} {n}' for t, n in classes]
        rents = rent_by_teacher.get(teacher) or []
        if rents:
            if classes:
                lines.append('')
            lines.append(f'🏠 場租（共{len(rents)}筆）：')
            lines += [f'　{t or "時間未定"}' for t in sorted(rents)]
        lines += ['', '辛苦了，明天加油！']
        message = '\n'.join(lines)

        if DRY_RUN:
            print(f'--- DRY_RUN，不會真的推播給 {teacher} ---\n{message}\n')
            sent.append(teacher + '（dry-run）')
            continue

        try:
            res = send_teacher_message(phone, message)
            if res.get('ok'):
                sent.append(teacher)
            else:
                failed.append((teacher, res.get('error') or '未知錯誤'))
        except Exception as e:
            failed.append((teacher, str(e)))

    summary = [f'📋 老師明日提醒 {tomorrow.month}/{tomorrow.day}（{wd_label}）']
    if sent:
        summary.append('✅ 已推播：' + '、'.join(sent))
    if unbound:
        summary.append('⚠️ 未綁定 LINE，未發送：' + '、'.join(unbound))
    if failed:
        summary.append('❌ 推播失敗：' + '、'.join(f'{t}（{e}）' for t, e in failed))
    send_ntfy('輕境小幫手', '\n'.join(summary), 'warning' if (unbound or failed) else 'herb')


if __name__ == '__main__':
    main()
