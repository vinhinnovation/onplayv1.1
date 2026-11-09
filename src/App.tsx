import { Route, Routes } from 'react-router-dom';
import { Home } from './pages/Home';
import { Join } from './pages/Join';
import { Play } from './pages/Play';
import { HostLogin } from './pages/HostLogin';
import { HostDashboard } from './pages/HostDashboard';
import { QuizEditor } from './pages/QuizEditor';
import { HostGame } from './pages/HostGame';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/join" element={<Join />} />
      <Route path="/join/:pin" element={<Join />} />
      <Route path="/play" element={<Play />} />
      <Route path="/host/login" element={<HostLogin />} />
      <Route path="/host" element={<HostDashboard />} />
      <Route path="/host/quiz/:id" element={<QuizEditor />} />
      <Route path="/host/game/:id" element={<HostGame />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
