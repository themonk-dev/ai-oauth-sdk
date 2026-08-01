import { Navigate } from 'react-router'

/**
 * The site is served from `/docs`, so the root has nothing of its own. This
 * exists so a deployment at a domain root does not answer `/` with a 404.
 */
export default function Home() {
  return <Navigate to="/docs" replace />
}
