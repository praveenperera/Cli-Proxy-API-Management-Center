// Icons only this fork uses, kept apart so the upstream icon set stays untouched
import type { SVGProps } from 'react';
import type { IconProps } from './icons';

// same as the private baseSvgProps in icons.tsx, which stays unexported so that file keeps
// exporting only components
const baseSvgProps: SVGProps<SVGSVGElement> = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
};

export function IconChevronRight({ size = 20, ...props }: IconProps) {
  return (
    <svg {...baseSvgProps} width={size} height={size} {...props}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
