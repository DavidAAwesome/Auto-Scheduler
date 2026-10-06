from datetime import datetime, timezone
import pytest
from app import plans
from firebase_tokens import sign_in, sign_out

NOW = datetime(2026,10,5,9,tzinfo=timezone.utc)
REQUEST = {'source':'provided','busyIntervals':[{'start':'2026-10-05T10:00:00Z','end':'2026-10-05T10:30:00Z'}]}
TASK = {'title':'Plan test','deadline':'2026-10-05','minutes':135,'priority':'High','category':'Project'}


def setup(client, monkeypatch):
    monkeypatch.setattr(plans,'utc_now',lambda:NOW)
    user=sign_in(client,uid='planner',email='planner@example.com',name='Planner')
    task=client.post('/tasks',json=TASK).json()
    availability=client.get('/availability').json()
    availability['days'][0]['enabled']=True
    client.put('/availability',json=availability)
    return user,task


def test_plan_persists_replaces_and_restores_after_login(environment,monkeypatch):
    client,db=environment
    user,task=setup(client,monkeypatch)
    assert client.get('/plan').json() is None
    response=client.post('/plan/generate',json=REQUEST)
    assert response.status_code == 200
    first=response.json()
    assert first['tasks'][0]['scheduledMinutes'] == 135
    assert not first['stale']
    assert first == client.post('/plan/generate',json=REQUEST).json()
    assert db.plans.count_documents({'user_id':user['id']}) == 1
    stored=db.plans.find_one({'user_id':user['id']})
    assert isinstance(stored['plan']['blocks'][0]['start'],datetime)
    assert 'user_id' not in first and 'input_fingerprint' not in first
    assert len({b['id'] for b in first['blocks']}) == len(first['blocks'])
    sign_out(client)
    assert client.get('/plan').status_code == 401
    sign_in(client,uid='planner',email='planner@example.com',name='Planner')
    assert client.get('/plan').json() == first
    assert client.get('/plan').headers['cache-control'] == 'no-store'


def test_another_account_cannot_see_or_replace_first_plan(environment,monkeypatch):
    client,db=environment
    owner,_=setup(client,monkeypatch)
    first=client.post('/plan/generate',json=REQUEST).json()
    sign_out(client)
    second=sign_in(client,uid='other',email='other@example.com',name='Other')
    assert client.get('/plan').json() is None
    assert client.post('/plan/generate',json={**REQUEST,'user_id':owner['id']}).status_code == 422
    own=client.post('/plan/generate',json=REQUEST).json()
    assert own['blocks'] == [] and own['tasks'] == []
    assert db.plans.count_documents({}) == 2
    assert db.plans.find_one({'user_id':owner['id']})['plan']['blocks']
    assert db.plans.find_one({'user_id':second['id']})['plan']['blocks'] == []
    assert first['blocks']


def test_input_changes_mark_stale_without_moving_saved_blocks(environment,monkeypatch):
    client,_=environment
    _,task=setup(client,monkeypatch)
    first=client.post('/plan/generate',json=REQUEST).json()
    client.patch('/tasks/'+task['id']+'/completion',json={'done':True})
    stale=client.get('/plan').json()
    assert stale['stale'] and stale['blocks'] == first['blocks']
    assert client.post('/plan/generate',json=REQUEST).json()['blocks'] == []
    availability=client.get('/availability').json()
    availability['days'][0]['start']=600
    client.put('/availability',json=availability)
    assert client.get('/plan').json()['stale']


def test_new_day_marks_plan_stale(environment,monkeypatch):
    client,_=environment
    setup(client,monkeypatch)
    client.post('/plan/generate',json=REQUEST)
    monkeypatch.setattr(plans,'utc_now',lambda:datetime(2026,10,6,9,tzinfo=timezone.utc))
    assert client.get('/plan').json()['stale']


@pytest.mark.parametrize('bad',[
    {}, {'source':'provided','busyIntervals':[{'start':'2026-10-05T10:00:00','end':'2026-10-05T11:00:00'}]},
    {'source':'provided','busyIntervals':[{'start':'2026-10-05T11:00:00Z','end':'2026-10-05T10:00:00Z'}]},
    {'source':'availability_only','busyIntervals':REQUEST['busyIntervals']},
    {'source':'fetch_failed','busyIntervals':[]},
])
def test_invalid_provider_input_does_not_replace_saved_plan(environment,monkeypatch,bad):
    client,db=environment
    setup(client,monkeypatch)
    first=client.post('/plan/generate',json=REQUEST).json()
    assert client.post('/plan/generate',json=bad).status_code == 422
    assert client.get('/plan').json() == first
    assert db.plans.count_documents({}) == 1


def test_plan_generation_requires_auth(environment):
    client,_=environment
    assert client.post('/plan/generate',json=REQUEST).status_code == 401
    assert client.get('/plan').status_code == 401
