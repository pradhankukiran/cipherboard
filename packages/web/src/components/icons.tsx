import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const defaults: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  width: "1.1rem",
  height: "1.1rem",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
};

export function IconPen({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

export function IconEraser({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M7 21h10" />
      <path d="m18 13-7.5 7.5a2.1 2.1 0 0 1-3 0L3.5 16a2.1 2.1 0 0 1 0-3L14 2.5a2.1 2.1 0 0 1 3 0L20 5.5" />
    </svg>
  );
}

export function IconUndo({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </svg>
  );
}

export function IconRedo({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
    </svg>
  );
}

export function IconTrash({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}

export function IconDownload({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

export function IconCopy({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <rect x="8" y="8" width="12" height="12" rx="1" />
      <path d="M4 16V4h12" />
    </svg>
  );
}

export function IconLock({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <rect x="5" y="11" width="14" height="10" rx="1" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function IconUnlock({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <rect x="5" y="11" width="14" height="10" rx="1" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </svg>
  );
}

export function IconShield({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M12 3 4 7v5c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V7l-8-4z" />
    </svg>
  );
}

export function IconUsers({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="3" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a3 3 0 0 1 0 5.74" />
    </svg>
  );
}

export function IconLive({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <circle cx="12" cy="12" r="3" />
      <path d="M5 5a10 10 0 0 0 0 14" />
      <path d="M19 5a10 10 0 0 1 0 14" />
    </svg>
  );
}

export function IconBranch({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <path d="M6 8v8" />
      <path d="M8 18h4a4 4 0 0 0 4-4V8" />
    </svg>
  );
}

export function IconCheck({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function IconChevronLeft({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function IconChevronRight({ className, ...rest }: IconProps) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} {...defaults} {...rest}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
