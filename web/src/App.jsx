import { createContext, useContext, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api.js';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Notas from './pages/Notas.jsx';
import Configuracao from './pages/Configuracao.jsx';

export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = carregando

  useEffect(() => {
    api('/me').then((d) => setUser(d.user ?? null)).catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <div className="app-shell grid min-h-screen place-items-center">
        <div className="card px-5 py-4 text-sm font-medium text-slate-600">Carregando…</div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Notas />} />
          <Route path="/configuracao" element={<Configuracao />} />
        </Route>
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </AuthContext.Provider>
  );
}
