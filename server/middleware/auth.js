export function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  next();
}

export function requireAdmin(req, res, next) {
  if (req.session?.user?.papel !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores' });
  }
  next();
}
