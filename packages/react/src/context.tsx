import { createContext, createElement, useContext, type ReactNode } from 'react'

import { useAuth, type UseAuthOptions, type UseAuthResult } from './useAuth.js'

const AuthContext = createContext<UseAuthResult | undefined>(undefined)

export interface AuthProviderProps extends UseAuthOptions {
  children: ReactNode
}

/**
 * Shares one auth client across a tree, so several components can read the same
 * session without each creating its own client (and its own token cache).
 */
export function AuthProvider({ children, ...options }: AuthProviderProps) {
  const value = useAuth(options)
  return createElement(AuthContext.Provider, { value }, children)
}

/** Reads the nearest {@link AuthProvider}. Throws when there isn't one. */
export function useAuthContext(): UseAuthResult {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuthContext must be used inside an <AuthProvider>.')
  }
  return value
}
