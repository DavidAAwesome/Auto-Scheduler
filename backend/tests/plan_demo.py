"""Classroom demonstration of plan entry, end to end through the real API (no browser, no MongoDB server needed).

    cd backend && .venv/bin/python tests/plan_demo.py

It runs on an in-memory mock database with a fake sign-in, frozen at Monday 26 Oct 2026, 8 AM New York, with
availability 9 AM-noon every day. The timetable "image" uses a canned model answer (the same one the tests use),
so no OpenAI key is needed; typed text is read by the built-in parser. Apply is called without a transaction
because the mock database has none; with a replica set the HTTP Apply path is covered by test_plan_api.py.
"""
import base64
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]
os.environ.update(FIREBASE_PROJECT_ID='autoplan-test', MONGODB_URI='mongodb://unused', ALLOWED_ORIGINS='http://localhost:5173',
                  OPENAI_API_KEY='')

import mongomock  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import auth, plan_extraction  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.scheduling_service import _apply  # noqa: E402
from firebase_tokens import PUBLIC_KEY  # noqa: E402
from schedule_fixtures import NOW, TODAY, add_task, rows, setup_user  # noqa: E402
from test_plan_api import save_auto_sessions  # noqa: E402
from test_plan_extraction import PNG, timetable_extraction  # noqa: E402

auth.signing_key_for = lambda token: PUBLIC_KEY
get_settings.cache_clear()


class Patch:
    def setattr(self, obj, name, value):
        setattr(obj, name, value)


def counts(db):
    return {n: db[n].count_documents({}) for n in ('tasks', 'events', 'sessions')}


def show_preview(p):
    for row in rows(p['sessions'], 'new'):
        print('   ', *row)
    for e in p['proposedEvents']:
        print('    ', e['date'], f"{e['start'] // 60:02d}:{e['start'] % 60:02d}-{e['end'] // 60:02d}:{e['end'] % 60:02d}", 'event', e['title'])
    for r in p['removed']:
        print('    moved:', r['session']['title'], '-', r['reason'])
    for t in p['tasks']:
        if t['unallocatedMinutes']:
            print(f"    unscheduled: {t['title']} {t['unallocatedMinutes']} min -", '; '.join(r['message'] for r in t['reasons']))


def main():
    db = mongomock.MongoClient(tz_aware=True)['demo']
    with TestClient(create_app(db)) as client:
        setup_user(client, Patch())
        owner = db.users.find_one({})

        print('\n1. One message, several items (built-in parser, nothing saved yet)')
        text = 'Lab report 90 min due tomorrow high priority\nAdvisor meeting today 11-11:30am\nGym 30 min sometime today, low priority'
        print('   ' + text.replace('\n', '\n   '))
        drafts = [v['draft'] for v in client.post('/plan/interpret', json={'text': text}).json()['drafts']]
        for d in drafts:
            print(f"    draft: {d['kind']:<15} {d['title']}")
        before = counts(db)
        fit = client.post('/plan/feasibility', json={'drafts': drafts, 'horizonDays': 1}).json()
        print('   Can this fit?', fit['status'], '| saved data changed:', counts(db) != before)
        preview = client.post('/plan/preview', json={'drafts': drafts, 'horizonDays': 1, 'batchId': 'demo-1'}).json()
        show_preview(preview)
        _apply(owner, db, preview['previewId'], NOW, None)
        after = counts(db)
        print('   Applied:', after)
        _apply(owner, db, preview['previewId'], NOW, None)
        print('   Applied again (duplicate press):', counts(db), '- unchanged' if counts(db) == after else '- CHANGED')

        print('\n2. Timetable image (canned model answer): weekly classes, unclear times, no semester dates')
        plan_extraction.call_model = lambda inputs: timetable_extraction()
        os.environ['OPENAI_API_KEY'] = 'sk-demo-not-real'
        get_settings.cache_clear()
        image = {'mediaType': 'image/png', 'dataBase64': base64.b64encode(PNG).decode(), 'name': 'timetable.png'}
        views = client.post('/plan/interpret', json={'image': image}).json()['drafts']
        for v in views:
            print(f"    {v['draft']['title']}: weekly={bool(v['draft']['repeat'])}, questions:",
                  [i['question'] for i in v['issues'] if i['blocking']])
        lab = next(v['draft'] for v in views if v['draft']['title'] == 'MATH 220 Lab')
        for field, answer in [('start', 'PM'), ('repeat.startDate', 'Sep 2 to Dec 12')]:
            reply = client.post('/plan/clarify', json={'draft': lab, 'field': field, 'answer': answer}).json()
            lab = reply['draft']
            print(f'    answer {answer!r} -> ready={reply["ready"]}, {lab["start"] // 60}:{lab["start"] % 60:02d}, '
                  f'{lab["repeat"]["startDate"]} to {lab["repeat"]["until"]}')

        os.environ['OPENAI_API_KEY'] = ''  # back to the built-in parser for typed text
        get_settings.cache_clear()

        print('\n3. Urgent high-priority work when the morning is already planned with low-priority work')
        db2 = mongomock.MongoClient(tz_aware=True)['demo2']
    with TestClient(create_app(db2)) as client:
        setup_user(client, Patch())
        reading = add_task(client, 'Reading', 'Low', minutes=150, deadline='2026-10-30')
        save_auto_sessions(db2, reading['id'], [(540, 590), (600, 650), (660, 710)])
        urgent = [v['draft'] for v in client.post('/plan/interpret', json={'text': 'Problem set 100 min due today 12pm high priority'}).json()['drafts']]
        fit = client.post('/plan/feasibility', json={'drafts': urgent, 'horizonDays': 1}).json()
        print('   Can this fit?', fit['status'], '-', fit['summary'])
        for d in fit['displaced']:
            print(f"    displaced: {d['title']} ({d['priority']}), {d['movedSessions']} sessions moved, "
                  f"{d['unscheduledMinutesAfter']} min left unscheduled; the task is kept")
        show_preview(client.post('/plan/preview', json={'drafts': urgent, 'horizonDays': 1, 'batchId': 'demo-3'}).json())

        print('\n4. More work than the day can hold')
        big = [v['draft'] for v in client.post('/plan/interpret', json={'text': 'Thesis chapter 6 hours due today 12pm high priority'}).json()['drafts']]
        fit = client.post('/plan/feasibility', json={'drafts': big, 'horizonDays': 1}).json()
        print('   Can this fit?', fit['status'])
        for item in fit['items']:
            for c in item['causes']:
                print(f"    {item['title']}: {'proven' if c['proven'] else 'not proven'} {c['code']} - {c['message']}")
        print('   ', fit['searchLimits'])
    print(f'\nDone. Saved data for the planned day {TODAY} is in the mock database only.')


if __name__ == '__main__':
    main()
