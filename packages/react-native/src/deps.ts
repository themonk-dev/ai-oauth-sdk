/**
 * Structural types for the React Native / Expo modules this package can use.
 *
 * They are declared rather than imported so the package has no peer
 * dependencies at all: an Expo app passes `expo-web-browser`, a bare RN app
 * passes `Linking` from `react-native`, and neither has to be installed for the
 * package to typecheck or build.
 */

export interface LinkingLike {
  openURL(url: string): Promise<unknown>
  getInitialURL(): Promise<string | null>
  addEventListener(
    type: 'url',
    handler: (event: { url: string }) => void,
  ): { remove(): void }
}

export interface WebBrowserLike {
  openAuthSessionAsync(
    url: string,
    redirectUrl: string,
    options?: Record<string, unknown>,
  ): Promise<{ type: string; url?: string }>
  dismissAuthSession?(): void
}

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface SecureStoreLike {
  getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>
  setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>
  deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>
}
