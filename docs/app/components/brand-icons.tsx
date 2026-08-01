import type { RemixiconComponentType } from '@remixicon/react'

/**
 * Marks that Remix Icon does not carry. Typed and propped like a Remix icon so
 * they drop into the same map and take the same `size` and `color`.
 */
export const OpenRouterIcon: RemixiconComponentType = ({
  size = '1em',
  color = 'currentColor',
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={color}
    fillRule="evenodd"
    {...props}
  >
    <path d="M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z" />
  </svg>
)
