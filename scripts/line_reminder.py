# 輕境上課前一天 LINE 提醒 — 由 GitHub Actions 每天 18:00（台北）執行
# 課表解析邏輯沿用 daily_digest.py，改成解析「明天」而非「今天」。
#
# 這支腳本只「準備」推播內容，寫進 Firebase 待確認清單，並用 ntfy 通知
# 店長預覽名單＋附一顆「確認送出」按鈕。實際推播是店長按下按鈕後，由
# line-webhook/api/confirm-send.js 執行——沒人看過內容前不會自動發給學員。
import json
import os
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import quote
from zoneinfo import ZoneInfo

LINE_WEBHOOK_BASE = 'https://line-webhook-gules.vercel.app'
# 2026-08-05 資料庫規則收緊成「只有登入過的人能讀寫」後，這支排程沒有瀏覽器環境跑不了
# 匿名登入，原本靠公開 apiKey 當 ?auth= 的做法本來就沒用（apiKey 不是登入權杖），改成跟
# gc_backfill.py 同樣模式：伺服器端用 Admin SDK 代為讀寫，見 line-webhook/api/scripts-db.js
SCRIPTS_DB_SECRET = os.environ.get('SCRIPTS_DB_SECRET', '').strip()
NTFY_TOPIC = os.environ.get('NTFY_TOPIC', '').strip()
CONFIRM_URL = os.environ.get('CONFIRM_URL', '').strip()
CONFIRM_SECRET = os.environ.get('CONFIRM_SECRET', '').strip()
WD = '日一二三四五六'
WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']


# path 不帶開頭斜線／.json（如 'qingjing'），要在 scripts-db.js 的白名單裡才會通過
def fetch(path):
    key = path.strip('/').removesuffix('.json')
    url = f'{LINE_WEBHOOK_BASE}/api/scripts-db?key={quote(SCRIPTS_DB_SECRET)}&path={quote(key)}'
    with urllib.request.urlopen(url, timeout=20) as r:
        resp = json.load(r)
    if not resp.get('ok'):
        raise RuntimeError(resp.get('error') or 'fetch failed')
    return resp.get('data')


def fb_put(path, data):
    key = path.strip('/').removesuffix('.json')
    body = json.dumps(data).encode()
    url = f'{LINE_WEBHOOK_BASE}/api/scripts-db?key={quote(SCRIPTS_DB_SECRET)}&path={quote(key)}'
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='PUT')
    with urllib.request.urlopen(req, timeout=20) as r:
        resp = json.load(r)
    if not resp.get('ok'):
        raise RuntimeError(resp.get('error') or 'fb_put failed')


def send_ntfy(title, message, tags='herb', action_label=None, action_url=None):
    if not NTFY_TOPIC:
        print('NTFY_TOPIC 未設定（GitHub secret），略過通知：\n' + message)
        return
    payload = {'topic': NTFY_TOPIC, 'title': title, 'message': message, 'tags': [tags]}
    if action_label and action_url:
        payload['actions'] = [{
            'action': 'http', 'label': action_label, 'url': action_url,
            'method': 'POST', 'clear': True,
        }]
    body = json.dumps(payload).encode()
    req = urllib.request.Request('https://ntfy.sh', data=body, headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=20)
    print('已通知店長：\n' + message)


# 與 index.html 的 s.phone.replace(/\D/g,'').slice(-8) 比對邏輯一致
def phone_key(phone):
    digits = ''.join(c for c in (phone or '') if c.isdigit())
    return digits[-8:] if len(digits) >= 8 else None


