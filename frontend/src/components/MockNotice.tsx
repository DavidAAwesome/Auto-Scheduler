import { mockDataService } from '../services/mockData';
import { useMockData } from '../hooks/useMockData';
export default function MockNotice() {
  useMockData();
  return <aside className="mock-notice" aria-label="Mock data notice"><strong>Task demo · Browser only</strong><span>Tasks and schedules are saved on this device for your account. Calendar sync is not connected.</span>{mockDataService.getLoadNotice() && <p role="status">{mockDataService.getLoadNotice()}</p>}</aside>;
}
