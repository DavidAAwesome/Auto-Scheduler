import pytest
from firebase_tokens import make_token, sign_in, sign_out

TASK = {'title': 'Prepare Sprint 1', 'deadline': '2026-10-09', 'minutes': 90, 'priority': 'High', 'category': 'Project'}


def register(client, email='workspace@example.com'):
    return sign_in(client, uid=email, email=email, name='Workspace Test')


def test_task_crud_persistence_and_completion(environment):
    client, db = environment
    user = register(client)
    assert client.get('/tasks').json() == []
    result = client.post('/tasks', json={**TASK, 'title': ' Prepare Sprint 1 '})
    assert result.status_code == 201
    task = result.json()
    assert task['title'] == TASK['title'] and not task['done']
    path = '/tasks/' + task['id']
    assert 'user_id' not in task
    stored = db.tasks.find_one({'user_id': user['id']})
    assert stored['title'] == TASK['title']
    assert str(stored['_id']) == task['id']
    assert client.put(path, json={**TASK, 'title': 'Edited', 'deadline': '2026-10-10'}).status_code == 200
    assert client.patch(path+'/completion', json={'done': True}).json()['done'] is True
    assert client.put(path, json=TASK).json()['done'] is True  # Editing must preserve completion.
    sign_out(client)
    assert register(client) == user
    assert client.get('/tasks').json()[0]['done'] is True
    assert client.patch(path+'/completion', json={'done':False}).json()['done'] is False
    assert client.delete(path).status_code == 204
    assert db.tasks.count_documents({}) == 0
    assert client.get('/tasks').json() == []
    assert client.get(path).status_code == 404
    assert client.delete(path).status_code == 404


def test_another_account_cannot_access_or_mutate_data(environment):
    client, db = environment
    first = register(client)
    task = client.post('/tasks', json=TASK).json()
    availability = client.get('/availability').json()
    availability['days'][0].update(enabled=True, start=600, end=720)
    availability['timeZone'] = 'America/New_York'
    availability['reminders'] = True
    assert client.put('/availability', json=availability).status_code == 200
    first_token = make_token(uid=first['email'], email=first['email'])
    sign_out(client)
    second = register(client, 'second@example.com')
    assert client.get('/tasks').json() == []
    assert all(not day['enabled'] for day in client.get('/availability').json()['days'])
    path = '/tasks/'+task['id']
    assert client.get(path).status_code == 404
    assert client.put(path, json=TASK).status_code == 404
    assert client.patch(path+'/completion', json={'done':True}).status_code == 404
    assert client.delete(path).status_code == 404
    assert client.post('/tasks', json={**TASK, 'user_id':first['id']}).status_code == 422
    assert client.put('/availability', json={**availability, 'user_id':first['id']}).status_code == 422
    assert client.put('/availability', json={**availability,'timeZone':'UTC'}).status_code == 200
    assert db.availability.count_documents({}) == 2
    assert db.tasks.count_documents({'user_id':second['id']}) == 0
    headers = {'Authorization':'Bearer '+first_token}
    assert client.get('/tasks', headers=headers).json() == [task]
    assert client.get('/availability', headers=headers).json() == availability


def test_availability_saves_all_weekdays_and_reloads(environment):
    client, db = environment
    user = register(client)
    data = client.get('/availability').json()
    data['days'][1].update(enabled=True, start=480, end=630)
    data['days'][6].update(enabled=True, start=900, end=1080)
    data['timeZone'] = 'America/Los_Angeles'
    data['reminders'] = True
    assert client.put('/availability', json=data).json() == data
    assert client.put('/availability', json=data).status_code == 200
    assert db.availability.count_documents({'user_id':user['id']}) == 1
    assert db.availability.find_one({'user_id':user['id']})['days'] == data['days']
    sign_out(client)
    register(client)
    assert client.get('/availability').json() == data
    assert client.get('/availability').headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('method,path,data', [
    ('get','/tasks',None), ('post','/tasks',TASK), ('get','/tasks/012345678901234567890123',None),
    ('put','/tasks/012345678901234567890123',TASK), ('patch','/tasks/012345678901234567890123/completion',{'done':True}),
    ('delete','/tasks/012345678901234567890123',None), ('get','/availability',None),
    ('put','/availability',{'days':[], 'timeZone':'UTC', 'reminders':False}),
])
def test_workspace_routes_require_auth(environment, method, path, data):
    client, _ = environment
    assert client.request(method,path,json=data).status_code == 401


@pytest.mark.parametrize('patch', [{'title':' '},{'deadline':'2026-02-30'},{'minutes':17},{'minutes':True},{'priority':'Urgent'},{'category':'Other'}])
def test_invalid_task_is_not_saved(environment, patch):
    client, db = environment
    register(client)
    assert client.post('/tasks',json={**TASK,**patch}).status_code == 422
    assert db.tasks.count_documents({}) == 0


@pytest.mark.parametrize('case', ['reversed','duplicate','missing','timezone','boolean'])
def test_invalid_availability_keeps_previous_save(environment, case):
    client, _ = environment
    register(client)
    original = client.get('/availability').json()
    assert client.put('/availability',json=original).status_code == 200
    data = client.get('/availability').json()
    if case == 'reversed': data['days'][0]['end'] = data['days'][0]['start']
    if case == 'duplicate': data['days'][1]['day'] = 0
    if case == 'missing': data['days'].pop()
    if case == 'timezone': data['timeZone'] = 'Not/AZone'
    if case == 'boolean': data['reminders'] = 'true'
    assert client.put('/availability',json=data).status_code == 422
    assert client.get('/availability').json() == original
