import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from './utils/AppContext';
import Dashboard from './pages/Dashboard';
import Pools from './pages/Pools';
import Vault from './pages/Vault';
import Activity from './pages/Activity';
import './styles/global.css';

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter basename="/pool">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pools" element={<Pools />} />
          <Route path="/vault" element={<Vault />} />
          <Route path="/activity" element={<Activity />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
