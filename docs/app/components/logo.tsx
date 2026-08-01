export type LogoProps = React.SVGAttributes<SVGElement>

/**
 * A keyhole inside a rounded square. Drawn in `currentColor` so it inherits
 * whatever the nav or the footer is using, in either theme.
 */
export const Logo = (props: LogoProps) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <rect
      x="1.5"
      y="1.5"
      width="29"
      height="29"
      rx="8.5"
      stroke="currentColor"
      strokeWidth="2.4"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M16 7.6a4.9 4.9 0 0 0-2.53 9.09l-1.6 6.06a.9.9 0 0 0 .87 1.13h6.52a.9.9 0 0 0 .87-1.13l-1.6-6.06A4.9 4.9 0 0 0 16 7.6Zm0 3.1a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Z"
      fill="currentColor"
    />
  </svg>
)
