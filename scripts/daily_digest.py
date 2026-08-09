# 輕境每日營運摘要 — 由 GitHub Actions 每天 08:00（台北）執行，推播到 ntfy
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import quote
from zoneinfo import ZoneInfo

LINE_WEBHOOK_BASE = 'https://line-webhook-gules.vercel.app'
NTFY_TOPIC = os.environ.get('NTFY_TOPIC', '').strip()
# 2026-08-05 資料庫規則收緊成「只有登入過的人能讀寫」後，這支排程沒有瀏覽器環境跑不了
# 匿名登入，改成跟 gc_backfill.py 同樣模式：伺服器端用 Admin SDK 代為讀寫，見
# line-webhook/api/scripts-db.js
SCRIPTS_DB_SECRET = os.environ.get('SCRIPTS_DB_SECRET', '').strip()
WD = '日一二三四五六'


def fetch(path):
    # path 例如 '/qingjing.json' → 對應 scripts-db.js 白名單裡的 'qingjing'
    key = path.strip('/').removesuffix('.json')
    url = f'{LINE_WEBHOOK_BASE}/api/scripts-db?key={quote(SCRIPTS_DB_SECRET)}&path={quote(key)}'
    with urllib.request.urlopen(url, timeout=20) as r:
        resp = json.load(r)
    if not resp.get('ok'):
        raise RuntimeError(resp.get('error') or 'fetch failed')
    return resp.get('data')


def send(title, message, tags='herb'):
    if not NTFY_TOPIC:
        print('NTFY_TOPIC 未設定（GitHub secret）')
        sys.exit(1)
    body = json.dumps({'topic': NTFY_TOPIC, 'title': title, 'message': message, 'tags': [tags]}).encode()
    req = urllib.request.Request('https://ntfy.sh', data=body, headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=20)
    print('已推播：\n' + message)


def main():
    now = datetime.now(ZoneInfo('Asia/Taipei'))
    try:
        d = fetch('/qingjing.json') or {}
        if isinstance(d, dict) and set(d.keys()) == {'error'}:
            raise RuntimeError(d['error'])
        led = fetch('/qingjing_ledger.json') or []
    except Exception as e:
        send('輕境小幫手', f'⚠️ 雲端資料讀取失敗（{e}）\n可能是 Firebase 規則又失效了，請檢查 Realtime Database → 規則。', 'warning')
        return

    S = d.get('s') or []
    SCH = d.get('sch') or {}
    T = d.get('t') or []
    lu = d.get('lastUpdated') or 0

    td = now.strftime('%Y/%m/%d')
    dow = (now.weekday() + 1) % 7  # 0=週日

    # ── 今日課表 ──
    items = []
    for teacher, slots in (SCH.get(td) or {}).items():
        for sl in slots or []:
            if not sl or sl.get('skip'):
                continue
            st = next((x for x in S if x.get('id') == sl.get('sid')), None)
            if st:
                items.append((sl.get('time') or '', st['name'], teacher))
    for st in S:
        skipped = any(sl.get('sid') == st.get('id') and sl.get('skip')
                      for slots in (SCH.get(td) or {}).values() for sl in slots or [])
        for rc in st.get('recurring') or []:
            if rc and rc.get('day') == dow and st.get('used', 0) < st.get('total', 0) and not skipped:
                if not any(i[1] == st['name'] and i[0] == rc.get('time') for i in items):
                    items.append((rc.get('time', ''), st['name'], st.get('teacher', '')))
        nb = st.get('nextBooking')
        if nb and nb.get('date') == td and not any(i[1] == st['name'] for i in items):
            items.append((nb.get('time', ''), st['name'], st.get('teacher', '')))
    for t in T:
        if t and t.get('date') == td:
            items.append((t.get('time', ''), t['name'] + '(體驗)', t.get('teacher', '')))
    items.sort()

    # ── 待辦警示 ──
    renew = [(s['name'], s['total'] - s['used']) for s in S
             if s.get('used', 0) < s.get('total', 0) and s['total'] - s['used'] <= 2]
    usedup = [s['name'] for s in S if s.get('used', 0) >= s.get('total', 0) and (s.get('recurring') or [])]
    exp = []
    for s in S:
        ed = s.get('expiryDate')
        if ed and s.get('used', 0) < s.get('total', 0):
            try:
                e = datetime.strptime(ed, '%Y/%m/%d').replace(tzinfo=ZoneInfo('Asia/Taipei'))
                if 0 <= (e - now).days <= 14:
                    exp.append((s['name'], f'{e.month}/{e.day}'))
            except ValueError:
                pass
    inst = [s['name'] for s in S
            if s.get('installment') and s.get('installEvery') and s.get('used', 0) > 0
            and s['used'] % s['installEvery'] == 0 and s['used'] < s.get('total', 0)]

    # ── 本月收入（計入所有流水帳項目：新購/續課/首頁購課/體驗課費）──
    mk = now.strftime('%Y/%m')
    inc = sum(l.get('actualPayment', 0) for l in led
              if l and (l.get('createdAt') or '')[:7] == mk)

    # ── 組訊息 ──
    lines = []
    if items:
        shown = '、'.join(f'{t} {n}({tc})' for t, n, tc in items[:8])
        more = f'…等共 {len(items)} 堂' if len(items) > 8 else ''
        lines.append(f'📅 今日 {len(items)} 堂：{shown}{more}')
    else:
        lines.append('📅 今天沒有排課 🌿')
    warn = []
    if renew:
        warn.append('續購：' + '、'.join(f'{n}(剩{r})' for n, r in renew))
    if usedup:
        warn.append('用完仍排課：' + '、'.join(usedup))
    if exp:
        warn.append('到期：' + '、'.join(f'{n}({dd})' for n, dd in exp))
    if inst:
        warn.append('分期：' + '、'.join(inst))
    if warn:
        lines.append('⚠️ ' + '／'.join(warn))
    lines.append(f'💰 本月收入 ${inc:,}')
    age_days = (now.timestamp() * 1000 - lu) / 86400000 if lu else 999
    if age_days > 3:
        lines.append(f'⚠️ 雲端資料已 {age_days:.0f} 天沒更新，記得在工作室 iPad 開 app 同步')

    send(f'🌿 輕境每日摘要 {now.month}/{now.day}（週{WD[dow]}）', '\n'.join(lines))


if __name__ == '__main__':
    main()
