import { mockDataService } from '../services/mockData';
import { useMockData } from '../hooks/useMockData';
export default function MockNotice() {
  useMockData();
  return <aside className="mock-notice" aria-label="Mock data notice"><strong>Mock data · Browser only</strong><span>Changes are saved on this device. No FastAPI or calendar connection.</span>{mockDataService.getLoadNotice() && <p role="status">{mockDataService.getLoadNotice()}</p>}</aside>;
}