def main():
    now = datetime.now(ZoneInfo('Asia/Taipei'))
    tomorrow = now + timedelta(days=1)
    try:
        d = fetch('/qingjing.json') or {}
        if isinstance(d, dict) and set(d.keys()) == {'error'}:
            raise RuntimeError(d['error'])
        bindings = fetch('/qingjing_line_bindings.json') or {}
    except Exception as e:
        send_ntfy('輕境小幫手', f'⚠️ 上課提醒讀取雲端資料失敗（{e}）\n可能是 Firebase 規則又失效了，請檢查 Realtime Database → 規則。', 'warning')
        return

    S = d.get('s') or []
    SCH = d.get('sch') or {}
    T = d.get('t') or []

    td = tomorrow.strftime('%Y/%m/%d')
    dow = (tomorrow.weekday() + 1) % 7  # 0=週日

    # 共用課卡（一張學員卡多人共用，如「楊文玉｜怡潔媽｜衣彤」+ altRecipients）：
    # 依日曆解析出的 attendeeName 決定這堂課實際提醒誰、發到哪支手機。
    # 沒有 attendeeName（非日曆同步來源，如固定課/指定下堂）就用預設姓名+電話。
    def resolve_recipient(st, attendee_name):
        default_name = st['name'].split('｜')[0] if '｜' in (st.get('name') or '') else st.get('name')
        alt_list = st.get('altRecipients') or []
        if attendee_name:
            for alt in alt_list:
                if alt and alt.get('name') and (alt['name'] in attendee_name or attendee_name in alt['name']):
                    return alt['name'], alt.get('phone')
        return default_name, st.get('phone')

    # ── 明日課表（排課解析邏輯照抄 daily_digest.py，目標日期換成明天）──
    items = []
    for teacher, slots in (SCH.get(td) or {}).items():
        for sl in slots or []:
            if not sl or sl.get('skip'):
                continue
            st = next((x for x in S if x.get('id') == sl.get('sid')), None)
            if st:
                name, phone = resolve_recipient(st, sl.get('attendeeName'))
                items.append({'time': sl.get('time') or '', 'name': name, 'teacher': teacher, 'phone': phone})
    for st in S:
        skipped = any(sl.get('sid') == st.get('id') and sl.get('skip')
                      for slots in (SCH.get(td) or {}).values() for sl in slots or [])
        for rc in st.get('recurring') or []:
            if rc and rc.get('day') == dow and st.get('used', 0) < st.get('total', 0) and not skipped:
                name, phone = resolve_recipient(st, None)
                if not any(i['name'] == name and i['time'] == rc.get('time') for i in items):
                    items.append({'time': rc.get('time', ''), 'name': name, 'teacher': st.get('teacher', ''), 'phone': phone})
        nb = st.get('nextBooking')
        if nb and nb.get('date') == td:
            name, phone = resolve_recipient(st, None)
            if not any(i['name'] == name for i in items):
                items.append({'time': nb.get('time', ''), 'name': name, 'teacher': st.get('teacher', ''), 'phone': phone})
    for t in T:
        if t and t.get('date') == td:
            items.append({'time': t.get('time', ''), 'name': t['name'] + '(體驗)', 'teacher': t.get('teacher', ''), 'phone': t.get('phone')})
    items.sort(key=lambda i: i['time'])

    if not items:
        print(f'{td} 沒有排課，不用發提醒')
        return

    # ── 分成「已綁定可推播」與「未綁定需店長手動處理」──
    wd_label = f'週{WD[dow]}'
    bound, unbound = [], []
    for it in items:
        binding = bindings.get(phone_key(it['phone']) or '')
        # 一對二/一對三共用群組時，綁定記的是 groupId/roomId 不是 userId（通知要發到整個
        # 群組），LINE push 的 "to" 三種 ID 用法一樣，哪個存在就用哪個。
        to = binding and (binding.get('groupId') or binding.get('roomId') or binding.get('userId'))
        if to:
            name = it['name'].replace('(體驗)', '')
            if binding.get('lang') == 'en':
                text = (
                    f"Hi {name},\n"
                    f"Reminder: you have a class booked tomorrow!\n\n"
                    f"Date: {td} ({WD_EN[dow]})\n"
                    f"Time: {it['time'] or 'please confirm with your teacher'}\n"
                    f"Teacher: {it['teacher'] or '—'}"
                )
            else:
                text = (
                    f"{name}您好，\n"
                    f"提醒您明天有預約課程唷！\n\n"
                    f"時間：{td}（{wd_label}）{it['time'] or ''}\n"
                    f"老師：{it['teacher'] or '—'}"
                )
            bound.append({'userId': to, 'name': it['name'], 'time': it['time'], 'text': text})
        else:
            unbound.append(it)

    lines = []
    action_label = action_url = None

    if bound:
        preview = '、'.join(f"{b['time']} {b['name']}" for b in bound[:8])
        more = f'…等共 {len(bound)} 位' if len(bound) > 8 else ''
        lines.append(f'📋 明天課程提醒待確認（{len(bound)} 位）：{preview}{more}')
        lines.append('')
        lines.append('點下方「確認送出」才會真的推播給學員，沒點就不會發送。')
        try:
            fb_put('/qingjing_line_pending', {
                'date': td, 'items': bound, 'createdAt': int(now.timestamp() * 1000), 'sentAt': None,
            })
        except Exception as e:
            send_ntfy('輕境小幫手', f'⚠️ 寫入待確認清單失敗（{e}）', 'warning')
            return
        if CONFIRM_URL and CONFIRM_SECRET:
            action_label = '✅ 確認送出'
            action_url = f'{CONFIRM_URL}?key={CONFIRM_SECRET}'
        else:
            lines.append('（CONFIRM_URL／CONFIRM_SECRET 尚未設定，無法產生確認按鈕，請先手動處理）')

    if unbound:
        names = '、'.join(f"{i['time']} {i['name']}" for i in unbound)
        lines.append('')
        lines.append(f'⚠️ 以下 {len(unbound)} 位尚未綁定 LINE，請用 App 裡的「LINE 課後訊息」流程手動提醒：')
        lines.append(names)

    send_ntfy(
        f'🌿 明天課程提醒 {tomorrow.month}/{tomorrow.day}（{wd_label}）',
        '\n'.join(lines),
        'herb' if bound else 'warning',
        action_label, action_url,
    )


if __name__ == '__main__':
    main()
